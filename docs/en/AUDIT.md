# Technical audit — repo-rag-mcp

🌐 **English** | [Español](../../AUDITORIA.md)

Full audit of the server prior to its presentation, covering the seven categories
of the brief: (A) loops/retries/external spend, (B) bugs and error handling, (C)
security, (D) maintainability, (E) scalability, (F) RAG quality and (G) MCP
interface. Four independent reviews in parallel, with each severe finding later
verified against the real code. Baseline at the time of the audit: 83 tests green,
`typecheck` and `typecheck:test` clean.

Findings marked **[FIXED]** were fixed in this pass or in a second pass
(2026-08-30); the detail is at the end of the document.

---

## 1. Executive summary

- **There are no Critical findings.** There are no infinite loops, blind retries
  or paths that multiply spend without a configuration ceiling; the token can never
  leak through our own code; the 9 tools are guarded and no GitHub call writes.
- **High — GitHub quota spend has no brake when it starts failing.**
  `listBranches` fired up to ~100 concurrent `getCommit` calls per call (A1), and a
  rate limit in the middle of a refresh didn't abort the run: the indexer kept
  emitting hundreds of requests doomed to 403 (A2). Both **[FIXED]**.
- **High — an embedding model change with the same dimension served silently
  incorrect results** (F1): the `chunks` table only stores `dimensions`, and
  neither staleness nor search compared the model. It is exactly the failure mode
  the project itself declared unacceptable — and solved — for `embedding_cache`.
  **[FIXED]** with a guard in search and in staleness.
- **High — `octokitClient` had zero test coverage** (D2), including
  `translateGitHubError`, the layer that produces the messages the agent's
  self-correction depends on. **[FIXED]** with unit tests.
- Strengths confirmed by all four reviews (so they aren't lost in the problem
  table): layer separation faithful to what is documented, centralized and
  actionable error translation, repo allowlist that can't be bypassed from the
  tools, 100% prepared SQL with triple defense in FTS5, correct and tested
  embedding cache, and tool descriptions that say when NOT to use them — among the
  best of the project.

---

## 2. Findings table

### Critical

No findings.

### High

| ID | Cat. | Description | File/line | Fix |
|---|---|---|---|---|
| A1 | A | `listBranches` dates each branch with a `getCommit` inside an unbounded `Promise.all`: up to ~100 concurrent requests per call. The comment "only ever called during a refresh" is false — the `list_branches` tool comes in through here on every invocation. `compare_status` documents that GitHub's secondary limits trigger on concurrency and caps at 4 in flight; this method ignored that very lesson. | `src/github/octokitClient.ts:185-208` | **[FIXED]** `mapWithLimit` extracted to `src/core/concurrency.ts` and applied with a limit of 4 (also in `list_projects`). |
| A2 | A | A `RateLimitError` in the middle of indexing was treated the same as a missing file: it is noted in `skipped` and the run continues with the next file, branch and repo. Exhausting the quota at repo 3 of 20 meant hundreds of later requests failing with 403 one by one, each counting against abuse detection. "Partial failure > total failure" is right for a downed repo; a rate limit is a global failure, not a local one. | `src/rag/indexer.ts:262-268`, `:138-155` | **[FIXED]** `RateLimitError` aborts the run; the remaining repos are reported as skipped with the `resetAt`. |
| E1 | E | The GitHub cost of a refresh is dominated by dating all the *existing* branches, not the indexed ones: ≈ `2 + B_existing + B_indexed × (1 + F)` requests per repo. Scenario 20 repos / ~50 branches / 7 indexed / 10 docs ≈ 2,600 requests per run — more than half the hourly quota, and half of it only serves to pick ≤ 5 active branches. Ollama, in contrast, scales well (content cache, batches of 16). | `src/github/octokitClient.ts:173-208` + `src/rag/indexer.ts:209-240` | Mitigated by A1 (bounded concurrency) and A2 (the rate limit cuts it off). The real reduction of the count — dating only unconfigured branches, or a single GraphQL query with `committedDate` per ref — is left for v2 (see §5). |
| F1 | F | Incomplete model/dimension guard chain: `chunks` stores `dimensions` but not the model; search only did `raw.dimensions !== query.length`; `stats()` didn't even select `model` from `index_runs` and `selectStaleRepos` didn't compare it. Changing `REPO_RAG_EMBED_MODEL` to another model with the same dimension (nomic ↔ bge-m3, 1024) crossed the new query's embedding against old vectors without a single error, and the auto-index considered the repo "fresh". | `src/rag/store.ts:117-129`, `:385`, `:500-506`; `src/rag/staleness.ts:20-25` | **[FIXED]** `model` exposed in `IndexStats`; `selectStaleRepos` treats a different model as stale (the auto-index self-heals); `search_project_docs` fails with an actionable message if the scope's index was built with another model. |
| D2 | D | Zero test coverage over `octokitClient`: the whole suite uses `MockGitHubClient`. Left untested were `translateGitHubError` (401/403 rate-limit vs permission/404/409/429, parsing of `x-ratelimit-*` headers), `normalizePath` (rejection of `..`), binary detection and the size limit. It is the layer that produces the messages the agent's self-correction depends on. | `src/github/octokitClient.ts:276-325`, `:259-268` | **[FIXED]** pure functions exported and tested in `test/octokitClient.test.ts`. |

### Medium

| ID | Cat. | Description | File/line | Suggested fix |
|---|---|---|---|---|
| A3 | A/B | The indexer's single-flight keys by the raw reference, not by the resolved repo: `refresh("turnos")`, `refresh("sistema-turnos")` and `refresh("example-org/sistema-turnos")` are different scopes for the same repo — they aren't deduplicated, they queue up and all the runs execute (serialized, without corruption, but spending full GitHub/Ollama each). An LLM agent alternates those forms naturally. | `src/rag/indexer.ts:108-122` | Resolve the reference to `fullName` before building the key (keeping the resolution inside the guarded path: it can throw `ValidationError`). |
| A4 | A | Repeated *sequential* calls to `refresh_index` execute the full run every time even if the index is 30 seconds old: single-flight only covers concurrency. The embedding cache cushions Ollama; GitHub pays full price. | `src/tools/refreshIndex.ts:31-33` | Freshness short-circuit in `Indexer.refresh` (if the scope's last run is < N minutes old, return "already fresh"); `selectStaleRepos` already contains the logic. |
| E2 | E | `search()` materializes the entire `chunks` table (content + blob) in memory per query when there is no scope — the agent's usual case. Today ~2,800 rows ≈ 14 MB and a few ms (correct as the code documents); at 20 repos × ~7 branches ≈ 20k rows it would be ~100 MB and tens to hundreds of ms per search. | `src/rag/store.ts:369-374` | `stmt.iterate()` accumulating only top-k + groups, or store the vector once per `content_hash` and join. |
| E3 | E | The FTS index is rebuilt in full (O(total corpus)) once per written branch plus one per prune: a refresh of 20 repos × 7 branches ≈ 150 rebuilds of the entire corpus. Today it's milliseconds; it works by accident of the corpus size. | `src/rag/store.ts:234`, `:313-315` | A single rebuild at the end of the run; keep the rebuild-in-transaction only for isolated writes. |
| F2 | F | A repo removed from `repos.json` is never cleaned out of the index: `runRefresh` iterates only the configured ones and `pruneBranches` is per-repo. Its chunks keep answering in `search_project_docs` indefinitely without appearing in `list_projects`, until the next `SCHEMA_VERSION` bump. | `src/rag/indexer.ts:135`, `:181-182` | At the start of a global refresh, delete rows whose `repo` isn't in `config.all`. |
| F3 | F | When `splitLongText` cuts a long section, pieces 2..N don't contain the heading in the text that gets embedded (only in metadata): the keyword half does see it (FTS column with 3× weight), but the semantic vector of those pieces is computed without their topical context. | `src/rag/chunker.ts:89-129` | Prepend the heading to the text sent to embed (not to the stored `content`). |
| B-1 | B | `search_project_docs(query, branch: "x")` without `repo`, over a populated index that doesn't have that branch, answered "The documentation index is empty. Run refresh_index first" — false, and sent the agent to a global reindex that fixes nothing. The branch+repo case was properly resolved and tested. | `src/tools/searchProjectDocs.ts:117-119` | **[FIXED]** with `branch` and no `repo`, the globally indexed branches are listed, as the with-repo case already did; the "empty index" message remains only for when nothing is really indexed. |
| B-2 | B | A corrupt `data/index.db` threw `SQLITE_NOTADB`/`SQLITE_CORRUPT` inside `buildContext()` — at module level, outside `main().catch` — and the server didn't start, with the raw better-sqlite3 error and without saying that deleting the file was enough. It contradicted the project's doctrine: the index is a derived cache, not a source of truth. | `src/rag/store.ts:89-92` + `src/index.ts:20` | **[FIXED]** opening the database detects `SQLITE_NOTADB`/`SQLITE_CORRUPT`, moves the file to `<path>.corrupt-<timestamp>` (plus its `-wal`/`-shm` sidecars) logging to stderr, and starts with an empty index instead of crashing. On Windows the handle open by better-sqlite3 had to be closed before the file could be renamed. |
| G1 | G | The `refresh_index` description claimed *"Indexing is on-demand: nothing updates the index on its own"* — false since the startup auto-index exists. The description is the routing logic by the project's own convention: an agent that reads it triggers unnecessary full reindexes right after a startup that already refreshed. | `src/tools/refreshIndex.ts:14-15` | **[FIXED]** description updated: mentions the auto-index and when forcing makes sense. |
| G2 | G | `get_file_content` can return up to 400 KB inline (~100k tokens) into the agent's context: the size rejection is well resolved (actionable message that points to `search_project_docs`), but a 390 KB file passes the guard whole. | `src/github/octokitClient.ts:18`, `:116-121` | Lower the ceiling or add `max_chars`/offset with explicit truncation and `truncated: true`. |
| D1 | D | `guard` returned only `error.message` to the agent and wrote nothing to stderr: the stack trace of a non-domain error was lost forever. The only diagnosability blind spot — if it fails on another machine without remote access, the server log doesn't record even which tool it failed in. | `src/tools/shared.ts:16-25` | **[FIXED]** the unexpected error is logged in full to stderr before responding. |
| D3 | D | The fallback to Ollama's legacy endpoint (`/api/embeddings`, sequential loop) and the probe that activates it have no tests at all; an old Ollama on another machine would exercise exactly the untested path. | `src/rag/embeddings.ts:80-85`, `:96` | Test of the probe (404 → legacy) and of the sequential loop with an injected `fetch`. |

### Low

| ID | Cat. | Description | File/line | Suggested fix |
|---|---|---|---|---|
| C-1 | C | The `translateGitHubError` fallback for unmapped statuses (e.g. 500) returned the raw octokit error, which reaches `guard` and `console.error`. Today it doesn't leak the token because `@octokit/request-error` redacts `authorization` — but that guarantee lived in the dependency, not in this code. | `src/github/octokitClient.ts:324` | **[FIXED]** the fallback re-wraps in our own `Error` with only status and message. |
| C-2 | C | `branch` in `search_project_docs` isn't validated against anything; it can only produce 0 results. No security impact. | `src/tools/searchProjectDocs.ts` | No fix required. |
| A5 | A/G | `list_projects` did an unbounded `Promise.all` fan-out over all repos: harmless with 3, brushes against secondary limits with 20+. The same lesson `compare_status` documents and applies (4 in flight). | `src/tools/listProjects.ts:20-23` | **[FIXED]** uses the shared `mapWithLimit`. |
| A6 | A | A repo without a README costs up to 4 404 requests on every `get_project_summary` (candidates tried in sequence, no memory between calls). | `src/tools/getProjectSummary.ts:67-78` | Resolve against the tree listing, or cache "no README" in memory for the process lifetime. |
| E4 | E | `listBranches` fetches a single page (100): if `main`/`dev` don't fall in it (lexicographic order), the repo is silently left as `missing` — the real reason would be truncation. Correct today by accident (repos have few branches); as an anti-spend ceiling, the non-pagination is deliberate and fine. | `src/github/octokitClient.ts:176-180` | If `data.length === 100`, explicitly request the missing configured branches with `repos.getBranch` before declaring them missing. |
| B-3 | B | `compare_status` with `repos: []` (a plausible agent mistake) silently returns an empty comparison: `[]` isn't nullish. | `src/tools/compareStatus.ts:77` | `z.array(...).min(1)` or treat `[]` as "all". |
| B-5 | B | The branch comparator did `Date.parse(x ?? '') - Date.parse(y ?? '') || 0`: with an invalid date it gives `NaN || 0` → `0`, and the branch with no date keeps an arbitrary position instead of going to the end as the comment claims. | `src/github/octokitClient.ts:210-212` | **[FIXED]** invalid dates rank as `-Infinity`, same as `rank()` in `compare_status`. |
| B-6 | B | Binary detection only by NUL byte: UTF-16 text with a BOM is rejected as binary; a binary without NUL passes and produces mojibake without an error. Acceptable for the real corpus (markdown). The base64 decode and the size guard are fine (the guard fires before the `content: ""` that GitHub returns for > 1 MB). | `src/github/octokitClient.ts:123-128` | Mention the encoding in the rejection message. |
| B-7 | B | `assertVector` checked `typeof v !== 'number'`, and `typeof NaN === 'number'`: a vector with NaN passed and could be persisted, producing silent NaN scores on every later search. (Half of the finding that pointed to `store.ts` turned out to be incorrect on verification: that check doesn't exist there, and `normalizeVector` already rejects non-finite magnitudes.) | `src/rag/embeddings.ts:157-164` | **[FIXED]** `assertVector` uses `Number.isFinite`. |
| B-8 | B | `readMaxAgeHours` used `parseFloat`: `"12abc"` → `12` and the ignored-value warning was never emitted for that typo. | `src/rag/autoIndex.ts:130` | **[FIXED]** uses `Number(raw)`. |
| B-9 | B | There is no `process.on('unhandledRejection'/'uncaughtException')`. All audited paths are covered (three real layers around the fire-and-forget), so it's only defense in depth for future code. | `src/index.ts` | Optional: handlers that log to stderr and exit cleanly. |
| D4 | D | Ollama timeout not configurable: `OllamaOptions.timeoutMs` exists but `context.ts` never wires it from env — a fixed 60 s. On a slow machine with a cold model there's no knob without recompiling. | `src/rag/embeddings.ts:15`, `src/context.ts:34-44` | Env var `REPO_RAG_OLLAMA_TIMEOUT_MS`. |
| D5 | D | Hardcoded indexing constants: `EMBED_BATCH_SIZE`, `MAX_DOC_BYTES`, chunk size/overlap (`ChunkOptions` exists but production calls `chunkMarkdown(text)` without options — the option is dead code), `MAX_FILE_BYTES`. Chunk size/overlap are the first candidates for RAG tuning and today require touching code. | `src/rag/chunker.ts:14-15`, `src/rag/indexer.ts:53,56,271` | Expose chunk size/overlap through env or config when tuning is needed; the rest can stay. |
| D6 | D | Minor duplications: `describe(error)` in `compareStatus`/`autoIndex` + the inline pattern in 5 places; the zod schema for `repo` copied across 6 tools; failure counting duplicated between `refreshIndex` and `scripts/reindex`; `readReadme` re-resolves an already resolved alias. | various | Extract `describeError` and `repoParam` to `shared.ts` in the next pass that touches those files. |
| F4 | F | The search query has no length cap or normalization before embedding (only `min(3)`): a huge query travels whole to Ollama and the model truncates it in its own way. Low risk with agent queries. | `src/tools/searchProjectDocs.ts:28-31` | `.max()` in the schema to document the contract. |
| F5 | F | Chunking: the 150-char overlap applies only within a section — the cut at a heading carries no context (reasonable decision: the heading is a semantic boundary, noted so it isn't reported as a bug). Setext headings (`===`) aren't recognized. An unclosed code fence turns off heading detection for the rest of the file — it degrades quality, never cost. | `src/rag/chunker.ts:72`, `:109-117` | Only if a corpus with setext or broken fences appears; add a test of the raw-cut path. |
| G4 | G | `matched_by: 'keyword'` is an unreachable enum value: every chunk in the scope receives a semantic score, so `search()` only assigns `'semantic'` or `'both'`. The type promises a state that doesn't exist. | `src/rag/store.ts:40`, `:421`, `:447` | Remove the value from the type or document it. |

---

## 3. Quick wins (< 30 min each)

Already applied in this pass: **G1** (`refresh_index` description), **D1** (stderr
in `guard`), **C-1** (re-wrapping the error fallback), **B-5** (NaN comparator),
**B-7** (`Number.isFinite` in vectors), **B-8** (`Number` vs `parseFloat`), **A5**
(`mapWithLimit` in `list_projects`).

Applied in a second pass (2026-08-30): **B-2** (recovery from a corrupt
`index.db`) and **B-1** (correct message for `branch` without `repo`).

Pending, in order of value:

1. **B-3** — `min(1)` in `compare_status`.
2. **F4** — `.max()` on the search query.
3. **A3** — key the single-flight by the resolved repo.

---

## 4. Acceptable technical debt for v1

- **E2 (in-memory search)** — with the current corpus it's ~14 MB and
  milliseconds; the brute-force design is measured and documented. Revisit when
  passing ~10k chunks.
- **E3 (FTS rebuild per branch)** — milliseconds with the current corpus; it only
  hurts in massive refreshes that don't exist today.
- **E1 remainder (branch dating)** — with A1+A2 applied, the spend is bounded and
  the rate limit cuts it off; the real reduction of the count (GraphQL) is a v2
  optimization.
- **A4 (freshness brake)** — single-flight covers the concurrent case; the
  sequential one requires an agent insisting in a loop, and each extra run is
  expensive but breaks nothing.
- **F2 (removed repos)** — it only appears when taking a repo out of `repos.json`,
  which hasn't happened yet; the workaround (delete `data/index.db` and reindex) is
  trivial and the index is a cache.
- **F3 (heading in continuation chunks)** — affects only sections exceeding 1,200
  chars; the keyword half compensates with the heading's 3× weight.
- **G2 (large inline files)** — the real corpus is small markdown files; the 400 KB
  ceiling already rejects the worst with an actionable message.
- **D3/D5/D6, E4, A6, B-6, B-9, F5, G4** — polish and hardening that don't block
  initial use; none of them triggers with the current corpus and scale.

---

## 5. Corrections applied in this pass

1. **A1 / A5** — `mapWithLimit` extracted from `compare_status` to
   `src/core/concurrency.ts` and applied in `octokitClient.listBranches` (limit of
   4 in flight for the `getCommit` calls) and in `list_projects`. `compare_status`
   now imports the shared version.
2. **A2** — `RateLimitError` aborts the indexing run: the file loop rethrows it
   instead of noting it as a skipped file, and the repo loop cuts the run,
   reporting the remaining repos as skipped with the reset time. Partial failure
   still applies to every local error.
3. **F1** — the model guard chain is now closed end to end: `IndexStats` exposes
   `model`; `selectStaleRepos` treats a model different from the configured one as
   a stale index (the auto-index self-heals); and `search_project_docs` checks the
   index's model in the scope before searching and fails with an actionable
   message ("rebuilt with refresh_index") on a mismatch — for the case where the
   auto-index is off.
4. **D2** — `normalizePath` exported (`translateGitHubError` already was) and both
   covered in `test/octokitClient.test.ts` (11 tests): 401 → `PermissionError`,
   403 with `x-ratelimit-remaining: 0` → `RateLimitError` with `resetAt`, 403
   without headers → `PermissionError`, 404 → `NotFoundError`, 409 (empty repo) →
   `NotFoundError`, 429 → `RateLimitError`, unmapped status → error re-wrapped
   without the octokit object; `normalizePath`: leading slashes, rejection of `..`
   and of empty.
5. **Quick wins** — G1, D1, C-1, B-5, B-7, B-8 as per the table.

Verified after the changes: **96 tests green** (83 baseline + 13 new),
`typecheck`, `typecheck:test` and `build` clean.

**Second pass (2026-08-30):**

6. **B-2** — `VectorStore.open` tries to open the database normally; if
   better-sqlite3 fails with `SQLITE_NOTADB`/`SQLITE_CORRUPT` (the error only
   surfaces on the first real statement, not in `new Database(...)`), it closes the
   handle, moves the file and its WAL/SHM sidecars to `<path>.corrupt-<timestamp>`
   logging to stderr, and opens a new database. The index remains a disposable
   cache — the same policy `migrate()` already applies on a `SCHEMA_VERSION` bump.
7. **B-1** — `describeEmptyScope` now distinguishes, for `branch` without `repo`,
   between "nothing is indexed anywhere" (original message) and "that branch
   doesn't exist but others do" (lists the globally indexed branches).

Verified after the second pass: **98 tests green** (+2), `typecheck`,
`typecheck:test` and `build` clean.
