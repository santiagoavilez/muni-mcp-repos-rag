import {
  ConfiguredRepo,
  ReposConfig,
  isGlobPattern,
  isMarkdown,
  matchesDocPattern
} from '../config/repos.js';
import { NotFoundError } from '../core/errors.js';
import { GitHubClient } from '../github/types.js';
import { chunkMarkdown } from './chunker.js';
import { EmbeddingProvider } from './embeddings.js';
import { ChunkRecord, VectorStore, hashContent } from './store.js';

export interface BranchIndexResult {
  branch: string;
  files: number;
  chunks: number;
  /** Distinct texts the provider had to embed on this run. */
  embedded_chunks: number;
  /**
   * Distinct texts answered from the embedding cache. Counted per text, not
   * per chunk: the point of the number is how much work the provider was
   * spared, and one cached vector serves every chunk that repeats that text.
   */
  reused_chunks: number;
  /** True when the branch was picked up by the recent-activity window. */
  active: boolean;
  skipped: string[];
  error: string | null;
}

export interface RepoIndexResult {
  repo: string;
  alias: string;
  branches: BranchIndexResult[];
  files: number;
  chunks: number;
  embedded_chunks: number;
  reused_chunks: number;
  /** Configured branches that do not exist in this repo. Not an error. */
  missing_branches: string[];
  pruned_branches: number;
  error: string | null;
}

export interface IndexReport {
  model: string;
  results: RepoIndexResult[];
  indexed_at: string;
}

/** How many chunks are embedded per Ollama round trip. */
const EMBED_BATCH_SIZE = 16;

/** Anything past this is a data dump, not documentation. */
const MAX_DOC_BYTES = 300_000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Single-flight key for a refresh of every configured repo. The angle brackets
 * are illegal in an alias, a repo name and an "owner/repo", so this sentinel
 * can never be confused with a real scope.
 */
const ALL_REPOS = '<all-repos>';

/** Per-branch tally of how much of the work the cache took off the provider. */
interface EmbedCounters {
  embedded: number;
  reused: number;
}

export class Indexer {
  constructor(
    private readonly config: ReposConfig,
    private readonly github: GitHubClient,
    private readonly embeddings: EmbeddingProvider,
    private readonly store: VectorStore
  ) {}

  /** Refreshes already running, by scope. See `refresh`. */
  private readonly inFlight = new Map<string, Promise<IndexReport>>();

  /**
   * Tail of the serialised queue. Always a settled-or-pending promise that
   * NEVER rejects, so one failed refresh cannot stall the ones behind it.
   */
  private queue: Promise<void> = Promise.resolve();

  /**
   * Reindexes one repo, or every configured repo when `reference` is omitted.
   *
   * One repo failing does NOT abort the run: the failure is reported per repo
   * and the others still get indexed, because a single unreachable repo should
   * not leave the user with no index at all. The same holds per branch.
   *
   * Only one refresh ever executes at a time, and a second caller asking for a
   * scope that is already running joins it instead of starting a duplicate —
   * it gets the very same IndexReport rather than an error, because from its
   * point of view the work it asked for did happen.
   *
   * The guard lives HERE and not in whatever schedules a refresh: the startup
   * scheduler, the refresh_index tool and `pnpm reindex` all arrive through
   * this method, so a guard placed in any one of them is bypassed by the other
   * two — and two concurrent runs mean double the GitHub requests, double the
   * Ollama load, and two transactions rewriting the same branch.
   */
  async refresh(reference?: string): Promise<IndexReport> {
    const scope = reference ?? ALL_REPOS;

    const running = this.inFlight.get(scope);
    if (running) return running;

    const started = this.queue.then(() => this.runRefresh(reference));
    // Cleared in `finally`, on success AND on failure: a rejected promise left
    // parked under this scope would be handed to every later caller forever,
    // so one failed run would permanently disable refreshing that repo.
    const tracked = started.finally(() => {
      if (this.inFlight.get(scope) === tracked) this.inFlight.delete(scope);
    });

    this.inFlight.set(scope, tracked);
    // The failure is already delivered to whoever awaited `tracked`; the queue
    // only orders the runs, so it swallows it rather than propagating it to an
    // unrelated refresh (and rather than becoming an unhandled rejection).
    this.queue = tracked.then(
      () => undefined,
      () => undefined
    );

    return tracked;
  }

  private async runRefresh(reference?: string): Promise<IndexReport> {
    const targets = reference ? [this.config.resolve(reference)] : this.config.all;
    const results: RepoIndexResult[] = [];

    for (const target of targets) {
      try {
        results.push(await this.refreshRepo(target));
      } catch (error) {
        results.push({
          repo: target.fullName,
          alias: target.alias,
          branches: [],
          files: 0,
          chunks: 0,
          embedded_chunks: 0,
          reused_chunks: 0,
          missing_branches: [],
          pruned_branches: 0,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return { model: this.embeddings.model, results, indexed_at: new Date().toISOString() };
  }

  private async refreshRepo(target: ConfiguredRepo): Promise<RepoIndexResult> {
    const plan = await this.planBranches(target);
    const branches: BranchIndexResult[] = [];

    for (const branch of plan.index) {
      try {
        branches.push(await this.refreshBranch(target, branch.name, branch.active));
      } catch (error) {
        branches.push({
          branch: branch.name,
          files: 0,
          chunks: 0,
          embedded_chunks: 0,
          reused_chunks: 0,
          active: branch.active,
          skipped: [],
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const indexed = branches.filter(branch => branch.error === null).map(branch => branch.branch);
    const pruned = indexed.length > 0 ? this.store.pruneBranches(target.fullName, indexed) : 0;

    return {
      repo: target.fullName,
      alias: target.alias,
      branches,
      files: branches.reduce((total, branch) => total + branch.files, 0),
      chunks: branches.reduce((total, branch) => total + branch.chunks, 0),
      embedded_chunks: branches.reduce((total, branch) => total + branch.embedded_chunks, 0),
      reused_chunks: branches.reduce((total, branch) => total + branch.reused_chunks, 0),
      missing_branches: plan.missing,
      pruned_branches: pruned,
      error: null
    };
  }

  /**
   * Decides which branches to index.
   *
   * Two sources, in this order:
   *  1. The configured list (team convention: `main` for production, `dev` for
   *     the replica). Configured branches that do not exist are reported, not
   *     failed — one list has to work for every repo.
   *  2. Optionally, branches pushed within `activeBranchDays`. Work in progress
   *     lives on feature branches whose docs never reach `main`, and those are
   *     exactly what people ask about.
   */
  private async planBranches(
    target: ConfiguredRepo
  ): Promise<{ index: { name: string; active: boolean }[]; missing: string[] }> {
    const existing = await this.github.listBranches(target);
    const byName = new Map(existing.map(branch => [branch.name, branch]));

    const index: { name: string; active: boolean }[] = [];
    const missing: string[] = [];

    for (const name of target.branches) {
      if (byName.has(name)) index.push({ name, active: false });
      else missing.push(name);
    }

    const windowDays = this.config.activeBranchDays;
    if (windowDays > 0) {
      const cutoff = Date.now() - windowDays * MS_PER_DAY;
      const chosen = new Set(index.map(branch => branch.name));

      const recent = existing
        .filter(branch => !chosen.has(branch.name))
        .filter(branch => {
          const at = Date.parse(branch.last_commit_date ?? '');
          return Number.isFinite(at) && at >= cutoff;
        })
        .slice(0, this.config.maxActiveBranches);

      for (const branch of recent) index.push({ name: branch.name, active: true });
    }

    return { index, missing };
  }

  private async refreshBranch(
    target: ConfiguredRepo,
    branch: string,
    active: boolean
  ): Promise<BranchIndexResult> {
    const paths = await this.resolveDocPaths(target, branch);
    const records: ChunkRecord[] = [];
    const skipped: string[] = [];
    const counters: EmbedCounters = { embedded: 0, reused: 0 };
    let indexedFiles = 0;

    for (const path of paths) {
      let text: string;
      try {
        const file = await this.github.getFileContent(target, path, branch);
        if (file.size_bytes > MAX_DOC_BYTES) {
          skipped.push(`${path} (too large: ${file.size_bytes} bytes)`);
          continue;
        }
        text = file.content;
      } catch (error) {
        // A doc pattern naming a file that does not exist on this branch is
        // normal (not every repo has NEGOCIO.md); anything else is worth
        // surfacing but still not worth aborting the branch for.
        if (error instanceof NotFoundError) continue;
        skipped.push(`${path} (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }

      const chunks = chunkMarkdown(text);
      if (chunks.length === 0) continue;
      indexedFiles += 1;

      const hashes = chunks.map(chunk => hashContent(chunk.text));
      const vectors = await this.embedChunks(chunks.map(chunk => chunk.text), hashes, counters);

      chunks.forEach((chunk, offset) => {
        const embedding = vectors.get(hashes[offset]!);
        // A provider that answered with fewer vectors than it was asked for
        // leaves a chunk without one. Dropping that chunk keeps the rest of the
        // file indexed, which beats failing the branch over one missing answer.
        if (!embedding) return;
        records.push({
          repo: target.fullName,
          alias: target.alias,
          branch,
          path,
          chunk_index: chunk.index,
          heading: chunk.heading,
          content: chunk.text,
          embedding
        });
      });
    }

    this.store.replaceBranch(
      target.fullName,
      branch,
      records,
      this.embeddings.model,
      indexedFiles
    );

    return {
      branch,
      files: indexedFiles,
      chunks: records.length,
      embedded_chunks: counters.embedded,
      reused_chunks: counters.reused,
      active,
      skipped,
      error: null
    };
  }

  /**
   * Resolves one file's chunks to vectors, hitting the embedding cache first.
   *
   * The provider is the expensive part of a refresh by a wide margin, and most
   * of what it is asked is text it has already seen: the same README on main,
   * on dev and on every branch cut from them, unchanged since the last run.
   * Measured on the real index, 2790 chunks per full refresh are only 767
   * distinct texts — so the cache is consulted first and ONLY the misses are
   * sent out, still in EMBED_BATCH_SIZE round trips.
   *
   * The result is keyed by content hash rather than by position, which also
   * makes a text repeated inside one file a single request that both chunks
   * read from.
   */
  private async embedChunks(
    texts: string[],
    hashes: string[],
    counters: EmbedCounters
  ): Promise<Map<string, number[]>> {
    const cached = this.store.cachedEmbeddings(this.embeddings.model, hashes);
    const vectors = new Map(cached);
    const missingTexts: string[] = [];

    // Deduplicated against the hits AND against itself, so a paragraph that
    // appears twice inside one file is embedded once and both chunks read the
    // same vector.
    const missing: string[] = [];
    const queued = new Set<string>();
    hashes.forEach((hash, offset) => {
      if (vectors.has(hash) || queued.has(hash)) return;
      queued.add(hash);
      missing.push(hash);
      missingTexts.push(texts[offset]!);
    });

    const fresh: { content_hash: string; embedding: number[] }[] = [];

    for (let at = 0; at < missingTexts.length; at += EMBED_BATCH_SIZE) {
      const batch = missingTexts.slice(at, at + EMBED_BATCH_SIZE);
      const computed = await this.embeddings.embedDocuments(batch);

      batch.forEach((_, offset) => {
        const embedding = computed[offset];
        // A short answer from the provider leaves this hash unresolved; it is
        // neither stored nor cached, and the chunk is skipped downstream.
        if (!embedding) return;
        const hash = missing[at + offset]!;
        vectors.set(hash, embedding);
        fresh.push({ content_hash: hash, embedding });
      });
    }

    this.store.cacheEmbeddings(this.embeddings.model, fresh);

    // Distinct texts on both sides, so the two add up to the requests a cold
    // run would have made.
    counters.embedded += fresh.length;
    counters.reused += cached.size;

    return vectors;
  }

  /**
   * Turns the configured doc patterns into concrete paths on one branch.
   *
   * Exact paths are trusted as written — a tree call would cost an extra
   * request and the file may exist without appearing in a truncated tree. Only
   * a glob ("docs/**") forces a tree listing.
   */
  private async resolveDocPaths(target: ConfiguredRepo, branch: string): Promise<string[]> {
    const exact = target.docPatterns.filter(pattern => !isGlobPattern(pattern));
    const globs = target.docPatterns.filter(isGlobPattern);

    const paths = new Set(exact);

    if (globs.length > 0) {
      const tree = await this.github.listTree(target, branch);
      for (const entry of tree) {
        if (!isMarkdown(entry.path)) continue;
        if (globs.some(pattern => matchesDocPattern(entry.path, pattern))) {
          paths.add(entry.path);
        }
      }
    }

    return [...paths].sort();
  }
}
