import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ServerContext } from '../context.js';
import { ok, guard } from './shared.js';

export function registerGetProjectStatus(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'get_project_status',
    {
      title: 'Get the live status of one repository',
      description:
        'Returns the current state of one repository straight from GitHub: default branch, ' +
        'last commit (author, date, message), number of open pull requests and number of ' +
        'open issues. This is live data, never the search index, so it is always up to date ' +
        'and never needs refresh_index. Use it for "how is X going" or "what changed in X". ' +
        'For a status plus a slice of the README in one call, use get_project_summary. ' +
        'Read-only.',
      inputSchema: {
        repo: z
          .string()
          .min(1)
          .describe('Repository alias from list_projects (also accepts "owner/repo").')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ repo }) =>
      guard(async () => {
        const target = context.config.resolve(repo);
        return ok(await context.github.getProjectStatus(target));
      })
  );
}
