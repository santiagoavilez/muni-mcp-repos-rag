# repo-rag-mcp

🌐 **English** | [Español](README.es.md)

A **read-only MCP server** that gives a coding agent (OpenCode, Claude Code,
Codex) two things about the repositories of a GitHub organization:

- **Live status** from GitHub: latest commit, branches, open PRs and issues.
- **Search over the documentation** of each project, by meaning and by exact
  word at the same time.

> **The server never writes to GitHub.** It doesn't create issues, comment,
> approve PRs or push. Those functions don't exist in the code. The only thing it
> writes is the search index, on your own machine.

---

## Where to start

Pick according to why you're here:

| If you are… | Read this |
|---|---|
| **Someone who wants to understand what this is and why it's useful** — with no AI background | [`docs/en/CONCEPTS.md`](docs/en/CONCEPTS.md) |
| **Someone who will install it** on their machine | [`docs/en/INSTALLATION.md`](docs/en/INSTALLATION.md) |
| **Someone who will use it** and wants to know what to ask it | [`docs/en/HOW_IT_WORKS.md`](docs/en/HOW_IT_WORKS.md) |
| **Someone who will touch the code** | [`docs/en/ARCHITECTURE.md`](docs/en/ARCHITECTURE.md), then [`CLAUDE.md`](CLAUDE.md) and [`ROADMAP.md`](docs/en/ROADMAP.md) |

---

## All the documentation

### To understand the project

- **[`docs/en/CONCEPTS.md`](docs/en/CONCEPTS.md)** — What an MCP is, what RAG is,
  what an embedding is, why the search uses two engines, and why this is worth
  more than giving the agent the GitHub API. Written for **non-technical**
  readers: there is no code and everything comes with analogies. It is the
  starting point if you don't come from a technical background.

- **[`docs/en/HOW_IT_WORKS.md`](docs/en/HOW_IT_WORKS.md)** — The nine tools one by
  one: what each one does, which questions trigger it and what to expect from the
  answer. It includes the "what you ask → what gets triggered" table, how
  branches work (`main` is production, `dev` is the replica) and what the server
  does **not** do.

### To get it running

- **[`docs/en/INSTALLATION.md`](docs/en/INSTALLATION.md)** — Step by step on
  Windows with OpenCode: Node, pnpm, Ollama, the GitHub token, the first indexing
  run and registering the server in the editor. About 20 minutes, most of it
  waiting on downloads.

### To develop

- **[`docs/en/ARCHITECTURE.md`](docs/en/ARCHITECTURE.md)** — How the server is
  built **on the inside**, with diagrams: the module map and who depends on whom,
  the startup sequence, the full indexing pipeline, the embedding cache, the
  hybrid search step by step, the data model and error handling. It is the first
  thing to read before touching the code.

- **[`CLAUDE.md`](CLAUDE.md)** — The technical reference: stack and why each piece
  was chosen, folder structure, commands, configuration (`repos.json` and
  `.env`), code conventions, and the reasoned design decisions (why the search is
  hybrid, why the embedding cache is keyed by content, why the auto-index doesn't
  block startup).

- **[`ROADMAP.md`](docs/en/ROADMAP.md)** — What went into v1, what is done and what
  remains of v2, and open ideas for v3.

- **[`NEXT_HANDOFF.md`](NEXT_HANDOFF.md)** — Current state of the project and where
  to continue from. Meant for starting a new work session.

- **[`INITIAL_HANDOFF.md`](INITIAL_HANDOFF.md)** — The document the project was
  born from. Historical value: it explains the original intent.

### Measurements

- **[`docs/evaluacion-respuestas-conversacion.md`](docs/evaluacion-respuestas-conversacion.md)**
  — **Real** questions from a usage conversation with the answers the system gave.
  It is the material used to measure search quality and the one that led to
  changing the embedding model. If you use the server and an answer comes out
  wrong, adding it there is the most useful contribution you can make.

---

## Quick start

Requires Node 20+, pnpm and [Ollama](https://ollama.com) running locally.

```bash
pnpm install                       # the first time
cp .env.example .env               # and fill in GITHUB_TOKEN
ollama pull bge-m3                 # the embedding model
pnpm build
pnpm reindex                       # first indexing run of all repos
```

The full guide, including registering the server in the editor, is in
[`docs/en/INSTALLATION.md`](docs/en/INSTALLATION.md).

### Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Server in development mode (tsx) |
| `pnpm build` | Compiles to `dist/` |
| `pnpm reindex` | Indexes all configured repos |
| `pnpm reindex turnos` | Indexes just one |
| `pnpm test` | Full suite (no network and no Ollama) |
| `pnpm typecheck` | `tsc --noEmit` over `src` |
| `pnpm inspect` | MCP Inspector against `dist/index.js` |

---

## The nine tools

| Tool | What it does | Source |
|---|---|---|
| `list_projects` | Lists the configured repos with description, latest activity and index status | Live |
| `get_project_status` | Branch, latest commit, open PRs and issues | Live |
| `compare_status` | The status of several repos in a single call, ordered by activity | Live |
| `get_project_summary` | Status + the beginning of the README, in a single call | Live |
| `get_recent_commits` | Last N raw commits | Live |
| `list_branches` | The repo's branches with latest activity and whether they are indexed | Live |
| `get_file_content` | A complete file, not chunked, from any branch | Live |
| `search_project_docs` | Hybrid search over the indexed documentation | Index |
| `refresh_index` | Reindexes one or all repos | Writes the local index |

The detail of when each one is triggered is in
[`docs/en/HOW_IT_WORKS.md`](docs/en/HOW_IT_WORKS.md).

---

## Privacy

- Text is processed **locally**, with Ollama on your machine. The repos'
  documentation is not sent to any AI provider to be indexed.
- The index is a local file. There is no cloud database.
- The only thing that goes out to the internet is **read** queries to the GitHub
  API.
- The `.env` with the token is **never** versioned (it's in `.gitignore`).
