import { ConfiguredRepo } from '../config/repos.js';
import { IndexStats } from './store.js';

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Decides which configured repos are worth reindexing, given what the index
 * says about itself.
 *
 * Pure on purpose: no database and no clock live in here, so every rule below
 * is an argument the caller passes and a test can state a whole scenario as
 * three literals. The side effects (reading `index_runs`, reading the wall
 * clock, spending GitHub and Ollama budget) belong to the scheduler.
 *
 * The decision is PER REPO rather than a single global "is the index old"
 * flag, because `Indexer.refresh(alias)` already accepts one repo: judging the
 * whole index by its oldest entry would re-download and re-embed repos that
 * were refreshed minutes ago.
 */
export function selectStaleRepos(
  repos: readonly ConfiguredRepo[],
  stats: readonly IndexStats[],
  maxAgeHours: number,
  now: Date
): ConfiguredRepo[] {
  // Zero (or anything below it) is the off switch, and an off switch that
  // still triggers a full reindex on a repo nobody ever indexed is not off.
  if (maxAgeHours <= 0) return [];

  const newestByRepo = new Map<string, number>();
  for (const entry of stats) {
    const at = Date.parse(entry.indexed_at);
    // An unreadable timestamp is not evidence of freshness, so it is not
    // allowed to raise the repo's high-water mark: the run is treated as if it
    // had never been recorded, which lands the repo in the stale set below.
    if (!Number.isFinite(at)) continue;

    const known = newestByRepo.get(entry.repo);
    if (known === undefined || at > known) newestByRepo.set(entry.repo, at);
  }

  const cutoff = now.getTime() - maxAgeHours * MS_PER_HOUR;

  return repos.filter(repo => {
    const newest = newestByRepo.get(repo.fullName);

    // No run at all is the case this whole feature exists for. It covers a repo
    // just added to repos.json AND an index dropped by a SCHEMA_VERSION bump —
    // both of which otherwise leave the user silently under-indexed, searching
    // documentation that is simply not there and being told the docs do not
    // cover it.
    if (newest === undefined) return true;

    // A repo is judged by its NEWEST branch: branches are indexed together, so
    // one long-untouched branch says nothing about when the repo was last
    // refreshed.
    return newest < cutoff;
  });
}
