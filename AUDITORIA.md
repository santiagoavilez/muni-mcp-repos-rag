# Auditoría técnica — repo-rag-mcp

Auditoría completa del servidor previa a su presentación, cubriendo las siete
categorías del encargo: (A) loops/reintentos/gasto externo, (B) bugs y manejo
de errores, (C) seguridad, (D) mantenibilidad, (E) escalabilidad, (F) calidad
RAG y (G) interfaz MCP. Cuatro revisiones independientes en paralelo, con cada
hallazgo severo verificado después contra el código real. Línea base al
momento de auditar: 83 tests en verde, `typecheck` y `typecheck:test` limpios.

Los hallazgos marcados **[CORREGIDO]** fueron arreglados en esta misma pasada;
el detalle está al final del documento.

---

## 1. Resumen ejecutivo

- **No hay hallazgos Críticos.** No existen loops infinitos, reintentos ciegos
  ni caminos que multipliquen el gasto sin techo de configuración; el token
  nunca puede filtrarse por el código propio; las 9 tools están guardeadas y
  ninguna llamada a GitHub escribe.
- **Alto — el gasto de cuota GitHub no tiene freno cuando empieza a fallar.**
  `listBranches` disparaba hasta ~100 `getCommit` concurrentes por llamada
  (A1), y un rate limit a mitad de un refresh no abortaba la corrida: el
  indexador seguía emitiendo cientos de requests condenados a 403 (A2). Ambos
  **[CORREGIDO]**.
- **Alto — un cambio de modelo de embeddings con igual dimensión servía
  resultados silenciosamente incorrectos** (F1): la tabla `chunks` solo guarda
  `dimensions`, y ni la staleness ni la búsqueda comparaban el modelo. Es
  exactamente el modo de fallo que el propio proyecto declaró inaceptable — y
  resolvió — para `embedding_cache`. **[CORREGIDO]** con guard en búsqueda y
  en staleness.
- **Alto — `octokitClient` tenía cobertura de tests cero** (D2), incluida
  `translateGitHubError`, la capa que produce los mensajes de los que depende
  la autocorrección del agente. **[CORREGIDO]** con tests unitarios.
- Fortalezas confirmadas por las cuatro revisiones (para no perderlas en la
  tabla de problemas): separación de capas fiel a lo documentado, traducción
  de errores centralizada y accionable, allowlist de repos infranqueable
  desde las tools, SQL 100% preparado con triple defensa en FTS5, caché de
  embeddings correcto y testeado, y descripciones de tools que dicen cuándo
  NO usarlas — de lo mejor del proyecto.

---

## 2. Tabla de hallazgos

### Críticos

Sin hallazgos.

### Altos

| ID | Cat. | Descripción | Archivo/línea | Fix |
|---|---|---|---|---|
| A1 | A | `listBranches` datea cada rama con un `getCommit` dentro de `Promise.all` sin límite: hasta ~100 requests concurrentes por llamada. El comentario "only ever called during a refresh" es falso — la tool `list_branches` entra por acá en cada invocación. `compare_status` documenta que los límites secundarios de GitHub disparan por concurrencia y limita a 4 en vuelo; este método ignoraba esa misma lección. | `src/github/octokitClient.ts:185-208` | **[CORREGIDO]** `mapWithLimit` extraído a `src/core/concurrency.ts` y aplicado con límite 4 (también en `list_projects`). |
| A2 | A | Un `RateLimitError` a mitad del indexado recibía el mismo trato que un archivo faltante: se anota en `skipped` y se continúa con el próximo archivo, rama y repo. Agotar la cuota en el repo 3 de 20 significaba cientos de requests posteriores fallando 403 uno a uno, cada uno contando contra abuse detection. "Fallo parcial > fallo total" es correcto para un repo caído; un rate limit es un fallo global, no local. | `src/rag/indexer.ts:262-268`, `:138-155` | **[CORREGIDO]** `RateLimitError` aborta la corrida; los repos restantes se reportan como omitidos con el `resetAt`. |
| E1 | E | El costo GitHub de un refresh lo domina datar todas las ramas *existentes*, no las indexadas: ≈ `2 + B_existentes + B_indexadas × (1 + F)` requests por repo. Escenario 20 repos / ~50 ramas / 7 indexadas / 10 docs ≈ 2.600 requests por corrida — más de la mitad de la cuota horaria, y la mitad solo sirve para elegir ≤ 5 ramas activas. Ollama en cambio escala bien (caché por contenido, lotes de 16). | `src/github/octokitClient.ts:173-208` + `src/rag/indexer.ts:209-240` | Mitigado por A1 (concurrencia acotada) y A2 (el rate limit corta). La reducción real del conteo — datar solo ramas no configuradas, o una consulta GraphQL única con `committedDate` por ref — queda para v2 (ver §5). |
| F1 | F | Cadena de guardas modelo/dimensión incompleta: `chunks` guarda `dimensions` pero no el modelo; la búsqueda solo hacía `raw.dimensions !== query.length`; `stats()` ni seleccionaba `model` de `index_runs` y `selectStaleRepos` no lo comparaba. Cambiar `REPO_RAG_EMBED_MODEL` a otro modelo de igual dimensión (nomic ↔ bge-m3, 1024) cruzaba el embedding de la query nueva contra vectores viejos sin un solo error, y el auto-index consideraba el repo "fresco". | `src/rag/store.ts:117-129`, `:385`, `:500-506`; `src/rag/staleness.ts:20-25` | **[CORREGIDO]** `model` expuesto en `IndexStats`; `selectStaleRepos` trata el modelo distinto como vencido (el auto-index se autorepara); `search_project_docs` falla con mensaje accionable si el índice del scope fue construido con otro modelo. |
| D2 | D | Cobertura de tests cero sobre `octokitClient`: toda la suite usa `MockGitHubClient`. Sin probar quedaban `translateGitHubError` (401/403 rate-limit vs permiso/404/409/429, parseo de headers `x-ratelimit-*`), `normalizePath` (rechazo de `..`), detección de binarios y límite de tamaño. Es la capa que produce los mensajes de los que depende la autocorrección del agente. | `src/github/octokitClient.ts:276-325`, `:259-268` | **[CORREGIDO]** funciones puras exportadas y testeadas en `test/octokitClient.test.ts`. |

### Medios

| ID | Cat. | Descripción | Archivo/línea | Fix sugerido |
|---|---|---|---|---|
| A3 | A/B | El single-flight del indexador keyea por la referencia cruda, no por el repo resuelto: `refresh("turnos")`, `refresh("sistema-turnos")` y `refresh("example-org/sistema-turnos")` son scopes distintos para el mismo repo — no se deduplican, se encolan y las corridas se ejecutan todas (serializadas, sin corrupción, pero gastando GitHub/Ollama completo cada una). Un agente LLM alterna esas formas con naturalidad. | `src/rag/indexer.ts:108-122` | Resolver la referencia a `fullName` antes de armar la clave (manteniendo la resolución dentro del camino guardeado: puede lanzar `ValidationError`). |
| A4 | A | Llamadas *secuenciales* repetidas a `refresh_index` ejecutan cada vez la corrida completa aunque el índice tenga 30 segundos: el single-flight solo cubre concurrencia. El caché de embeddings amortigua Ollama; GitHub paga precio completo. | `src/tools/refreshIndex.ts:31-33` | Cortocircuito de frescura en `Indexer.refresh` (si la última corrida del scope tiene < N minutos, devolver "already fresh"); `selectStaleRepos` ya contiene la lógica. |
| E2 | E | `search()` materializa la tabla `chunks` entera (contenido + blob) en memoria por consulta cuando no hay scope — el caso usual del agente. Hoy ~2.800 filas ≈ 14 MB y pocos ms (correcto tal como documenta el código); a 20 repos × ~7 ramas ≈ 20k filas serían ~100 MB y decenas-cientos de ms por búsqueda. | `src/rag/store.ts:369-374` | `stmt.iterate()` acumulando solo top-k + grupos, o guardar el vector una vez por `content_hash` y joinear. |
| E3 | E | El índice FTS se reconstruye completo (O(corpus total)) una vez por rama escrita más una por prune: un refresh de 20 repos × 7 ramas ≈ 150 rebuilds del corpus entero. Hoy son milisegundos; funciona por accidente del tamaño del corpus. | `src/rag/store.ts:234`, `:313-315` | Un solo rebuild al final de la corrida; mantener el rebuild-en-transacción solo para escrituras aisladas. |
| F2 | F | Un repo eliminado de `repos.json` nunca se limpia del índice: `runRefresh` itera solo los configurados y `pruneBranches` es por-repo. Sus chunks siguen contestando en `search_project_docs` indefinidamente sin aparecer en `list_projects`, hasta el próximo bump de `SCHEMA_VERSION`. | `src/rag/indexer.ts:135`, `:181-182` | Al inicio de un refresh global, borrar filas cuyo `repo` no esté en `config.all`. |
| F3 | F | Cuando `splitLongText` corta una sección larga, los pedazos 2..N no contienen el heading en el texto que se embebe (solo en metadata): la mitad keyword sí lo ve (columna FTS con peso 3×), pero el vector semántico de esos pedazos se calcula sin su contexto temático. | `src/rag/chunker.ts:89-129` | Anteponer el heading al texto que se manda a embeber (no al `content` almacenado). |
| B-1 | B | `search_project_docs(query, branch: "x")` sin `repo`, sobre un índice poblado que no tiene esa rama, responde "The documentation index is empty. Run refresh_index first" — falso, y manda al agente a un reindexado global que no arregla nada. El caso rama+repo sí está bien resuelto y testeado. | `src/tools/searchProjectDocs.ts:117-119` | Con `branch` y sin `repo`, listar las ramas indexadas globalmente, como ya hace el caso con repo. |
| B-2 | B | Un `data/index.db` corrupto lanza `SQLITE_NOTADB` dentro de `buildContext()` — a nivel de módulo, fuera del `main().catch` — y el server no arranca, con el error crudo de better-sqlite3 y sin decir que basta borrar el archivo. Contradice la doctrina del proyecto: el índice es un caché derivado, no fuente de verdad. | `src/rag/store.ts:89-92` + `src/index.ts:20` | Try/catch en la apertura; ante `SQLITE_NOTADB`/`SQLITE_CORRUPT`, renombrar y recrear el archivo logueando a stderr, igual que ya se hace con el bump de `SCHEMA_VERSION`. |
| G1 | G | La descripción de `refresh_index` afirmaba *"Indexing is on-demand: nothing updates the index on its own"* — falso desde que existe el auto-index de arranque. La descripción es la lógica de ruteo por convención del propio proyecto: un agente que la lea dispara reindexados completos innecesarios justo después de un arranque que ya refrescó. | `src/tools/refreshIndex.ts:14-15` | **[CORREGIDO]** descripción actualizada: menciona el auto-index y cuándo tiene sentido forzar. |
| G2 | G | `get_file_content` puede devolver hasta 400 KB inline (~100k tokens) al contexto del agente: el rechazo por tamaño está bien resuelto (mensaje accionable que deriva a `search_project_docs`), pero un archivo de 390 KB pasa el guard entero. | `src/github/octokitClient.ts:18`, `:116-121` | Bajar el techo o agregar `max_chars`/offset con truncado explícito y `truncated: true`. |
| D1 | D | `guard` devolvía al agente solo `error.message` y no escribía nada en stderr: el stack trace de un error no-dominio se perdía para siempre. Único punto ciego de diagnosticabilidad — si falla en otra máquina sin acceso remoto, el log del server no registra ni en qué tool falló. | `src/tools/shared.ts:16-25` | **[CORREGIDO]** el error inesperado se loguea completo a stderr antes de responder. |
| D3 | D | El fallback al endpoint legacy de Ollama (`/api/embeddings`, bucle secuencial) y el probe que lo activa no tienen ningún test; un Ollama viejo en otra máquina ejercería exactamente el camino no probado. | `src/rag/embeddings.ts:80-85`, `:96` | Test del probe (404 → legacy) y del bucle secuencial con un `fetch` inyectado. |

### Bajos

| ID | Cat. | Descripción | Archivo/línea | Fix sugerido |
|---|---|---|---|---|
| C-1 | C | El fallback de `translateGitHubError` para estados no mapeados (p. ej. 500) devolvía el error octokit crudo, que llega a `guard` y a `console.error`. Hoy no filtra el token porque `@octokit/request-error` redacta `authorization` — pero esa garantía vivía en la dependencia, no en este código. | `src/github/octokitClient.ts:324` | **[CORREGIDO]** el fallback reenvuelve en un `Error` propio con solo status y mensaje. |
| C-2 | C | `branch` en `search_project_docs` no se valida contra nada; solo puede producir 0 resultados. Sin impacto de seguridad. | `src/tools/searchProjectDocs.ts` | No requiere fix. |
| A5 | A/G | `list_projects` hacía fan-out `Promise.all` sin límite sobre todos los repos: inocuo con 3, roza los límites secundarios con 20+. La misma lección que `compare_status` documenta y aplica (4 en vuelo). | `src/tools/listProjects.ts:20-23` | **[CORREGIDO]** usa el `mapWithLimit` compartido. |
| A6 | A | Un repo sin README cuesta hasta 4 requests 404 en cada `get_project_summary` (candidatos probados en secuencia, sin memoria entre llamadas). | `src/tools/getProjectSummary.ts:67-78` | Resolver contra el listado del tree, o cachear en memoria "sin README" durante el proceso. |
| E4 | E | `listBranches` trae una sola página (100): si `main`/`dev` no caen en ella (orden lexicográfico), el repo queda como `missing` en silencio — el motivo real sería la truncación. Correcto hoy por accidente (los repos tienen pocas ramas); como tope anti-gasto la no-paginación es deliberada y está bien. | `src/github/octokitClient.ts:176-180` | Si `data.length === 100`, pedir explícitamente las ramas configuradas ausentes con `repos.getBranch` antes de declararlas missing. |
| B-3 | B | `compare_status` con `repos: []` (error plausible del agente) devuelve una comparación vacía en silencio: `[]` no es nullish. | `src/tools/compareStatus.ts:77` | `z.array(...).min(1)` o tratar `[]` como "todos". |
| B-5 | B | El comparador de ramas hacía `Date.parse(x ?? '') - Date.parse(y ?? '') || 0`: con fecha inválida da `NaN || 0` → `0`, y la rama sin fecha conserva posición arbitraria en vez de ir al final como afirma el comentario. | `src/github/octokitClient.ts:210-212` | **[CORREGIDO]** las fechas inválidas rankean como `-Infinity`, igual que `rank()` en `compare_status`. |
| B-6 | B | Detección de binarios solo por byte NUL: un texto UTF-16 con BOM se rechaza como binario; un binario sin NUL pasa y produce mojibake sin error. Aceptable para el corpus real (markdown). El decode base64 y el guard de tamaño están bien (el guard dispara antes del `content: ""` que GitHub devuelve para > 1 MB). | `src/github/octokitClient.ts:123-128` | Mencionar la codificación en el mensaje de rechazo. |
| B-7 | B | `assertVector` chequeaba `typeof v !== 'number'`, y `typeof NaN === 'number'`: un vector con NaN pasaba y podía persistirse, produciendo scores NaN silenciosos en cada búsqueda posterior. (La mitad del hallazgo que apuntaba a `store.ts` resultó incorrecta al verificar: ahí no existe ese chequeo, y `normalizeVector` ya rechaza magnitudes no finitas.) | `src/rag/embeddings.ts:157-164` | **[CORREGIDO]** `assertVector` usa `Number.isFinite`. |
| B-8 | B | `readMaxAgeHours` usaba `parseFloat`: `"12abc"` → `12` y el warning de valor ignorado nunca se emitía para ese typo. | `src/rag/autoIndex.ts:130` | **[CORREGIDO]** usa `Number(raw)`. |
| B-9 | B | No hay `process.on('unhandledRejection'/'uncaughtException')`. Todos los caminos auditados están cubiertos (tres capas reales alrededor del fire-and-forget), así que es solo defensa en profundidad para código futuro. | `src/index.ts` | Opcional: handlers que logueen a stderr y salgan limpio. |
| D4 | D | Timeout de Ollama no configurable: `OllamaOptions.timeoutMs` existe pero `context.ts` nunca lo cablea desde env — 60 s fijos. En una máquina lenta con el modelo frío no hay perilla sin recompilar. | `src/rag/embeddings.ts:15`, `src/context.ts:34-44` | Env var `REPO_RAG_OLLAMA_TIMEOUT_MS`. |
| D5 | D | Constantes de indexado hardcodeadas: `EMBED_BATCH_SIZE`, `MAX_DOC_BYTES`, chunk size/overlap (`ChunkOptions` existe pero producción llama `chunkMarkdown(text)` sin opciones — la opción es código muerto), `MAX_FILE_BYTES`. Chunk size/overlap son los primeros candidatos a tuning RAG y hoy exigen tocar código. | `src/rag/chunker.ts:14-15`, `src/rag/indexer.ts:53,56,271` | Exponer chunk size/overlap por env o config cuando haga falta tunear; el resto puede quedar. |
| D6 | D | Duplicaciones menores: `describe(error)` en `compareStatus`/`autoIndex` + patrón inline en 5 lugares; el schema zod de `repo` copiado en 6 tools; conteo de fallos duplicado entre `refreshIndex` y `scripts/reindex`; `readReadme` re-resuelve un alias ya resuelto. | varios | Extraer `describeError` y `repoParam` a `shared.ts` en la próxima pasada que toque esos archivos. |
| F4 | F | La query de búsqueda no tiene tope de longitud ni normalización antes de embeber (`min(3)` solamente): una query enorme viaja entera a Ollama y el modelo la trunca a su manera. Riesgo bajo con queries de agente. | `src/tools/searchProjectDocs.ts:28-31` | `.max()` en el schema para documentar el contrato. |
| F5 | F | Chunking: el overlap de 150 chars aplica solo dentro de una sección — el corte por heading no arrastra contexto (decisión razonable: el heading es frontera semántica, se anota para que no se reporte como bug). Headings setext (`===`) no se reconocen. Un fence de código sin cerrar apaga la detección de headings para el resto del archivo — degrada calidad, nunca costo. | `src/rag/chunker.ts:72`, `:109-117` | Solo si aparece corpus con setext o fences rotos; agregar test del camino de corte crudo. |
| G4 | G | `matched_by: 'keyword'` es un valor de enum inalcanzable: todo chunk del scope recibe score semántico, así que `search()` solo asigna `'semantic'` o `'both'`. El tipo promete un estado que no existe. | `src/rag/store.ts:40`, `:421`, `:447` | Quitar el valor del tipo o documentarlo. |

---

## 3. Quick wins (< 30 min cada uno)

Ya aplicados en esta pasada: **G1** (descripción de `refresh_index`), **D1**
(stderr en `guard`), **C-1** (reenvolver fallback de errores), **B-5**
(comparador NaN), **B-7** (`Number.isFinite` en vectores), **B-8**
(`Number` vs `parseFloat`), **A5** (`mapWithLimit` en `list_projects`).

Pendientes, en orden de valor:

1. **B-2** — recuperación ante `index.db` corrupto (renombrar y recrear): es
   el fallo más probable de "no arranca en la máquina de otra persona".
2. **B-1** — mensaje correcto para `branch` sin `repo` en `search_project_docs`.
3. **B-3** — `min(1)` en `compare_status`.
4. **F4** — `.max()` en la query de búsqueda.
5. **A3** — keyear el single-flight por repo resuelto.

---

## 4. Deuda técnica aceptable para v1

- **E2 (search en memoria)** — con el corpus actual son ~14 MB y milisegundos;
  el diseño brute-force está medido y documentado. Revisar al pasar de ~10k
  chunks.
- **E3 (rebuild FTS por rama)** — milisegundos con el corpus actual; solo
  duele en refreshes masivos que hoy no existen.
- **E1 remanente (datado de ramas)** — con A1+A2 aplicados el gasto está
  acotado y el rate limit corta; la reducción real del conteo (GraphQL) es
  optimización de v2.
- **A4 (freno de frescura)** — el single-flight cubre el caso concurrente; el
  secuencial requiere un agente insistiendo en loop, y cada corrida extra es
  cara pero no rompe nada.
- **F2 (repos eliminados)** — solo aparece al sacar un repo de `repos.json`,
  cosa que aún no pasó; el workaround (borrar `data/index.db` y reindexar) es
  trivial y el índice es un caché.
- **F3 (heading en chunks de continuación)** — afecta solo a secciones que
  superan 1.200 chars; la mitad keyword compensa con el peso 3× del heading.
- **G2 (archivos grandes inline)** — el corpus real son markdown chicos; el
  techo de 400 KB ya rechaza lo peor con mensaje accionable.
- **D3/D5/D6, E4, A6, B-6, B-9, F5, G4** — pulido y hardening que no bloquean
  el uso inicial; ninguno se dispara con el corpus y la escala actuales.

---

## 5. Correcciones aplicadas en esta pasada

1. **A1 / A5** — `mapWithLimit` extraído de `compare_status` a
   `src/core/concurrency.ts` y aplicado en `octokitClient.listBranches`
   (límite 4 en vuelo para los `getCommit`) y en `list_projects`.
   `compare_status` ahora importa la versión compartida.
2. **A2** — `RateLimitError` aborta la corrida de indexado: el loop de
   archivos lo relanza en vez de anotarlo como archivo salteado, y el loop de
   repos corta la corrida reportando los repos restantes como omitidos con la
   hora de reset. Fallo parcial sigue aplicando para todo error local.
3. **F1** — la cadena de guardas de modelo quedó cerrada de punta a punta:
   `IndexStats` expone `model`; `selectStaleRepos` trata un modelo distinto
   del configurado como índice vencido (el auto-index se autorepara solo); y
   `search_project_docs` verifica el modelo del índice en el scope antes de
   buscar y falla con mensaje accionable ("rebuilt with refresh_index") ante
   un desajuste — para el caso auto-index apagado.
4. **D2** — `normalizePath` exportada (`translateGitHubError` ya lo estaba) y
   ambas cubiertas en `test/octokitClient.test.ts` (11 tests): 401 →
   `PermissionError`, 403 con `x-ratelimit-remaining: 0` → `RateLimitError`
   con `resetAt`, 403 sin headers → `PermissionError`, 404 → `NotFoundError`,
   409 (repo vacío) → `NotFoundError`, 429 → `RateLimitError`, estado no
   mapeado → error reenvuelto sin objeto octokit; `normalizePath`: slashes
   iniciales, rechazo de `..` y de vacío.
5. **Quick wins** — G1, D1, C-1, B-5, B-7, B-8 según la tabla.

Verificado después de los cambios: **96 tests en verde** (83 de línea base +
13 nuevos), `typecheck`, `typecheck:test` y `build` limpios.
