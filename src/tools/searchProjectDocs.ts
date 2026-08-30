import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerContext } from '../context.js';
import { IndexEmptyError } from '../core/errors.js';
import { ok, guard } from './shared.js';

export function registerSearchProjectDocs(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'search_project_docs',
    {
      title: 'Hybrid search over the project documentation',
      description:
        'Answers questions about what the projects DO, searching their indexed ' +
        'documentation (README, CLAUDE.md, TRACKER.md, NEGOCIO.md, docs/). It combines ' +
        'meaning-based search with exact keyword search, so it handles BOTH a paraphrased ' +
        'question ("como entran los vecinos") and a literal term the docs use verbatim ' +
        '("BILLING", an tramite number, a class name) — include those literal terms in ' +
        'your query when you have them, they make the search much sharper. Returns the ' +
        'matching fragments with their source repo, file and branch, so you can quote where ' +
        'each claim came from. Narrow it with `repo` when the question is about one project. ' +
        'This searches a snapshot taken at the last refresh_index, NOT live GitHub — for ' +
        'commits, pull requests or repo state use get_project_status or get_recent_commits. ' +
        'The index covers several branches per repo (typically "main" for production and ' +
        '"dev" for the replica, plus recently active feature branches), so the same document ' +
        'can appear more than once with different content: always report which branch a ' +
        'fragment came from. Read-only.',
      inputSchema: {
        query: z
          .string()
          .min(3)
          .describe('The question, in natural language. E.g. "como se autentican los vecinos".'),
        repo: z
          .string()
          .min(1)
          .optional()
          .describe('Optional repository alias to search inside. Omit to search every repo.'),
        branch: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Optional branch to restrict the search to, e.g. "main" (production) or "dev" ' +
              '(replica). Omit to search every indexed branch, which is usually what you want: ' +
              'each result says which branch it came from.'
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(5)
          .describe('How many fragments to return. Defaults to 5.')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ query, repo, branch, limit }) =>
      guard(async () => {
        const target = repo ? context.config.resolve(repo) : null;
        const scope = { repo: target?.fullName, branch };

        if (context.store.totalChunks(scope) === 0) {
          throw new IndexEmptyError(
            describeEmptyScope(context, target?.fullName, target?.alias, branch)
          );
        }

        // An index built with another embedding model must refuse to answer,
        // not answer wrong: two models can agree on the dimension count, so
        // the dimension guard inside search would happily score one model's
        // vectors against the other's query and every result would be quietly
        // broken. Auto-index normally rebuilds this, but it can be disabled.
        const stale = context.store
          .indexedModels(target?.fullName)
          .find(model => model !== context.embeddings.model);
        if (stale !== undefined) {
          throw new IndexEmptyError(
            `The index was built with embedding model "${stale}" but the server is configured ` +
              `with "${context.embeddings.model}". Run refresh_index to rebuild it.`
          );
        }

        const embedding = await context.embeddings.embedQuery(query);
        // The raw text goes in too: the keyword half needs the actual words,
        // which the embedding has already thrown away.
        const hits = context.store.search(embedding, limit ?? 5, scope, query);

        return ok({
          query,
          scope: {
            repo: target?.fullName ?? 'all repos',
            branch: branch ?? 'all indexed branches'
          },
          model: context.embeddings.model,
          results: hits.map(hit => ({
            repo: hit.repo,
            alias: hit.alias,
            branches: hit.branches,
            path: hit.path,
            heading: hit.heading,
            // `matched_by: "both"` means the exact words appear in the text,
            // which is a much stronger claim than semantic proximity alone.
            matched_by: hit.matched_by,
            score: Number(hit.score.toFixed(5)),
            semantic_score: Number(hit.semantic_score.toFixed(4)),
            indexed_at: hit.indexed_at,
            content: hit.content
          })),
          // Said plainly so the agent explains the gap instead of inventing one.
          note:
            hits.length === 0
              ? 'Nothing matched. The docs may not cover this, or the index may be stale — ' +
                'consider refresh_index.'
              : 'These fragments come from the last indexed snapshot, not live GitHub. ' +
                '`branches` lists every branch where that exact text appears: a fragment ' +
                'found ONLY on a feature branch is work in progress, not production.'
        });
      })
  );
}

/**
 * An empty scope is nearly always a missing reindex, but "which branch did you
 * mean" is a different mistake with a different fix — so the message names the
 * branches that ARE indexed instead of blaming refresh_index for both.
 */
function describeEmptyScope(
  context: ServerContext,
  repo: string | undefined,
  alias: string | undefined,
  branch: string | undefined
): string {
  if (repo === undefined) {
    const allBranches = [...new Set(context.store.stats().map(entry => entry.branch))];

    // Nothing indexed anywhere is a real "run refresh_index"; a `branch` that
    // simply isn't among the ones that DO exist is a different mistake with a
    // different fix, so it gets the same branch-listing treatment as the
    // single-repo case below instead of the misleading "index is empty".
    if (allBranches.length === 0) {
      return 'The documentation index is empty. Run refresh_index first.';
    }
    if (branch !== undefined) {
      return (
        `Branch "${branch}" is not indexed in any repo. Indexed branches: ` +
        `${allBranches.join(', ')}. Retry without the branch argument, or narrow to a repo ` +
        'that has that branch and run refresh_index for it.'
      );
    }
    return 'The documentation index is empty. Run refresh_index first.';
  }

  const indexed = context.store.statsFor(repo);
  if (indexed.length === 0) {
    return `Nothing indexed for ${repo} yet. Run refresh_index with repo="${alias}" first.`;
  }

  if (branch !== undefined) {
    const available = indexed.map(entry => entry.branch).join(', ');
    return (
      `Branch "${branch}" of ${repo} is not indexed. Indexed branches: ${available}. ` +
      'Retry without the branch argument, or add it to repos.json and run refresh_index.'
    );
  }

  return `Nothing indexed for ${repo} yet. Run refresh_index with repo="${alias}" first.`;
}
