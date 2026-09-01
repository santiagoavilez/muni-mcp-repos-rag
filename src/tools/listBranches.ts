import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ServerContext } from '../context.js';
import { ok, guard } from './shared.js';

export function registerListBranches(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'list_branches',
    {
      title: 'List the branches of a repository',
      description:
        'Lists the branches of a repository, live from GitHub, newest activity first: name, ' +
        'last commit date, whether it is the default branch, and whether its documentation ' +
        'is in the search index. This is how you answer "en que rama esta X": match the ' +
        'branch name against what the user described (a feature branch is usually named ' +
        'after the work it holds) and confirm with the last commit date. Every other tool ' +
        'reads the default branch unless told otherwise, so use this first when the question ' +
        'is about work that is not merged yet. Read-only.',
      inputSchema: {
        repo: z
          .string()
          .min(1)
          .describe('Repository alias from list_projects (also accepts "owner/repo").'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('How many branches to return, newest first. Defaults to 20.')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ repo, limit }) =>
      guard(async () => {
        const target = context.config.resolve(repo);
        const branches = await context.github.listBranches(target);

        // Qué ramas son buscables importa tanto como cuáles existen: le dice al
        // agente si search_project_docs puede contestar sobre esta rama.
        const indexed = new Map(
          context.store.statsFor(target.fullName).map(entry => [entry.branch, entry])
        );

        return ok({
          repo: target.fullName,
          alias: target.alias,
          count: branches.length,
          branches: branches.slice(0, limit ?? 20).map(branch => {
            const stats = indexed.get(branch.name);
            return {
              name: branch.name,
              is_default: branch.is_default,
              last_commit_date: branch.last_commit_date,
              short_sha: branch.sha.slice(0, 7),
              indexed: stats !== undefined,
              indexed_at: stats?.indexed_at ?? null
            };
          }),
          note:
            'Branches marked indexed:false exist on GitHub but their documentation is not ' +
            'searchable — read their files with get_file_content, passing `branch`.'
        });
      })
  );
}
