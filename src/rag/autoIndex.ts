import { ConfiguredRepo } from '../config/repos.js';
import { readEnv } from '../core/env.js';
import { IndexReport } from './indexer.js';
import { selectStaleRepos } from './staleness.js';
import { IndexStats } from './store.js';

/**
 * The slice of the server context this needs, and nothing more. Narrowed on
 * purpose: it lets a test drive the scheduler with three literals instead of a
 * SQLite file, a GitHub token and a running Ollama.
 */
export interface AutoIndexContext {
  config: { all: ConfiguredRepo[] };
  store: { stats(): IndexStats[] };
  indexer: { refresh(reference?: string): Promise<IndexReport> };
}

export interface StartupRefreshOptions {
  /** Overrides REPO_RAG_AUTO_INDEX_HOURS. Mostly for tests. */
  maxAgeHours?: number;
  /** Overrides the wall clock. Mostly for tests. */
  now?: Date;
}

/** Hours before the index is considered stale, when nothing says otherwise. */
const DEFAULT_MAX_AGE_HOURS = 12;

/**
 * Reindexes whatever went stale while the server was down.
 *
 * This exists because the index is a snapshot and not a mirror, which is the
 * single most confusing thing about this server for someone who did not build
 * it: they ask about a document that plainly exists on GitHub and are told the
 * docs do not cover it. Refreshing on startup removes the manual step instead
 * of documenting it.
 *
 * It NEVER throws. A startup routine that can fail takes the server with it,
 * and a server that answers from a stale index is enormously better than one
 * that does not start — so every failure is logged and swallowed, per repo and
 * as a whole.
 */
export async function scheduleStartupRefresh(
  context: AutoIndexContext,
  options: StartupRefreshOptions = {}
): Promise<void> {
  try {
    const maxAgeHours = options.maxAgeHours ?? readMaxAgeHours();
    if (maxAgeHours <= 0) {
      console.error('[auto-index] disabled (REPO_RAG_AUTO_INDEX_HOURS=0).');
      return;
    }

    const now = options.now ?? new Date();
    const stale = selectStaleRepos(context.config.all, context.store.stats(), maxAgeHours, now);

    if (stale.length === 0) {
      console.error(
        `[auto-index] index is current (every repo refreshed within ${maxAgeHours}h); nothing to do.`
      );
      return;
    }

    console.error(
      `[auto-index] ${stale.length} of ${context.config.all.length} repos older than ` +
        `${maxAgeHours}h or never indexed: ${stale.map(repo => repo.alias).join(', ')}. ` +
        'Refreshing in the background.'
    );

    // Sequential on purpose. A Promise.all here would multiply the GitHub
    // rate-limit pressure and the Ollama load by the repo count at the exact
    // moment the agent is starting to ask questions, and there is nothing to
    // gain: this runs in the background, so it is allowed to take its time.
    for (const repo of stale) {
      await refreshOne(context, repo);
    }
  } catch (error) {
    // Reaching here means something outside the per-repo loop broke (reading
    // the stats, most likely). Still not worth failing a startup over.
    console.error(`[auto-index] skipped: ${describe(error)}`);
  }
}

async function refreshOne(context: AutoIndexContext, repo: ConfiguredRepo): Promise<void> {
  try {
    const report = await context.indexer.refresh(repo.alias);
    const total = (pick: (result: IndexReport['results'][number]) => number): number =>
      report.results.reduce((sum, result) => sum + pick(result), 0);

    // Branch errors are counted too, not just repo errors. The likeliest
    // failure at startup by far is Ollama not being up yet, and that surfaces
    // per BRANCH: the repo itself succeeds, every branch fails, and the line
    // below would otherwise read "0 files, 0 chunks" — an empty success. The
    // reason has to appear here or nobody will look for it.
    const failedRepos = report.results.filter(result => result.error !== null);
    const branchErrors = report.results.flatMap(result =>
      result.branches.filter(branch => branch.error !== null)
    );
    const reason =
      failedRepos[0]?.error ?? branchErrors[0]?.error ?? null;

    // The embedded/reused split is the line worth reading: it is the difference
    // between a refresh that took minutes and one that took seconds, and it is
    // what explains a suspiciously fast run instead of making it suspicious.
    console.error(
      `[auto-index] ${repo.alias}: ${total(result => result.files)} files, ` +
        `${total(result => result.chunks)} chunks, ` +
        `${total(result => result.embedded_chunks)} embedded / ` +
        `${total(result => result.reused_chunks)} reused` +
        (reason === null
          ? ''
          : ` — ${failedRepos.length} repo and ${branchErrors.length} branch ` +
            `failure(s), first: ${reason}`)
    );
  } catch (error) {
    // One repo down must not cost the others their refresh: an expired token
    // or a rate limit would otherwise take the whole startup pass with it.
    console.error(`[auto-index] ${repo.alias} failed: ${describe(error)}`);
  }
}

/**
 * Reads the staleness window from the environment.
 *
 * An unreadable value falls back to the default instead of disabling the
 * feature: a typo should not silently turn off the thing the variable exists to
 * configure, and the warning says which value was ignored.
 */
function readMaxAgeHours(): number {
  const raw = readEnv('REPO_RAG_AUTO_INDEX_HOURS', String(DEFAULT_MAX_AGE_HOURS));
  const parsed = Number.parseFloat(raw);

  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(
      `[auto-index] ignoring REPO_RAG_AUTO_INDEX_HOURS="${raw}" (not a number of hours); ` +
        `using ${DEFAULT_MAX_AGE_HOURS}h.`
    );
    return DEFAULT_MAX_AGE_HOURS;
  }

  return parsed;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
