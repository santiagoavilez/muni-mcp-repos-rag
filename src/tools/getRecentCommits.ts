import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ServerContext } from '../context.js';
import { ok, guard } from './shared.js';

export function registerGetRecentCommits(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'get_recent_commits',
    {
      title: 'List the latest commits of a repository',
      description:
        'Returns the most recent commits of a repository as raw data: short sha, author, ' +
        'date and subject line. Live from GitHub, never the search index. Use it when asked ' +
        'what was worked on lately, who touched a project, or to build a changelog by hand. ' +
        'It does NOT read the documentation — for that use search_project_docs. Read-only.',
      inputSchema: {
        repo: z
          .string()
          .min(1)
          .describe('Repository alias from list_projects (also accepts "owner/repo").'),
        n: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(10)
          .describe('How many commits to return. Defaults to 10, capped at 100.')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ repo, n }) =>
      guard(async () => {
        const target = context.config.resolve(repo);
        const commits = await context.github.getRecentCommits(target, n ?? 10);
        return ok({ repo: target.fullName, alias: target.alias, count: commits.length, commits });
      })
  );
}
