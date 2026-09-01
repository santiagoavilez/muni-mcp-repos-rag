# repo-rag-mcp

Servidor MCP **de solo lectura** que expone los repositorios de una organización de GitHub a un agente (OpenCode, Claude Code, etc.): estado en vivo desde GitHub y
búsqueda híbrida sobre la documentación de cada proyecto.

> **El servidor nunca escribe en GitHub.** No crea issues, no comenta, no aprueba
> PRs. Lo único que escribe es el índice local de búsqueda.

---

## Stack

| Pieza | Elección |
|---|---|
| Lenguaje / runtime | TypeScript sobre Node.js (ESM) |
| Package manager | pnpm |
| MCP | `@modelcontextprotocol/sdk`, transporte stdio |
| Schemas | `zod` |
| GitHub | `@octokit/rest` |
| Embeddings | Ollama local (`bge-m3`) vía `fetch`, sin SDK |
| Vector store | SQLite (`better-sqlite3`) + cosine similarity en JS |
| Búsqueda | Híbrida: coseno + BM25 (FTS5 de SQLite), fusionados con RRF |

### Por qué no `sqlite-vec`

Necesita una extensión nativa que en Windows suele requerir toolchain de
compilación. Acá el corpus son unos pocos markdown por repo: un producto punto
sobre unos miles de vectores tarda menos de un milisegundo. Se guardan como blobs
`Float32` normalizados (L2), así el coseno **es** el producto punto.
`better-sqlite3` sí se usa, pero baja binario precompilado (`prebuild-install`),
sin compilar nada.

---

## Estructura

```
src/
  index.ts              # entrypoint MCP: arma el contexto y registra las 9 tools
  context.ts            # inyección de dependencias (config, github, embeddings, store)
  config/repos.ts       # carga y valida repos.json; resuelve alias -> owner/repo
  core/
    env.ts              # carga de .env (resuelta contra el archivo, no contra cwd)
    errors.ts           # errores de dominio que `guard` convierte en tool errors
    paths.ts            # raíz del proyecto y resolución de rutas
  github/
    types.ts            # interfaz GitHubClient (read-only)
    octokitClient.ts    # implementación real + traducción de errores HTTP
    mockClient.ts       # implementación en memoria (tests y dev sin token)
  rag/
    embeddings.ts       # proveedor Ollama (/api/embed con fallback a /api/embeddings)
    chunker.ts          # troceo de markdown por headings
    store.ts            # SQLite: vectores + FTS5 + caché de embeddings, búsqueda híbrida con RRF
    indexer.ts          # orquesta: trae docs -> trocea -> embebe (solo lo no cacheado) -> guarda
    staleness.ts        # funcion pura: que repos tienen el indice vencido
    autoIndex.ts        # reindexado en segundo plano al arrancar el server
  scripts/reindex.ts    # indexador standalone (`pnpm reindex`)
  tools/                # una tool por archivo + shared.ts (ok/fail/guard)
test/                   # node:test, sin red y sin Ollama
repos.json              # repos trackeados (versionado: es config, no secreto)
.env                    # token y endpoints (NUNCA se commitea)
```

---

## Comandos

```bash
pnpm install            # la primera vez; compila el binding de better-sqlite3
pnpm dev                # server en modo desarrollo (tsx)
pnpm build              # compila a dist/
pnpm reindex            # indexa todos los repos configurados
pnpm reindex turnos     # indexa uno solo
pnpm test               # suite completa (sin red, sin Ollama)
pnpm typecheck          # tsc --noEmit sobre src
pnpm typecheck:test     # idem incluyendo test/
pnpm inspect            # MCP Inspector contra dist/index.js
```

---

## Configuración

**`repos.json`** (versionado) — qué repos se trackean y qué archivos se indexan:

```json
{
  "org": "example-org",
  "defaultDocs": ["*.md", "docs/**"],
  "defaultBranches": ["main", "dev"],
  "activeBranchDays": 30,
  "maxActiveBranches": 5,
  "repos": [
    { "alias": "turnos", "repo": "sistema-turnos", "description": "Turnos online" }
  ]
}
```

- `alias`: nombre corto en kebab-case; es lo que el agente usa en cada tool.
- `docs` / `branches` / `org`: opcionales por repo, pisan el valor global.
- `defaultBranches`: convención del equipo — `main` es producción y `dev` la réplica.
  Una rama listada que no existe en un repo se reporta, no falla.
- `activeBranchDays`: además indexa ramas con push reciente. Es lo que hace
  visible el trabajo en curso, cuya documentación nunca llega a `main`. `0` lo
  desactiva.
- `maxActiveBranches`: techo de ramas activas por repo, de más nueva a más vieja.

Patrones de documentos soportados:

| Patrón | Qué toma |
|---|---|
| `README.md` | esa ruta exacta |
| `*.md` | markdown en la **raíz** del repo, no recursivo |
| `docs/**` | markdown bajo `docs/`, recursivo |
| `**` | todo el markdown del repo, a cualquier profundidad |

`**` no es el default a propósito: arrastra plantillas de issues y docs de
dependencias, y todo eso se multiplica por la cantidad de ramas indexadas.

**`.env`** (nunca versionado) — ver `.env.example`. Solo el `GITHUB_TOKEN` es
obligatorio; el resto tiene default razonable.

`REPO_RAG_AUTO_INDEX_HOURS` (default `12`) controla el auto-index del arranque:
todo repo cuyo indice sea mas viejo que eso se reindexa en segundo plano. `0` lo
desactiva. Un repo sin ninguna corrida registrada cuenta siempre como vencido.

---

## Convenciones

- **stdout es el canal MCP.** Todo log va a `stderr` (`console.error`). Un
  `console.log` suelto en el server rompe el protocolo.
- **Una tool por archivo**, exportando `registerX(server, context)`.
- **La descripción de la tool es la lógica de ruteo.** Ahí se explica cuándo
  usarla, cuándo NO, y con qué tool se confunde. El modelo decide leyendo eso.
- **Errores de dominio, no excepciones crudas.** Se lanzan las clases de
  `core/errors.ts` y `tools/shared.ts#guard` las convierte en tool errors con
  mensaje accionable, para que el agente se corrija solo.
- **`readOnlyHint: true` en las 9 tools salvo `refresh_index`**, que escribe el
  índice local (pero sigue sin tocar GitHub).
- **Fallo parcial > fallo total.** Un repo caído no debe dejar al usuario sin
  listado ni sin índice: se reporta por repo y el resto sigue.
- **Código en inglés, comentarios en español.** Identificadores, nombres de
  tools, mensajes de error y descripciones de tools van en inglés (el agente los
  lee y son parte del contrato MCP). Los comentarios y la documentación para el
  equipo van en español neutro: los lee la gente de la organización, no el modelo.

---

### Por qué la búsqueda es híbrida

El coseno solo no alcanza. Medido sobre preguntas reales, el semántico solo
llega a hit@5 4/6 y BM25 solo a 3/6, pero cada uno falla en consultas distintas:
el semántico se pierde cuando la consulta no comparte vocabulario con el
documento, y BM25 cuando la pregunta es un parafraseo. BM25 sí
encuentra un token exacto y raro (`BILLING`, un número de trámite, el nombre
de una clase) pero no entiende parafraseos.

Se fusionan con **Reciprocal Rank Fusion**, que usa solo la POSICIÓN de cada
resultado en su propio ranking. Un coseno y un score BM25 están en escalas
incomparables: normalizarlos a un número único exige recalibrar cada vez que
cambia el modelo o el corpus. Los rangos no.

FTS5 viene dentro de SQLite: no agrega dependencias ni compilación nativa.

---

### Por qué el caché de embeddings se keyea por contenido

Medido sobre el índice real: un refresh completo embebía 2790 chunks de los
cuales solo 767 son textos distintos. `main`, `dev` y las feature branches
comparten casi todos los archivos, así que el 72.5% del trabajo era pedirle al
modelo el mismo párrafo otra vez — dentro de una sola corrida.

Se keyea por sha256 del texto del chunk y no por el `sha` del blob de git: el
hash de contenido tiene granularidad de chunk (editar una sección de un README
reembebe esa sección, no el archivo), no necesita rastrear archivos por rama, y
es autovalidante — el mismo texto da siempre el mismo vector, así que no hay
nada que invalidar y un cambio en el chunker se invalida solo.

El `model` es parte de la clave primaria, y ahí está toda la corrección de la
tabla. Dos modelos pueden coincidir en cantidad de dimensiones
(`nomic-embed-text` y `bge-m3` coinciden), así que el guard por `dimensions` que
usa la búsqueda no alcanzaría: se serviría el vector de un modelo como el de
otro sin un solo error, el índice se vería sano y cada resultado estaría mal en
silencio.

---

### Por qué el auto-index no bloquea el arranque

El índice es una foto, no un espejo, y esa es la cosa más confusa del server
para quien no lo construyó: pregunta por un documento que está en GitHub y se le
contesta que la documentación no lo cubre. El auto-index elimina el paso manual
en vez de documentarlo.

Se dispara después de `server.connect(transport)` y **sin `await`**. Si se
esperara, el handshake MCP quedaría colgado de GitHub y de Ollama, y un arranque
en frío dejaría al cliente esperando minutos. Sin `await`, las tools contestan
desde el índice viejo mientras la actualización corre por detrás.

Nunca tira hacia afuera: un server que contesta con un índice vencido es
muchísimo mejor que uno que no arranca. Por eso hay try/catch por repo y otro
alrededor de todo, más un `.catch` final en `index.ts` para que un rechazo
inesperado en un fire-and-forget no se convierta en unhandled rejection.

Los repos van en secuencia, nunca con `Promise.all`: paralelizar multiplicaría
la presión sobre el rate limit de GitHub y sobre Ollama justo cuando el agente
empieza a preguntar, sin ganar nada — esto ya corre en segundo plano.

El single-flight vive en `Indexer`, no en el scheduler: el scheduler, la tool
`refresh_index` y `pnpm reindex` entran todos por `Indexer.refresh`, así que un
guard puesto en cualquiera de ellos lo esquivan los otros dos.

---

### Qué dio la medición de la búsqueda (v2)

Medido sobre el corpus real (850 chunks distintos, 41 documentos, 3 repos) con
seis preguntas **reales** tomadas de una conversación de uso
(`docs/evaluacion-respuestas-conversacion.md`). Posición del documento esperado,
más bajo es mejor:

| | hit@1 | hit@5 | suma de posiciones |
|---|---|---|---|
| semántico `nomic-embed-text` | 1/6 | 2/6 | 259 |
| semántico `bge-m3` | 2/6 | 4/6 | 114 |
| solo BM25 | 2/6 | 3/6 | 61 |
| híbrida con `nomic` | 1/6 | 3/6 | 120 |
| **híbrida con `bge-m3`** | **2/6** | **4/6** | **62** |

Tres conclusiones, en orden de importancia:

1. **Con `nomic-embed-text` la híbrida era peor que BM25 solo.** La mitad
   semántica no aportaba: toda la maquinaria de RRF pagaba una complejidad que
   no compraba nada. Con `bge-m3` la híbrida por fin le gana a BM25 en hit@5.
   El diseño no estaba mal, estaba subalimentado.

2. **`RRF_K` se queda en 60.** Tres barridos independientes (con nomic, con
   bge-m3, y con un set de preguntas descartado) dan lo mismo: entre K=0 y K=60
   las tasas de acierto no se mueven. No hay evidencia para tocarlo.

3. **La premisa vieja quedó obsoleta.** La documentación decía que todos los
   cosenos caían entre 0.72 y 0.76. Con el corpus actual van de 0.30 a 0.83.
   Esa afirmación justificaba el diseño híbrido y ya no aplica; lo que hoy lo
   justifica es la tabla de arriba.

**Salvedad honesta:** n=6. La diferencia de hit@5 entre `bge-m3` y BM25 es una
sola pregunta, y `bge-m3` empeoró en dos consultas. La dirección es sólida — la
pregunta real sobre BILLING pasó del puesto 146 al 3 — pero no es una
estimación precisa. Sumar más preguntas reales antes de sacar otra conclusión.

**Cuidado al medir:** las consultas deben embeberse con el mismo prefijo de
tarea que los documentos. `nomic-embed-text` indexa con `search_document:` y
consulta con `search_query:`; medir sin el prefijo lo perjudica artificialmente
(dio suma 410 en vez de 259). `bge-m3` no usa prefijos.

**No inventes el set de preguntas.** Un set escrito leyendo el corpus usa su
mismo vocabulario, favorece a BM25 y produce conclusiones que no se reproducen.
Ya pasó una vez acá: llevó a recomendar bajar `RRF_K`, y las preguntas reales lo
refutaron.

---

## Otros documentos

El índice navegable de toda la documentación está en
[`README.md`](README.md).

- [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) — cómo está construido el server
  por dentro, con diagramas: módulos y dependencias, secuencia de arranque,
  pipeline de indexado, caché de embeddings, búsqueda híbrida, modelo de datos y
  manejo de errores. Léelo antes de tocar el código.
- [`ROADMAP.md`](ROADMAP.md) — qué entra en v1, v2 y v3.
- [`docs/CONCEPTOS.md`](docs/CONCEPTOS.md) — qué es RAG, embeddings, MCP y por qué
  esta integración vale la pena. Para lectores no técnicos.
- [`docs/INSTALACION.md`](docs/INSTALACION.md) — instalación paso a paso en Windows.
- [`docs/COMO_FUNCIONA.md`](docs/COMO_FUNCIONA.md) — qué hace cada tool y cuándo se dispara.
