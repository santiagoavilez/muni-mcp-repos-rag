# Roadmap

## v1 — actual

Alcance cerrado: solo lectura, indexado on-demand multi-rama, configuración
estática.

### Tools

| Tool | Qué hace | Fuente |
|---|---|---|
| `list_projects` | Lista los repos configurados con descripción, última actividad y estado del índice | Vivo |
| `get_project_status` | Branch, último commit, PRs e issues abiertos | Vivo |
| `get_recent_commits` | Últimos N commits crudos (default 10) | Vivo |
| `search_project_docs` | Búsqueda **híbrida** (significado + palabra exacta) sobre la documentación indexada, filtrable por rama | Índice |
| `refresh_index` | Reindexa uno o todos los repos, en todas sus ramas | Escribe índice local |
| `get_project_summary` | Estado + comienzo del README en una sola llamada | Vivo |
| `get_file_content` | Un archivo completo, sin fragmentar, de cualquier rama | Vivo |
| `list_branches` | Ramas del repo con última actividad y si están indexadas | Vivo |

En v2 se agregó una novena tool, `compare_status`. Ver más abajo.

### Decisiones tomadas

- Vector store en SQLite plano con coseno en JS, sin `sqlite-vec` (evita
  compilación nativa en Windows; el volumen no lo justifica).
- Embeddings locales con Ollama, sin SDK: `POST /api/embed` con fallback
  automático a `/api/embeddings` para versiones viejas.
- `repos.json` versionado para la configuración; `.env` solo para el token.
- Un repo que falla no aborta el resto, y una rama que falla no aborta las otras
  ramas del mismo repo: el error se reporta en el nivel donde ocurrió.
- Indexado multi-rama por convención (`main` producción, `dev` réplica) más una
  ventana opcional de ramas con actividad reciente, porque la documentación del
  trabajo en curso no llega a `main`.
- Contenido idéntico en varias ramas se colapsa en un solo resultado que lista
  todas sus ramas; si no, un repo con seis ramas activas llena el top-k con
  copias del mismo fragmento.
- El índice es caché derivada: un cambio de esquema lo descarta y pide reindexar,
  en vez de arrastrar una migración frágil.
- **Búsqueda híbrida** — FTS5/BM25 de SQLite fusionado con el coseno vía
  Reciprocal Rank Fusion. Se eligió RRF porque una similitud coseno y un score
  BM25 están en escalas incomparables: cualquier intento de normalizarlos a un
  número necesita recalibración permanente, y los rangos no necesitan ninguna.
  Motivo medido en su momento: un documento indexado no aparecía ni con una
  consulta casi textual, porque todos los scores caían entre 0.72 y 0.76.
  **Superado**: con el corpus actual los cosenos van de 0.30 a 0.83. Lo que hoy
  justifica la híbrida es la medición sobre preguntas reales, no ese rango.
- El índice FTS se reconstruye entero en cada escritura en vez de mantenerse
  incrementalmente: una tabla FTS5 de contenido externo necesita los valores
  originales para borrar una fila, y a esta escala el rebuild cuesta
  milisegundos y no puede desincronizarse.
- Se eliminó `MIN_SCORE`: con rangos fusionados el umbral sobre coseno dejó de
  tener sentido. El recorte lo hace `limit`.

### Fuera de alcance de v1

- Cualquier tool de escritura (crear issues, comentar, aprobar PRs).
- Indexado en tiempo real o watch de cambios.
- Multiusuario o auth más allá del PAT local.

---

## v2 — en curso

### Hecho

- **Indexado incremental** — caché de embeddings en SQLite, con clave
  `(model, content_hash)` donde el hash es sha256 del TEXTO del chunk. Un texto
  ya embebido no se vuelve a embeber nunca.

  Se descartó cachear por `sha` del blob de git (que era la idea original): el
  hash de contenido tiene granularidad de chunk en vez de archivo, no necesita
  una tabla de archivos por rama ni copiar filas, y es autovalidante — el mismo
  texto da siempre el mismo vector, así que no hay nada que invalidar y un
  cambio de chunker se invalida solo.

  El `model` va en la clave primaria, y ahí está toda la corrección de la tabla:
  dos modelos pueden coincidir en cantidad de dimensiones (`nomic-embed-text` y
  `bge-m3` coinciden), así que el guard por `dimensions` dejaría servir el vector
  de un modelo como el de otro sin un solo error. El índice se vería sano y cada
  búsqueda estaría mal en silencio.

  Medido sobre el índice real: un refresh completo embebía 2790 chunks de los
  cuales solo 767 son textos distintos — 72.5% del trabajo era redundante DENTRO
  de una sola corrida, porque `main`, `dev` y las feature branches comparten casi
  todos los archivos. Un refresh sin cambios pasa de 2790 embeddings a 0.

  No hay política de expiración: la cantidad de filas está acotada por el texto
  distinto de unos pocos markdown, y expirar tiraría justo las entradas más
  probables de volver a hacer falta, las de una rama que reaparece.

  Sigue bajando todos los archivos de GitHub. Lo que desaparece son los minutos
  de Ollama. Saltear la descarga con el `sha` que ya devuelve `listTree` es una
  optimización distinta, y solo vale la pena si al medir de nuevo la red resulta
  ser el cuello.

- **Medido y descartado**: la sospecha de que `rebuildKeywordIndex` (rebuild
  completo del FTS en cada escritura de rama) se volvería caro con indexado
  incremental. 15 rebuilds completos sobre el índice real suman 504 ms contra un
  reindex que tarda minutos. Se queda como está: su garantía de no poder
  desincronizarse vale más que medio segundo.

- **Indexado automático** — al arrancar, el server reindexa en segundo plano
  todo repo cuyo índice esté vencido. Ventana en `REPO_RAG_AUTO_INDEX_HOURS`
  (default 12, `0` desactiva).

  "Vencido" se decide **por repo**, no globalmente, y un repo sin ninguna
  corrida registrada cuenta como vencido. Ese es el caso que más importa:
  cubre un repo recién agregado a `repos.json` y un índice descartado por un
  bump de `SCHEMA_VERSION`, que son las dos formas silenciosas de quedarse sin
  documentación indexada. La decisión vive en una función pura
  (`src/rag/staleness.ts`) sin base ni reloj adentro, así cada regla se testea
  con tres literales.

  Se dispara después de `server.connect(transport)` y **sin `await`**: el
  handshake MCP no puede esperar a GitHub ni a Ollama, y las tools siguen
  contestando con el índice viejo mientras corre. Nunca tira hacia afuera —
  un server que contesta con un índice vencido es muchísimo mejor que uno que
  no arranca.

  Los repos se refrescan en secuencia, nunca con `Promise.all`: paralelizar
  multiplicaría la presión sobre el rate limit de GitHub y sobre Ollama justo
  cuando el agente empieza a preguntar, y no gana nada porque esto ya corre en
  segundo plano.

- **Single-flight en `Indexer`** — como máximo un refresh a la vez. Un segundo
  pedido del mismo scope recibe la MISMA promesa en vez de arrancar una corrida
  duplicada, así que igual obtiene un reporte real. El guard vive en el
  `Indexer` y no en el scheduler a propósito: el scheduler, la tool
  `refresh_index` y `pnpm reindex` entran todos por el mismo método, así que un
  guard puesto en cualquiera de ellos lo esquivan los otros dos.

  La entrada en vuelo se limpia en `finally`. Si se limpiara solo en el camino
  feliz, una corrida fallida dejaría una promesa rechazada estacionada bajo ese
  scope y se la entregaría a todos los que pidan después — o sea, un fallo
  desactivaría el refresh de ese repo para siempre.

- **Medida la búsqueda híbrida** — sobre seis preguntas reales de uso
  (`docs/evaluacion-respuestas-conversacion.md`) contra el corpus real. Ver la
  tabla completa en `CLAUDE.md`. Lo esencial: con `nomic-embed-text` la híbrida
  era **peor que BM25 solo**, así que la mitad semántica no aportaba nada.

- **Cambio de modelo de embeddings a `bge-m3`** — multilingüe, y esa era la
  falla: consultas en español contra un corpus mezclado español/inglés con un
  modelo centrado en inglés. Semántico solo pasó de hit@5 2/6 a 4/6, y la
  pregunta real sobre BILLING del puesto 146 al 3. Recién con este modelo la
  híbrida le gana a BM25 solo, o sea que la fusión por fin justifica su
  complejidad. Cuesta 2.3x más por chunk (reindex en frío de ~3 a ~7 min); los
  refresh en caliente no lo notan porque el caché los absorbe.

- **`RRF_K` se queda en 60.** Tres barridos independientes coinciden en que
  entre K=0 y K=60 las tasas de acierto no se mueven. Un set de preguntas que
  yo mismo redacté sugería bajarlo; las preguntas reales lo refutaron. Es el
  motivo por el que el set de evaluación no se inventa leyendo el corpus.

- **`compare_status(repos[])`** — estado en vivo de varios repos en una llamada,
  ordenado por actividad más reciente. Tres decisiones que no son obvias:

  **Concurrencia acotada a 4 repos en vuelo, no `Promise.all`.**
  `getProjectStatus` ya dispara 4 llamadas internas por repo, así que N repos
  sin límite son 4N pedidos simultáneos. Los límites secundarios de GitHub se
  disparan por concurrencia, no por volumen total: con 3 repos no pasa nada y
  con 15 aparece un bloqueo de golpe.

  **Devuelve hechos, no interpretaciones.** Expone
  `days_since_default_branch_commit`, `days_since_any_activity` y la brecha
  entre ambos, que es aritmética. No hay un booleano tipo `is_stale`: un
  booleano esconde un umbral que alguien eligió y le saca al agente la
  posibilidad de calibrar.

  **La brecha es la señal útil.** Es trabajo que vive en ramas y no llegó a la
  rama por defecto. Medido contra los repos reales el día que se implementó:
  `project-c` daba 37 días desde el último commit en `main` contra 2 días
  desde el último push — 35 días de brecha. Ese mismo hallazgo, en la
  conversación que motivó la tool, hubo que razonarlo a mano.

  Incluye `checked_at`: un "hace 3 días" sin marca temporal es indistinguible
  de una lectura vieja.

### Pendiente

- **Comentarios de PRs** — traer la discusión de un PR abierto cuando se pida
  explícitamente. Sigue siendo lectura.
- **Filtro por fecha en `get_recent_commits`** (`since` / `until`).
- **Deduplicar por archivo, no solo por chunk** — hoy un mismo documento puede
  ocupar varios lugares del top-k con fragmentos distintos.

---

## v3 — ideas abiertas

- **Extender el RAG más allá de los repos de la organización** — documentación de
  proveedores, normativa, manuales internos.
- **Integración con el MCP de tareas** — cruzar estado de tareas con estado de
  repos: "esta tarea dice en revisión pero el PR está sin abrir hace dos semanas".
- **Reranking** — segunda pasada sobre los chunks recuperados con un modelo más
  chico, para mejorar precisión cuando el corpus crezca.
- **Migrar a `sqlite-vec`** si el corpus crece al punto de que el brute force
  moleste. Hoy no molesta.
