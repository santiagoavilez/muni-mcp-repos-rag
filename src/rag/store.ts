import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { fromProjectRoot } from '../core/paths.js';

export interface ChunkRecord {
  repo: string;
  alias: string;
  branch: string;
  path: string;
  chunk_index: number;
  heading: string;
  content: string;
  embedding: number[];
}

export interface SearchHit {
  repo: string;
  alias: string;
  /**
   * Every branch this exact content appears on, configured branches first.
   * Identical content across branches is ONE result, not N — otherwise a repo
   * with six active branches fills the whole top-k with copies of one chunk.
   */
  branches: string[];
  path: string;
  heading: string;
  content: string;
  /**
   * Fused rank score. Not a similarity and not comparable across queries —
   * only the ordering within one result set is meaningful.
   */
  score: number;
  /** Cosine similarity in [-1, 1]. Higher is closer. */
  semantic_score: number;
  /** Rank in the keyword search, 1-based. Null when no keyword matched. */
  keyword_rank: number | null;
  /** How this result was found — useful for explaining an answer. */
  matched_by: 'both' | 'semantic' | 'keyword';
  indexed_at: string;
}

export interface IndexStats {
  repo: string;
  branch: string;
  /** Embedding model the branch was indexed with. */
  model: string;
  chunks: number;
  files: number;
  indexed_at: string;
}

export interface SearchScope {
  repo?: string;
  branch?: string;
}

/**
 * Vector store on plain SQLite.
 *
 * No sqlite-vec: it needs a native extension that is awkward to build on the
 * Windows machine this runs on, and the corpus here is a handful of markdown
 * files per repo. Vectors are stored as Float32 blobs and scored with a brute
 * force dot product in JS — at a few thousand chunks that is sub-millisecond,
 * and it has no build step to go wrong.
 *
 * Every vector is L2-normalised on write, so cosine similarity IS the dot
 * product at query time.
 */
/** Bumped whenever the chunks/index_runs/embedding_cache shape changes. */
const SCHEMA_VERSION = 4;

/**
 * Reciprocal Rank Fusion constant. 60 is the value from the original paper and
 * the usual default; it damps the influence of the very top ranks just enough
 * that one list cannot dominate the other.
 */
const RRF_K = 60;

/** How many keyword hits to pull before fusing. */
const KEYWORD_CANDIDATES = 200;

export class VectorStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const resolved = fromProjectRoot(dbPath);
    mkdirSync(dirname(resolved), { recursive: true });

    this.db = new Database(resolved);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    // The index is a derived cache, never a source of truth: a schema change
    // drops it and asks for a reindex instead of carrying a fragile migration.
    //
    // The check is the actual table shape, not user_version: the first release
    // never stamped a version, so an existing index from it reads as 0 and
    // would otherwise be mistaken for a fresh database.
    const columns = this.db.pragma('table_info(chunks)') as { name: string }[];
    const version = (this.db.pragma('user_version', { simple: true }) as number) ?? 0;
    const isStaleSchema = columns.length > 0 && version < SCHEMA_VERSION;

    if (isStaleSchema) {
      this.db.exec(
        'DROP TABLE IF EXISTS chunks_fts; DROP TABLE IF EXISTS chunks; ' +
          'DROP TABLE IF EXISTS index_runs; DROP TABLE IF EXISTS embedding_cache;'
      );
      console.error(
        '[store] index schema upgraded; the previous index was dropped. ' +
          'Run refresh_index (or `pnpm reindex`) to rebuild it.'
      );
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id          INTEGER PRIMARY KEY,
        repo        TEXT    NOT NULL,
        alias       TEXT    NOT NULL,
        branch      TEXT    NOT NULL,
        path        TEXT    NOT NULL,
        chunk_index INTEGER NOT NULL,
        heading     TEXT    NOT NULL DEFAULT '',
        content     TEXT    NOT NULL,
        embedding   BLOB    NOT NULL,
        dimensions  INTEGER NOT NULL,
        indexed_at  TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_repo ON chunks(repo);
      CREATE INDEX IF NOT EXISTS idx_chunks_repo_branch ON chunks(repo, branch);

      CREATE TABLE IF NOT EXISTS index_runs (
        repo        TEXT NOT NULL,
        branch      TEXT NOT NULL,
        model       TEXT NOT NULL,
        files       INTEGER NOT NULL,
        chunks      INTEGER NOT NULL,
        indexed_at  TEXT NOT NULL,
        PRIMARY KEY (repo, branch)
      );

      -- Embeddings already computed for a piece of text, keyed by its hash.
      --
      -- The same file lives on main, on dev and on every feature branch cut
      -- from them: measured on the real index, a full refresh embeds 2790
      -- chunks of which only 767 are distinct texts. Everything else is the
      -- same paragraph asked for again, and the model answers it again.
      --
      -- The model is PART OF THE KEY, and that is the whole correctness of this
      -- table. Two models can agree on the dimension count -- nomic-embed-text
      -- and bge-m3 both do -- so the "dimensions" guard at query time would let
      -- one model's vector be served as the other's without a single error:
      -- the index would look healthy and every search result would be quietly
      -- wrong. Keying on the hash alone is the one mistake here that cannot be
      -- noticed from the outside.
      --
      -- Nothing is ever evicted. The row count is bounded by the distinct text
      -- of a few markdown files, and an eviction policy would throw away
      -- exactly the entries most likely to be wanted again -- the ones from a
      -- branch that comes back.
      CREATE TABLE IF NOT EXISTS embedding_cache (
        model        TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        embedding    BLOB NOT NULL,
        dimensions   INTEGER NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (model, content_hash)
      );

      -- Keyword half of the hybrid search. Embeddings are blind to rare exact
      -- tokens ("BILLING", an tramite number, a class name); BM25 finds
      -- those instantly. It is an external-content table keyed on chunks.id,
      -- so the text is stored once.
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        heading,
        path,
        content,
        content='chunks',
        content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );
    `);

    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * Replaces every chunk of one repo in a single transaction: a failed refresh
   * leaves the previous index intact rather than half-deleted.
   */
  replaceBranch(
    repo: string,
    branch: string,
    records: ChunkRecord[],
    model: string,
    files: number
  ): void {
    const now = new Date().toISOString();

    const remove = this.db.prepare('DELETE FROM chunks WHERE repo = ? AND branch = ?');
    const insert = this.db.prepare(`
      INSERT INTO chunks (repo, alias, branch, path, chunk_index, heading, content, embedding, dimensions, indexed_at)
      VALUES (@repo, @alias, @branch, @path, @chunk_index, @heading, @content, @embedding, @dimensions, @indexed_at)
    `);
    const recordRun = this.db.prepare(`
      INSERT INTO index_runs (repo, branch, model, files, chunks, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo, branch) DO UPDATE SET
        model = excluded.model,
        files = excluded.files,
        chunks = excluded.chunks,
        indexed_at = excluded.indexed_at
    `);

    const write = this.db.transaction((rows: ChunkRecord[]) => {
      remove.run(repo, branch);
      for (const row of rows) {
        const normalized = normalizeVector(row.embedding);
        insert.run({
          repo: row.repo,
          alias: row.alias,
          branch: row.branch,
          path: row.path,
          chunk_index: row.chunk_index,
          heading: row.heading,
          content: row.content,
          embedding: Buffer.from(new Float32Array(normalized).buffer),
          dimensions: normalized.length,
          indexed_at: now
        });
      }
      recordRun.run(repo, branch, model, files, rows.length, now);
      this.rebuildKeywordIndex();
    });

    write(records);
  }

  /**
   * Looks up already-computed embeddings for one model. Only hits come back, so
   * the caller can treat "absent from the map" as "must be embedded".
   */
  cachedEmbeddings(model: string, hashes: string[]): Map<string, number[]> {
    const found = new Map<string, number[]>();
    if (hashes.length === 0) return found;

    // Asked for one hash at a time on purpose: an IN list has to stay under
    // SQLite's parameter limit, and a prepared single-row lookup over a primary
    // key is already an index seek — the loop costs nothing worth avoiding.
    const select = this.db.prepare(
      'SELECT embedding, dimensions FROM embedding_cache WHERE model = ? AND content_hash = ?'
    );

    for (const hash of new Set(hashes)) {
      const row = select.get(model, hash) as
        | { embedding: Buffer; dimensions: number }
        | undefined;
      if (!row) continue;

      // readFloatLE, not a Float32Array view, for the same reason as in search:
      // SQLite hands back Buffers that are not guaranteed to be 4-byte aligned.
      const vector: number[] = [];
      for (let i = 0; i < row.dimensions; i += 1) vector.push(row.embedding.readFloatLE(i * 4));
      found.set(hash, vector);
    }

    return found;
  }

  /**
   * Remembers freshly computed embeddings.
   *
   * The vector is stored exactly as the provider returned it: `replaceBranch`
   * normalises on its way into `chunks`, and doing it here as well would leave
   * two places claiming to own the same invariant.
   */
  cacheEmbeddings(model: string, entries: { content_hash: string; embedding: number[] }[]): void {
    if (entries.length === 0) return;
    const now = new Date().toISOString();

    // DO NOTHING rather than an update: an entry for this model and this text
    // is by definition the same vector, so a rewrite would only cost pages.
    const insert = this.db.prepare(`
      INSERT INTO embedding_cache (model, content_hash, embedding, dimensions, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(model, content_hash) DO NOTHING
    `);

    const write = this.db.transaction((rows: { content_hash: string; embedding: number[] }[]) => {
      for (const row of rows) {
        insert.run(
          model,
          row.content_hash,
          Buffer.from(new Float32Array(row.embedding).buffer),
          row.embedding.length,
          now
        );
      }
    });

    write(entries);
  }

  /**
   * Rebuilds the FTS index from `chunks`.
   *
   * An external-content FTS5 table needs the ORIGINAL row values to delete a
   * row, which every delete path here would have to carry around. A full
   * rebuild is one statement, cannot drift out of sync, and at a few thousand
   * chunks costs milliseconds — the safer trade at this size.
   */
  private rebuildKeywordIndex(): void {
    this.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
  }

  /**
   * Forgets branches that are no longer configured (merged, deleted, or fallen
   * out of the active window), so a stale feature branch cannot keep answering
   * questions after it is gone.
   */
  pruneBranches(repo: string, keep: string[]): number {
    if (keep.length === 0) return 0;
    const placeholders = keep.map(() => '?').join(', ');

    const prune = this.db.transaction(() => {
      const removed = this.db
        .prepare(`DELETE FROM chunks WHERE repo = ? AND branch NOT IN (${placeholders})`)
        .run(repo, ...keep);
      this.db
        .prepare(`DELETE FROM index_runs WHERE repo = ? AND branch NOT IN (${placeholders})`)
        .run(repo, ...keep);
      if (removed.changes > 0) this.rebuildKeywordIndex();
      return removed.changes;
    });

    return prune();
  }

  /**
   * Hybrid search: semantic (brute force cosine) fused with keyword (BM25).
   *
   * Neither half is enough on its own here. Embeddings answer "what is this
   * about" but, measured on this corpus, score everything between 0.72 and 0.76
   * — a document can be indexed and still never surface. BM25 nails a rare
   * exact token ("BILLING", an tramite number, a class name) and is useless
   * for a paraphrase.
   *
   * The two are combined with Reciprocal Rank Fusion, which uses only each
   * result's RANK in its own list. That matters: a cosine similarity and a BM25
   * score are on incomparable scales, and any attempt to normalise them into
   * one number needs constant recalibration. Ranks need none.
   */
  search(queryEmbedding: number[], limit: number, scope: SearchScope = {}, text = ''): SearchHit[] {
    const query = normalizeVector(queryEmbedding);

    const filters: string[] = [];
    const params: string[] = [];
    if (scope.repo) {
      filters.push('repo = ?');
      params.push(scope.repo);
    }
    if (scope.branch) {
      filters.push('branch = ?');
      params.push(scope.branch);
    }
    const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';

    const rows = this.db
      .prepare(
        'SELECT id, repo, alias, branch, path, heading, content, embedding, dimensions, indexed_at FROM chunks' +
          where
      )
      .all(...params);

    const keywordRankByChunkId = this.keywordRanks(text, scope);

    /** chunk id -> group key, so keyword ranks survive the dedup step. */
    const groupOfChunk = new Map<number, string>();

    const grouped = new Map<string, SearchHit>();
    for (const raw of rows as StoredRow[]) {
      // A dimension mismatch means the row was written by a different embedding
      // model. Scoring it would be meaningless, so it is skipped until reindexed.
      if (raw.dimensions !== query.length) continue;

      // Read straight out of the blob with readFloatLE: SQLite hands back
      // Buffers that are views into a pooled allocation and are not guaranteed
      // to be 4-byte aligned, which is exactly what a Float32Array view rejects.
      let score = 0;
      for (let i = 0; i < query.length; i += 1) {
        score += query[i]! * raw.embedding.readFloatLE(i * 4);
      }

      // Identical content on several branches collapses into one hit. The key
      // is the content itself, not the path: the same file with a change on a
      // feature branch is genuinely a different answer and must stay separate.
      const key = groupKey(raw.repo, raw.path, raw.content);
      groupOfChunk.set(raw.id, key);

      const existing = grouped.get(key);
      if (existing) {
        existing.branches.push(raw.branch);
        // The rows are identical, so the scores are too; max() only guards
        // against float noise from reading two different blobs.
        existing.semantic_score = Math.max(existing.semantic_score, score);
        if (raw.indexed_at > existing.indexed_at) existing.indexed_at = raw.indexed_at;
        continue;
      }

      grouped.set(key, {
        repo: raw.repo,
        alias: raw.alias,
        branches: [raw.branch],
        path: raw.path,
        heading: raw.heading,
        content: raw.content,
        score: 0,
        semantic_score: score,
        keyword_rank: null,
        matched_by: 'semantic',
        indexed_at: raw.indexed_at
      });
    }

    // Best keyword rank wins for a group: the same text on two branches is two
    // chunk ids, and the group deserves the better of the two positions.
    for (const [chunkId, rank] of keywordRankByChunkId) {
      const hit = grouped.get(groupOfChunk.get(chunkId) ?? '');
      if (!hit) continue;
      hit.keyword_rank = hit.keyword_rank === null ? rank : Math.min(hit.keyword_rank, rank);
    }

    const hits = [...grouped.values()];
    for (const hit of hits) hit.branches.sort(compareBranches);

    // Semantic ranks are assigned after dedup, so the positions match the list
    // the caller actually sees.
    const bySemantic = [...hits].sort((a, b) => b.semantic_score - a.semantic_score);
    const semanticRank = new Map(bySemantic.map((hit, at) => [hit, at + 1]));

    for (const hit of hits) {
      const fromSemantic = 1 / (RRF_K + (semanticRank.get(hit) ?? Number.MAX_SAFE_INTEGER));
      const fromKeyword = hit.keyword_rank === null ? 0 : 1 / (RRF_K + hit.keyword_rank);

      hit.score = fromSemantic + fromKeyword;
      hit.matched_by = hit.keyword_rank === null ? 'semantic' : 'both';
    }

    hits.sort((a, b) => b.score - a.score || b.semantic_score - a.semantic_score);
    return hits.slice(0, limit);
  }

  /**
   * Runs the keyword half and returns chunk id -> 1-based rank.
   *
   * An empty or unusable query yields no ranks, which degrades the search to
   * pure semantic rather than failing: the caller always gets an answer.
   */
  private keywordRanks(text: string, scope: SearchScope): Map<number, number> {
    const ranks = new Map<number, number>();

    const match = toFtsQuery(text);
    if (match === null) return ranks;

    const filters = ['chunks_fts MATCH ?'];
    const params: (string | number)[] = [match];
    if (scope.repo) {
      filters.push('chunks.repo = ?');
      params.push(scope.repo);
    }
    if (scope.branch) {
      filters.push('chunks.branch = ?');
      params.push(scope.branch);
    }

    try {
      // A heading match weighs more than body text: a term in a heading is what
      // that section is ABOUT, not a passing mention.
      const rows = this.db
        .prepare(
          `SELECT chunks.id AS id
             FROM chunks_fts
             JOIN chunks ON chunks.id = chunks_fts.rowid
            WHERE ${filters.join(' AND ')}
            ORDER BY bm25(chunks_fts, 3.0, 1.0, 1.0)
            LIMIT ${KEYWORD_CANDIDATES}`
        )
        .all(...params) as { id: number }[];

      rows.forEach((row, at) => ranks.set(row.id, at + 1));
    } catch {
      // A malformed MATCH expression must never take the whole search down.
      return new Map();
    }

    return ranks;
  }

  stats(): IndexStats[] {
    return this.db
      .prepare(
        'SELECT repo, branch, model, chunks, files, indexed_at FROM index_runs ORDER BY repo, branch'
      )
      .all() as IndexStats[];
  }

  /** Every indexed branch of one repo. Empty when the repo was never indexed. */
  statsFor(repo: string): IndexStats[] {
    return this.db
      .prepare(
        'SELECT repo, branch, model, chunks, files, indexed_at FROM index_runs ' +
          'WHERE repo = ? ORDER BY branch'
      )
      .all(repo) as IndexStats[];
  }

  /**
   * Distinct embedding models recorded in `index_runs`, optionally for one
   * repo. More than one entry — or one entry that is not the configured model —
   * means part of the index was built by a different model, which a dimension
   * check cannot catch when the two models agree on the dimension count.
   */
  indexedModels(repo?: string): string[] {
    const rows = repo
      ? this.db.prepare('SELECT DISTINCT model FROM index_runs WHERE repo = ?').all(repo)
      : this.db.prepare('SELECT DISTINCT model FROM index_runs').all();
    return (rows as { model: string }[]).map(row => row.model);
  }

  totalChunks(scope: SearchScope = {}): number {
    const filters: string[] = [];
    const params: string[] = [];
    if (scope.repo) {
      filters.push('repo = ?');
      params.push(scope.repo);
    }
    if (scope.branch) {
      filters.push('branch = ?');
      params.push(scope.branch);
    }
    const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';

    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM chunks${where}`).get(...params);
    return (row as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}

interface StoredRow {
  id: number;
  repo: string;
  alias: string;
  branch: string;
  path: string;
  heading: string;
  content: string;
  embedding: Buffer;
  dimensions: number;
  indexed_at: string;
}

/**
 * Identity of a deduplicated result. The separator is a control character on
 * purpose: it cannot occur in a repo name, a path or markdown, so two different
 * documents can never collide into one group.
 */
function groupKey(repo: string, path: string, content: string): string {
  return [repo, path, content].join('\u0000');
}

/**
 * Turns a natural-language question into an FTS5 MATCH expression.
 *
 * FTS5 has its own query syntax, so raw user text is a syntax error waiting to
 * happen: quotes, hyphens, parentheses and bare AND/OR/NOT all mean something.
 * Every term is therefore extracted and re-quoted, and joined with OR so that
 * matching some terms still ranks — an AND of every word would return nothing
 * for a normal sentence.
 */
export function toFtsQuery(text: string): string | null {
  const terms = text
    .toLowerCase()
    // Keep letters, digits and accents; everything else is a separator.
    .split(/[^\p{L}\p{N}]+/u)
    .filter(term => term.length >= MIN_KEYWORD_LENGTH)
    .filter(term => !STOPWORDS.has(term));

  if (terms.length === 0) return null;

  // Quoting makes each term a literal string, immune to FTS5 operators.
  return [...new Set(terms)].map(term => `"${term}"`).join(' OR ');
}

/** One- and two-letter tokens carry no signal and blow up the candidate set. */
const MIN_KEYWORD_LENGTH = 3;

/**
 * Spanish and English function words. Without this, "como se hace el pago"
 * matches every document that contains "como" — which is all of them — and the
 * keyword half stops discriminating.
 */
const STOPWORDS = new Set([
  'como', 'para', 'por', 'que', 'con', 'del', 'las', 'los', 'una', 'uno', 'unos',
  'unas', 'esta', 'este', 'esto', 'estos', 'estas', 'donde', 'cuando', 'cual',
  'cuales', 'sobre', 'entre', 'desde', 'hasta', 'hace', 'hacer', 'ser', 'son',
  'era', 'fue', 'muy', 'mas', 'pero', 'porque', 'sus', 'nos', 'les', 'the',
  'and', 'for', 'with', 'from', 'that', 'this', 'what', 'when', 'where', 'which',
  'how', 'are', 'was', 'were', 'has', 'have', 'its'
]);

/** Production and replica first; feature branches after, alphabetically. */
const BRANCH_PRIORITY = ['main', 'master', 'dev', 'develop'];

function compareBranches(a: string, b: string): number {
  const rankA = BRANCH_PRIORITY.indexOf(a);
  const rankB = BRANCH_PRIORITY.indexOf(b);
  if (rankA !== -1 || rankB !== -1) {
    return (rankA === -1 ? Number.MAX_SAFE_INTEGER : rankA) -
      (rankB === -1 ? Number.MAX_SAFE_INTEGER : rankB);
  }
  return a.localeCompare(b);
}

/**
 * Cache key for a piece of text. Lives here so the indexer and the store can
 * never disagree about what "the same text" means — a second implementation of
 * this one line would turn every cache hit into a coin toss.
 */
export function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** L2 normalisation, so cosine similarity reduces to a dot product. */
export function normalizeVector(vector: number[]): number[] {
  let sumOfSquares = 0;
  for (const value of vector) sumOfSquares += value * value;

  const magnitude = Math.sqrt(sumOfSquares);
  // A zero vector has no direction; returning it unchanged scores it at 0
  // against everything, which is the honest answer.
  if (magnitude === 0 || !Number.isFinite(magnitude)) return vector;

  return vector.map(value => value / magnitude);
}
