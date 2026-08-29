import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ConfiguredRepo } from '../config/repos.js';
import { ServerContext } from '../context.js';
import { ProjectStatus } from '../github/types.js';
import { ok, guard } from './shared.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How many repos may have their status fetched at the same time.
 *
 * getProjectStatus already issues FOUR GitHub calls per repo in parallel
 * (meta, last commit, open pulls, open issues), so an unbounded fan-out over N
 * repos means 4N simultaneous requests. GitHub's secondary rate limits trigger
 * on concurrency, not only on volume, so comparing a dozen repos would start
 * getting throttled precisely when the whole point of the tool is one cheap
 * call. Four repos in flight is sixteen requests: fast enough to feel like a
 * single call, low enough to stay well inside the limit.
 */
const MAX_REPOS_IN_FLIGHT = 4;

interface ComparedProject extends ProjectStatus {
  /** Whole days from the last commit on the default branch to `now`. */
  days_since_default_branch_commit: number | null;
  /** Whole days from the last push on ANY branch to `now`. */
  days_since_any_activity: number | null;
  /**
   * The gap between the two: how long work has been landing somewhere other
   * than the default branch. Deliberately a number and not a boolean — the
   * threshold that makes it worrying depends on the project, so the tool
   * reports the fact and the description tells the agent how to read it.
   */
  days_of_work_off_default_branch: number | null;
}

interface FailedRepo {
  repo: string;
  error: string;
}

export function registerCompareStatus(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'compare_status',
    {
      title: 'Compare the live status of several repositories',
      description:
        'Returns the current GitHub state of several repositories side by side, sorted by most ' +
        'recent activity: default branch, last commit, open pull requests, open issues, plus ' +
        'how many days have passed since the last commit on the default branch and since the ' +
        'last activity on any branch. This is live data, never the search index, so it is ' +
        'always up to date and never needs refresh_index. Use it for "how are the projects ' +
        'going", "which project is moving", or "compare X and Y" — one call instead of chaining ' +
        'get_project_status N times. Do NOT use it for a single repository: that is ' +
        'get_project_status, which is cheaper and answers the same thing. Do NOT use it to find ' +
        'out which repos exist or what is indexed: that is list_projects. A large ' +
        'days_of_work_off_default_branch means someone is pushing to branches whose work has ' +
        'not reached the default branch yet — the most useful signal when comparing projects. ' +
        'Read-only.',
      inputSchema: {
        repos: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Repository aliases from list_projects (also accepts "owner/repo"). ' +
              'Omit to compare every configured repository.'
          )
      },
      annotations: { readOnlyHint: true }
    },
    async ({ repos }) =>
      guard(async () => {
        // Resolution happens before any network call so an unknown alias is
        // reported as its own failure instead of taking the whole comparison
        // down with it — the caller usually typed one name wrong, not all of
        // them.
        const requested = repos ?? context.config.all.map(repo => repo.alias);
        const targets: { reference: string; target: ConfiguredRepo }[] = [];
        const failed: FailedRepo[] = [];

        for (const reference of requested) {
          try {
            targets.push({ reference, target: context.config.resolve(reference) });
          } catch (error) {
            failed.push({ repo: reference, error: describe(error) });
          }
        }

        // Captured once, before the fetches, so every "days since" in the
        // response is measured from the same instant.
        const checkedAt = new Date();
        const now = checkedAt.getTime();

        const outcomes = await mapWithLimit(targets, MAX_REPOS_IN_FLIGHT, async entry => {
          try {
            const status = await context.github.getProjectStatus(entry.target);
            return { project: derive(status, now), failure: null };
          } catch (error) {
            // One unreachable repo must not hide the state of the rest.
            return {
              project: null,
              failure: { repo: entry.reference, error: describe(error) }
            };
          }
        });

        const projects: ComparedProject[] = [];
        for (const outcome of outcomes) {
          if (outcome.project) projects.push(outcome.project);
          else if (outcome.failure) failed.push(outcome.failure);
        }

        // The tool exists to compare, so the order has to mean something:
        // busiest first, and repos with no recorded activity at the end.
        projects.sort((a, b) => rank(b.last_activity) - rank(a.last_activity));

        return ok({
          // "Days since" bakes in the moment of the reading. Without this a
          // stale answer quoted later is indistinguishable from a fresh one.
          checked_at: checkedAt.toISOString(),
          projects,
          failed,
          summary: {
            requested: requested.length,
            succeeded: projects.length,
            failed: failed.length,
            total_open_pull_requests: projects.reduce(
              (sum, project) => sum + project.open_pull_requests,
              0
            ),
            total_open_issues: projects.reduce((sum, project) => sum + project.open_issues, 0)
          }
        });
      })
  );
}

function derive(status: ProjectStatus, now: number): ComparedProject {
  const sinceCommit = wholeDaysSince(status.last_commit?.date ?? null, now);
  const sinceActivity = wholeDaysSince(status.last_activity, now);

  return {
    ...status,
    days_since_default_branch_commit: sinceCommit,
    days_since_any_activity: sinceActivity,
    days_of_work_off_default_branch:
      sinceCommit === null || sinceActivity === null
        ? null
        : // Clamped: a default-branch commit newer than the recorded push is
          // not "negative work off the branch", it is simply none. GitHub's
          // pushed_at can also lag a commit by seconds.
          Math.max(0, sinceCommit - sinceActivity)
  };
}

/**
 * Whole days from an ISO timestamp to `now`, or null when there is no date or
 * it cannot be parsed. Returning null rather than NaN matters: NaN survives
 * arithmetic silently and serialises to `null` anyway, so a bad date would
 * reach the agent looking exactly like a missing one but only after
 * contaminating every number derived from it.
 *
 * Exported for the tests, which is the only place the difference between null
 * and NaN is still observable — JSON.stringify flattens both to `null`.
 */
export function wholeDaysSince(iso: string | null, now: number): number | null {
  if (iso === null) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now - then) / MS_PER_DAY));
}

/** Sort key for `last_activity`: unknown activity ranks below any known date. */
function rank(iso: string | null): number {
  if (iso === null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs `run` over `items` with at most `limit` promises pending at a time,
 * preserving input order in the results. A handful of worker loops pulling
 * from a shared cursor is all this needs; adding a dependency for it would
 * cost more than the fifteen lines it replaces.
 */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]);
    }
  });

  await Promise.all(workers);
  return results;
}
