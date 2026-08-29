# repo-rag-mcp

Servidor **MCP de solo lectura** que le da a un agente de código (OpenCode, Claude
Code, Codex) dos cosas sobre los repositorios de una organización de GitHub:

- **Estado en vivo** desde GitHub: último commit, ramas, PRs e issues abiertos.
- **Búsqueda sobre la documentación** de cada proyecto, por significado y por
  palabra exacta a la vez.

> **El servidor nunca escribe en GitHub.** No crea issues, no comenta, no aprueba
> PRs, no hace push. Esas funciones no existen en el código. Lo único que escribe
> es el índice de búsqueda, en tu propia máquina.

---

## Por dónde empezar

Elegí según para qué venís:

| Si sos… | Leé esto |
|---|---|
| **Alguien que quiere entender qué es esto y por qué sirve** — sin saber nada de IA | [`docs/CONCEPTOS.md`](docs/CONCEPTOS.md) |
| **Quien lo va a instalar** en su máquina | [`docs/INSTALACION.md`](docs/INSTALACION.md) |
| **Quien lo va a usar** y quiere saber qué preguntarle | [`docs/COMO_FUNCIONA.md`](docs/COMO_FUNCIONA.md) |
| **Quien va a tocar el código** | [`CLAUDE.md`](CLAUDE.md) y después [`ROADMAP.md`](ROADMAP.md) |

---

## Toda la documentación

### Para entender el proyecto

- **[`docs/CONCEPTOS.md`](docs/CONCEPTOS.md)** — Qué es un MCP, qué es RAG, qué es
  un embedding, por qué la búsqueda usa dos motores, y por qué esto vale más que
  darle al agente la API de GitHub. Escrito para lectores **no técnicos**: no hay
  código y todo va con analogías. Es el punto de partida si no venís del palo.

- **[`docs/COMO_FUNCIONA.md`](docs/COMO_FUNCIONA.md)** — Las nueve herramientas
  una por una: qué hace cada una, qué preguntas la disparan y qué esperar de la
  respuesta. Incluye la tabla de "lo que preguntás → lo que se dispara", cómo
  funcionan las ramas (`main` es producción, `dev` la réplica) y qué **no** hace
  el servidor.

### Para ponerlo a andar

- **[`docs/INSTALACION.md`](docs/INSTALACION.md)** — Paso a paso en Windows con
  OpenCode: Node, pnpm, Ollama, el token de GitHub, el primer indexado y el
  registro del servidor en el editor. Unos 20 minutos, la mayoría esperando
  descargas.

### Para desarrollar

- **[`CLAUDE.md`](CLAUDE.md)** — La referencia técnica: stack y por qué se eligió
  cada pieza, estructura de carpetas, comandos, configuración (`repos.json` y
  `.env`), convenciones del código, y las decisiones de diseño argumentadas
  (por qué la búsqueda es híbrida, por qué el caché de embeddings se keyea por
  contenido, por qué el auto-index no bloquea el arranque).

- **[`ROADMAP.md`](ROADMAP.md)** — Qué entró en v1, qué está hecho y qué falta de
  v2, e ideas abiertas para v3.

- **[`NEXT_HANDOFF.md`](NEXT_HANDOFF.md)** — Estado actual del proyecto y desde
  dónde seguir. Pensado para arrancar una sesión de trabajo nueva.

- **[`INITIAL_HANDOFF.md`](INITIAL_HANDOFF.md)** — El documento con el que nació
  el proyecto. Valor histórico: explica la intención original.

### Mediciones

- **[`docs/evaluacion-respuestas-conversacion.md`](docs/evaluacion-respuestas-conversacion.md)**
  — Preguntas **reales** de una conversación de uso con las respuestas que dio el
  sistema. Es el material con el que se midió la calidad de la búsqueda y el que
  llevó a cambiar el modelo de embeddings. Si usás el servidor y una respuesta
  sale mal, agregarla acá es la contribución más útil que podés hacer.

---

## Arranque rápido

Requiere Node 20+, pnpm y [Ollama](https://ollama.com) corriendo local.

```bash
pnpm install                       # la primera vez
cp .env.example .env               # y completá GITHUB_TOKEN
ollama pull bge-m3                 # el modelo de embeddings
pnpm build
pnpm reindex                       # primer indexado de todos los repos
```

La guía completa, con el registro en el editor, está en
[`docs/INSTALACION.md`](docs/INSTALACION.md).

### Comandos

| Comando | Qué hace |
|---|---|
| `pnpm dev` | Servidor en modo desarrollo (tsx) |
| `pnpm build` | Compila a `dist/` |
| `pnpm reindex` | Indexa todos los repos configurados |
| `pnpm reindex turnos` | Indexa uno solo |
| `pnpm test` | Suite completa (sin red y sin Ollama) |
| `pnpm typecheck` | `tsc --noEmit` sobre `src` |
| `pnpm inspect` | MCP Inspector contra `dist/index.js` |

---

## Las nueve herramientas

| Tool | Qué hace | Fuente |
|---|---|---|
| `list_projects` | Lista los repos configurados con descripción, última actividad y estado del índice | Vivo |
| `get_project_status` | Branch, último commit, PRs e issues abiertos | Vivo |
| `compare_status` | El estado de varios repos en una sola llamada, ordenado por actividad | Vivo |
| `get_project_summary` | Estado + comienzo del README, en una sola llamada | Vivo |
| `get_recent_commits` | Últimos N commits crudos | Vivo |
| `list_branches` | Ramas del repo con última actividad y si están indexadas | Vivo |
| `get_file_content` | Un archivo completo, sin fragmentar, de cualquier rama | Vivo |
| `search_project_docs` | Búsqueda híbrida sobre la documentación indexada | Índice |
| `refresh_index` | Reindexa uno o todos los repos | Escribe el índice local |

El detalle de cuándo se dispara cada una está en
[`docs/COMO_FUNCIONA.md`](docs/COMO_FUNCIONA.md).

---

## Privacidad

- El texto se procesa **local**, con Ollama en tu máquina. La documentación de los
  repos no se manda a ningún proveedor de IA para ser indexada.
- El índice es un archivo local. No hay base de datos en la nube.
- Lo único que sale a internet son consultas de **lectura** a la API de GitHub.
- El `.env` con el token **nunca** se versiona (está en `.gitignore`).
