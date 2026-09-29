# Roadmap

🌐 **English** | [Español](../../ROADMAP.md)

## v1 — current

Closed scope: read-only, on-demand multi-branch indexing, static configuration.

### Tools

| Tool | What it does | Source |
|---|---|---|
| `list_projects` | Lists the configured repos with description, latest activity and index status | Live |
| `get_project_status` | Branch, latest commit, open PRs and issues | Live |
| `get_recent_commits` | Last N raw commits (default 10) | Live |
| `search_project_docs` | **Hybrid** search (meaning + exact word) over the indexed documentation, filterable by branch | Index |
| `refresh_index` | Reindexes one or all repos, across all their branches | Writes local index |
| `get_project_summary` | Status + the beginning of the README in a single call | Live |
| `get_file_content` | A complete file, not chunked, from any branch | Live |
| `list_branches` | The repo's branches with latest activity and whether they are indexed | Live |

v2 added a ninth tool, `compare_status`. See below.

### Decisions made

- Vector store in plain SQLite with cosine similarity in JS, without `sqlite-vec`
  (avoids native compilation on Windows; the volume doesn't justify it).
- Local embeddings with Ollama, no SDK: `POST /api/embed` with automatic fallback
  to `/api/embeddings` for old versions.
- `repos.json` for configuration (no longer versioned: only `repos.example.json`); `.env` only for the token.
- A repo that fails doesn't abort the rest, and a branch that fails doesn't abort
  the other branches of the same repo: the error is reported at the level where it
  occurred.
- Multi-branch indexing by convention (`main` production, `dev` replica) plus an
  optional window of recently active branches, because the documentation of
  in-progress work doesn't reach `main`.
- Identical content across several branches is collapsed into a single result that
  lists all its branches; otherwise a repo with six active branches fills the top-k
  with copies of the same fragment.
- The index is a derived cache: a schema change discards it and asks for a
  reindex, instead of carrying a fragile migration.
- **Hybrid search** — SQLite's FTS5/BM25 fused with cosine similarity via
  Reciprocal Rank Fusion. RRF was chosen because a cosine similarity and a BM25
  score are on incomparable scales: any attempt to normalize them to a single
  number needs permanent recalibration, and ranks need none. Reason measured at
  the time: an indexed document didn't show up even with an almost verbatim query,
  because all the scores fell between 0.72 and 0.76. **Superseded**: with the
  current corpus the cosines range from 0.30 to 0.83. What justifies the hybrid
  today is the measurement on real questions, not that range.
- The FTS index is rebuilt entirely on every write instead of being maintained
  incrementally: an external-content FTS5 table needs the original values to
  delete a row, and at this scale the rebuild costs milliseconds and can't get out
  of sync.
- `MIN_SCORE` was removed: with fused ranks, a threshold on cosine stopped making
  sense. `limit` does the trimming.

### Out of scope for v1

- Any write tool (creating issues, commenting, approving PRs).
- Real-time indexing or change watching.
- Multi-user or auth beyond the local PAT.

---

## v2 — in progress

### Done

- **Incremental indexing** — embedding cache in SQLite, keyed by
  `(model, content_hash)` where the hash is the sha256 of the chunk's TEXT. A text
  that has already been embedded is never embedded again.

  Caching by the git blob `sha` (which was the original idea) was discarded: the
  content hash has chunk granularity instead of file granularity, doesn't need a
  per-branch file table or row copying, and is self-validating — the same text
  always yields the same vector, so there is nothing to invalidate and a chunker
  change invalidates itself.

  The `model` goes in the primary key, and that is where all the table's
  correctness lies: two models can match in number of dimensions
  (`nomic-embed-text` and `bge-m3` do), so the `dimensions` guard would let one
  model's vector be served as another's without a single error. The index would
  look healthy and every search would be silently wrong.

  Measured on the real index: a full refresh embedded 2790 chunks of which only
  767 are distinct texts — 72.5% of the work was redundant WITHIN a single run,
  because `main`, `dev` and the feature branches share almost all their files. A
  refresh with no changes goes from 2790 embeddings to 0.

  There is no expiration policy: the number of rows is bounded by the distinct text
  of a few markdown files, and expiring would throw away precisely the entries most
  likely to be needed again, those of a branch that reappears.

  It still downloads all files from GitHub. What disappears are the Ollama
  minutes. Skipping the download using the `sha` that `listTree` already returns is
  a different optimization, and it is only worth it if, when measuring again, the
  network turns out to be the bottleneck.

- **Measured and discarded**: the suspicion that `rebuildKeywordIndex` (full FTS
  rebuild on every branch write) would become expensive with incremental indexing.
  15 full rebuilds over the real index add up to 504 ms against a reindex that
  takes minutes. It stays as it is: its guarantee of not being able to get out of
  sync is worth more than half a second.

- **Automatic indexing** — on startup, the server reindexes in the background every
  repo whose index is stale. Window in `REPO_RAG_AUTO_INDEX_HOURS` (default 12,
  `0` disables).

  "Stale" is decided **per repo**, not globally, and a repo with no recorded run
  counts as stale. That is the case that matters most: it covers a repo just added
  to `repos.json` and an index discarded by a `SCHEMA_VERSION` bump, which are the
  two silent ways of ending up without indexed documentation. The decision lives in
  a pure function (`src/rag/staleness.ts`) with no database or clock inside, so
  each rule is tested with three literals.

  It fires after `server.connect(transport)` and **without `await`**: the MCP
  handshake can't wait on GitHub or Ollama, and the tools keep answering from the
  old index while it runs. It never throws outward — a server that answers with a
  stale index is far better than one that doesn't start.

  Repos are refreshed in sequence, never with `Promise.all`: parallelizing would
  multiply the pressure on GitHub's rate limit and on Ollama right when the agent
  starts asking questions, and gains nothing because this already runs in the
  background.

- **Single-flight in `Indexer`** — at most one refresh at a time. A second request
  for the same scope receives the SAME promise instead of starting a duplicate run,
  so it still gets a real report. The guard lives in `Indexer` and not in the
  scheduler on purpose: the scheduler, the `refresh_index` tool and `pnpm reindex`
  all go through the same method, so a guard placed in any one of them is bypassed
  by the other two.

  The in-flight entry is cleared in `finally`. If it were cleared only on the happy
  path, a failed run would leave a rejected promise parked under that scope and
  hand it to everyone who asks afterwards — that is, one failure would disable
  refresh for that repo forever.

- **Hybrid search measured** — over six real usage questions
  (`docs/evaluacion-respuestas-conversacion.md`) against the real corpus. See the
  full table in `CLAUDE.md`. The essentials: with `nomic-embed-text` the hybrid was
  **worse than BM25 alone**, so the semantic half contributed nothing.

- **Embedding model switched to `bge-m3`** — multilingual, and that was the
  failure: Spanish queries against a mixed Spanish/English corpus with an
  English-centric model. Semantic alone went from hit@5 2/6 to 4/6, and the real
  BILLING question from position 146 to 3. Only with this model does the hybrid
  beat BM25 alone, which means the fusion finally justifies its complexity. It
  costs 2.3x more per chunk (cold reindex from ~3 to ~7 min); warm refreshes don't
  notice because the cache absorbs them.

- **`RRF_K` stays at 60.** Three independent sweeps agree that between K=0 and
  K=60 the hit rates don't move. A question set I wrote myself suggested lowering
  it; the real questions refuted it. That is the reason the evaluation set is not
  invented by reading the corpus.

- **`compare_status(repos[])`** — live status of several repos in one call,
  ordered by most recent activity. Three decisions that are not obvious:

  **Concurrency bounded to 4 repos in flight, not `Promise.all`.**
  `getProjectStatus` already fires 4 internal calls per repo, so N repos without a
  limit are 4N simultaneous requests. GitHub's secondary limits trigger on
  concurrency, not on total volume: with 3 repos nothing happens and with 15 a
  block suddenly appears.

  **Returns facts, not interpretations.** It exposes
  `days_since_default_branch_commit`, `days_since_any_activity` and the gap between
  them, which is arithmetic. There is no boolean like `is_stale`: a boolean hides a
  threshold that someone chose and takes away the agent's ability to calibrate.

  **The gap is the useful signal.** It is work that lives on branches and hasn't
  reached the default branch. Measured against the real repos the day it was
  implemented: `project-c` showed 37 days since the last commit on `main`
  against 2 days since the last push — a 35-day gap. That same finding, in the
  conversation that motivated the tool, had to be reasoned out by hand.

  It includes `checked_at`: a "3 days ago" without a timestamp is indistinguishable
  from a stale read.

### Pending

- **PR comments** — fetch the discussion of an open PR when explicitly requested.
  It is still read-only.
- **Date filter in `get_recent_commits`** (`since` / `until`).
- **Deduplicate by file, not just by chunk** — today a single document can occupy
  several top-k slots with different fragments.

---

## v3 — open ideas

- **Extend the RAG beyond the repos** — vendor documentation, regulations,
  internal manuals.
- **Integration with the task-tracker MCP** — cross-reference task status with repo
  status: "this task says in review but the PR has been unopened for two weeks".
- **Reranking** — a second pass over the retrieved chunks with a smaller model, to
  improve precision when the corpus grows.
- **Migrate to `sqlite-vec`** if the corpus grows to the point where brute force
  becomes a nuisance. Today it isn't.
