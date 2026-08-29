# Handoff — continuar con v2

Estado al 2026-08-29: **v1 terminada. v2 en curso: indexado incremental,
indexado automático y medición de la búsqueda hechos. Embeddings en `bge-m3`.**

Antes de tocar nada: leé `CLAUDE.md` (stack, estructura, convenciones) y
`ROADMAP.md` (qué está hecho y qué falta).

---

## Dónde está el proyecto

- 9 tools, todas de solo lectura salvo `refresh_index` (que solo escribe el
  índice local, nunca GitHub).
- Indexado multi-rama: `main` + `dev` por convención, más ramas con actividad en
  los últimos 30 días (`activeBranchDays`), tope de 5 (`maxActiveBranches`).
- Búsqueda híbrida: coseno + BM25 (FTS5) fusionados con Reciprocal Rank Fusion.
- Embeddings con `bge-m3` (multilingüe). Medido: es lo que hace que la híbrida
  le gane a BM25 solo; con `nomic-embed-text` no lo hacía.
- Caché de embeddings por `(model, content_hash)`: un texto ya embebido no se
  vuelve a embeber. Un refresh sin cambios no llama a Ollama ni una vez.
- Auto-index al arrancar (`REPO_RAG_AUTO_INDEX_HOURS`, default 12, `0` apaga),
  en segundo plano y sin bloquear el handshake.
- 83 tests verdes, typecheck y build limpios.
- Índice real: 3 repos de `example-org`, 15 ramas.

Comprobar que sigue todo bien:

```bash
pnpm test && pnpm typecheck && pnpm typecheck:test && pnpm build
```

---

## Lo próximo, en orden

### 1. Esperar preguntas reales de uso — NO es una tarea a ejecutar

La medición de la búsqueda corrió sobre n=6 y alcanzó para decidir el cambio a
`bge-m3`, pero la diferencia de hit@5 contra BM25 solo es **una sola pregunta**.
Hacen falta 20-30 preguntas reales para saber si conviene reranking o si el
límite es el chunking.

**Esas preguntas llegan del uso, no de una sesión de trabajo.** El servidor lo
va a usar el jefe del equipo — alguien que no lo construyó, que es exactamente
el usuario que importa. No hay nada que "hacer" acá hasta que eso pase.

Cuando pase, lo que hay que hacer es esto:

1. Guardar la conversación en `docs/` con el mismo formato que
   `docs/evaluacion-respuestas-conversacion.md`: pregunta textual, respuesta
   entregada, evidencia consultada.
2. Anotar, por cada pregunta, **qué documento habría sido la respuesta
   correcta**. Sin eso no hay ground truth y no hay medición.
3. Correr el harness (ver `CLAUDE.md`, sección de medición) y comparar contra
   los números de esta ronda: semántico solo hit@5 4/6, BM25 solo 3/6, híbrida
   4/6.

Dos fallos ya identificados, para no perderlos:

- *"cómo se correlacionan las tareas del gestor de tareas con Trámites"* — no es
  recuperación, es razonamiento cruzando dos sistemas. Ningún modelo de
  embeddings la resuelve: es la integración con el MCP de tareas (v3).
- *"trámites con fecha incorrecta en LEGACY"* — sí es de recuperación y
  falla. Única consulta donde `bge-m3` empeoró contra `nomic` (puesto 41 -> 78).

**NO inventes las preguntas leyendo el corpus.** Ya pasó en esta sesión: un set
redactado así llevó a recomendar bajar `RRF_K`, y las preguntas reales lo
refutaron. Un set escrito mirando los documentos usa su mismo vocabulario y
favorece a BM25, así que mide el parafraseo del que lo escribió, no la búsqueda.

**Qué mirar además de los aciertos.** El jefe es el primer usuario que no
construyó esto. Vale la pena observar si se choca con que el índice es una foto
y no un espejo — es la confusión que motivó el indexado automático. Si igual se
la choca, el auto-index no alcanzó y hay que revisar la ventana de 12 horas.

### 2. Deduplicar por archivo

Hoy se deduplica por chunk entre ramas, pero un mismo documento todavía puede
ocupar varios lugares del top-k con fragmentos distintos. La medición lo mostró:
en una consulta el documento correcto ocupaba los puestos 1 y 2 con dos
fragmentos, gastando la mitad del top-5 disponible.

### 3. Saltear la descarga de archivos — MEDIDO, no vale la pena

Estaba anotado como "medir antes de decidir". Ya se midió, con `bge-m3` y el
caché de embeddings andando:

| | tiempo |
|---|---|
| reindex en frío (767 chunks a embeber) | ~7 min |
| **refresh en caliente (0 embeddings)** | **55 s** |

Esos 55 segundos son todo lo que queda: descargas de GitHub, troceo y escritura
en SQLite. El caché absorbe el ~87% del costo de un refresh.

Saltear descargas con el `sha` de `listTree` atacaría una parte de esos 55
segundos, en un proceso que corre en segundo plano al arrancar y no bloquea
nada. **No justifica la complejidad.** Queda descartado salvo que el corpus
crezca mucho y alguien lo vuelva a medir.

### 4. Comentarios de PRs

Traer la discusión de un PR abierto cuando se pida explícitamente. Sigue siendo
lectura. Y filtro por fecha en `get_recent_commits` (`since` / `until`).

### Lo que NO tiene este server, y conviene saber

No hay ninguna capacidad de **comparar ramas** (`main...dev`): no existe
`compareCommits` en el cliente ni una tool que lo exponga. Si una respuesta
afirma "dev está N commits adelante" y cita este MCP como evidencia, esa
evidencia no salió de acá.

---

## Cosas que ya se decidieron — no volver a discutirlas

- **Nada de `sqlite-vec`.** Necesita compilación nativa en Windows y el volumen
  no lo justifica. Está en `CLAUDE.md` el porqué.
- **El caché de embeddings se keyea por `(model, content_hash)`, no por `sha` de
  blob.** El hash es del TEXTO del chunk: granularidad de chunk en vez de
  archivo, autovalidante, sin tabla de archivos por rama. Y el `model` en la
  clave no es opcional — `nomic-embed-text` y `bge-m3` comparten cantidad de
  dimensiones, así que sin él se serviría el vector de un modelo como el de otro
  sin un solo error visible.
- **`RRF_K` se queda en 60.** Tres barridos independientes: entre K=0 y K=60 las
  tasas de acierto no se mueven. Un set de preguntas redactado leyendo el corpus
  sugería bajarlo y las preguntas reales lo refutaron.
- **El set de evaluación no se inventa.** Escribir las preguntas mirando los
  documentos usa su mismo vocabulario, favorece a BM25 y produce conclusiones
  que no se reproducen con uso real.
- **RRF fusiona rangos, no scores.** Un coseno y un BM25 están en escalas
  incomparables; normalizarlos exige recalibrar para siempre.
- **No hay umbral de relevancia.** Se sacó `MIN_SCORE` a propósito: con rangos
  fusionados no significa nada. El corte lo hace `limit`.
- **`**` no es el patrón por defecto.** Se probó: arrastra plantillas de issues y
  docs de dependencias, multiplicado por la cantidad de ramas.
- **El server es de solo lectura.** No es configuración: no existe ninguna
  función que escriba en GitHub, y así tiene que seguir.

---

## Trampas conocidas

- `stdout` es el canal MCP. Todo log va a `stderr`. Un `console.log` suelto en el
  server rompe el protocolo.
- Los `Buffer` de SQLite no garantizan alineación a 4 bytes: usar `readFloatLE`,
  nunca una vista `Float32Array`.
- Para probar contra GitHub y Ollama de verdad hace falta el `.env` con
  `GITHUB_TOKEN` y Ollama corriendo. Los tests **no** necesitan ninguna de las
  dos: usan mock y un proveedor de embeddings falso determinístico.
- Al matar un reindex largo, matar el PID puntual. Un `taskkill /IM node.exe` se
  lleva puestos los servidores MCP de la sesión.
