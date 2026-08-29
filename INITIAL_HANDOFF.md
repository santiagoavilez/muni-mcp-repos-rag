# Handoff: MCP Server — Tracking + RAG de Repositorios

Pegar este documento completo como primer mensaje en una sesión nueva de Claude Code, en la raíz del proyecto (carpeta vacía o inicializada con `pnpm init`).

---

## 1. Contexto del proyecto

Estoy construyendo un servidor MCP (Model Context Protocol) para que mi jefe, desde OpenCode, pueda:

1. Consultar el estado actual de los repositorios de una organización de GitHub (últimos commits, PRs/issues abiertos) sin salir del editor.
2. Hacer preguntas en lenguaje natural sobre la documentación de esos repos (READMEs, TRACKER.md, NEGOCIO.md, CLAUDE.md) usando RAG.

**Importante:** este MCP es de solo lectura. No debe crear, modificar ni comentar nada en GitHub. Todo el razonamiento y generación de respuestas lo hace el modelo del lado de OpenCode — este servidor solo expone herramientas de *retrieval*.

---

## 2. Stack decidido

| Pieza | Elección |
|---|---|
| Lenguaje | TypeScript |
| Runtime | Node.js |
| Package manager | pnpm |
| MCP SDK | `@modelcontextprotocol/sdk` (transporte stdio) |
| Validación de schemas | `zod` |
| Cliente GitHub | `@octokit/rest` |
| Embeddings | Ollama local, modelo `nomic-embed-text`, vía `fetch` a `http://localhost:11434` (sin SDK) |
| Vector store | SQLite con `better-sqlite3`. Intentar `sqlite-vec` primero; si da fricción de compilación (posible en Windows, donde corre mi jefe), usar fallback: guardar embeddings como JSON/blob en columna de tabla normal y calcular cosine similarity en JS puro. Volumen esperado es bajo (pocos repos, pocos docs), así que el fallback es perfectamente viable en rendimiento. |
| Auth | GitHub fine-grained Personal Access Token, read-only, scopeado a `contents` + `metadata` + lectura de `pull requests`/`issues`, limitado solo a los repos de la organización. Se pasa por variable de entorno, nunca hardcodeado ni committeado. |

---

## 3. Arquitectura en capas

- **Capa "live"**: llamadas directas a la API de GitHub vía octokit. Sin pasar por embeddings. Para todo lo que necesita estar actualizado al segundo (commits, PRs, issues, estado del repo).
- **Capa RAG**: contenido que cambia poco (READMEs, docs de proyecto). Se indexa on-demand (no watch en tiempo real): trae contenido vía API de GitHub (sin clonar el repo), trocea, genera embeddings locales, guarda en SQLite. Búsqueda semántica sobre eso.
- **Capa de archivo puntual**: traer un archivo completo sin fragmentar, para cuando se pide algo específico completo (ej. "mostrame el TRACKER completo de X").

---

## 4. Tools a implementar (v1)

Definir cada una con su schema `zod` de input/output y descripción clara (la descripción de la tool es donde va la lógica de cuándo usarla — el modelo decide en base a eso).

1. **`list_projects()`**
   Devuelve lista de repos configurados: nombre, descripción, fecha de última actividad.

2. **`get_project_status(repo: string)`**
   Devuelve: default branch, último commit (autor, fecha, mensaje), cantidad de PRs abiertos, cantidad de issues abiertos.

3. **`get_recent_commits(repo: string, n?: number)`**
   Lista de commits crudos: sha corto, autor, fecha, mensaje. Sin pasar por RAG. Default `n=10`.

4. **`search_project_docs(query: string, repo?: string)`**
   Búsqueda semántica sobre contenido indexado (READMEs, docs). Devuelve chunks relevantes + score + archivo/repo de origen.

5. **`refresh_index(repo?: string)`**
   Dispara reindexado on-demand: trae contenido actual vía API, trochea, genera embeddings, guarda. Si no se pasa `repo`, reindexar todos los configurados.

6. **`get_project_summary(repo: string)`**
   Combina `get_project_status` + primeros N caracteres del README (sin pasar por RAG). Pensado como "resumen ejecutivo" rápido sin encadenar tools.

7. **`get_file_content(repo: string, path: string)`**
   Trae un archivo puntual completo (CLAUDE.md, TRACKER.md, NEGOCIO.md, changelog) sin fragmentar.

**Nota para v2** (no implementar todavía, solo dejar en el roadmap): `compare_status(repos: string[])` para status de varios repos en una sola llamada.

---

## 5. Qué necesito que armes

1. Estructura de carpetas del proyecto (siguiendo patrón interface/adapter si aplica).
2. `package.json` con las dependencias del stack.
3. Config de repos a trackear (archivo `.json` o `.env` — proponé el que tenga más sentido, van a ser ~4-6 repos de la organización).
4. Implementación de las 7 tools con schemas zod.
5. Script indexador (`refresh_index` puede llamarlo internamente, o correr standalone).
6. Manejo de errores razonable: rate limit de GitHub, Ollama no corriendo, repo no encontrado en config.

---

## 6. Documentación a generar (en español, para mi jefe — no técnico en el detalle de RAG/embeddings, pero sí developer)

Crear los siguientes archivos:

### `CLAUDE.md`
Entrypoint de sesión para trabajar en este repo con Claude Code. Debe incluir: qué es el proyecto, stack, estructura de carpetas, cómo correr el indexador, cómo correr el server en modo dev, convenciones de código, y referencia a los otros documentos (ROADMAP, docs de instalación).

### `ROADMAP.md`
Con secciones v1 / v2 / v3:
- **v1**: las 7 tools listadas arriba, indexado on-demand, config estática de repos.
- **v2**: `compare_status`, indexado automático programado (ej. cron o al iniciar el server), posiblemente lectura de comentarios de PRs si se pide.
- **v3**: ideas abiertas — por ejemplo extender el RAG a otros repos, o integrar con un MCP de tareas para cruzar estado de tareas con estado de repos.

### `docs/INSTALACION.md` (para mi jefe)
Guía paso a paso en español, asumiendo que usa OpenCode en Windows:
- Requisitos (Node, pnpm, Ollama instalado + modelo `nomic-embed-text` descargado)
- Cómo generar y configurar el GitHub PAT (read-only, scopeado)
- Cómo configurar el servidor MCP en OpenCode (archivo de config, comando de arranque)
- Cómo correr el primer `refresh_index`
- Troubleshooting básico (Ollama no responde, token sin permisos, repo no aparece)

### `docs/COMO_FUNCIONA.md` (para mi jefe)
Explicación conceptual, sin jerga innecesaria, de:
- Qué hace cada tool y cuándo el agente la usa (ejemplos de preguntas → qué tool dispara)
- Diferencia entre "estado en vivo" (commits, PRs) y "búsqueda semántica" (RAG sobre docs)
- Qué significa que el indexado sea on-demand (por qué a veces hay que correr `refresh_index` manualmente)
- Qué NO hace el server (no escribe nada en GitHub, no reemplaza mirar el repo directamente para cosas muy específicas)

---

## 7. Fuera de alcance para v1

- Tools de escritura (crear issues, comentar, aprobar PRs) — el servidor es estrictamente read-only.
- Indexado en tiempo real / watch de cambios.
- Multi-usuario o autenticación más allá del PAT único configurado localmente.