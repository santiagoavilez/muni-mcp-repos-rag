import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ServerContext } from '../context.js';
import { ok, guard } from './shared.js';

export function registerGetFileContent(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'get_file_content',
    {
      title: 'Read one full file from a repository',
      description:
        'Returns one text file whole and unfragmented, read live from GitHub: TRACKER.md, ' +
        'NEGOCIO.md, CLAUDE.md, a changelog, a config file. Use it when the user asks for a ' +
        'specific document in full ("mostrame el TRACKER de turnos"). When the question is ' +
        'about a topic rather than a named file, use search_project_docs instead — it finds ' +
        'the relevant fragments across every project without you guessing the path. ' +
        'Reads the default branch unless you pass `branch` — use that to read work in ' +
        'progress that has not been merged yet. Large files and binaries are refused. ' +
        'Read-only.',
      inputSchema: {
        repo: z
          .string()
          .min(1)
          .describe('Repository alias from list_projects (also accepts "owner/repo").'),
        path: z
          .string()
          .min(1)
          .describe('Path inside the repo, from its root. E.g. "docs/TRACKER.md".'),
        branch: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Branch to read from, e.g. "dev" or a feature branch. Omit for the default ' +
              'branch (production).'
          )
      },
      annotations: { readOnlyHint: true }
    },
    async ({ repo, path, branch }) =>
      guard(async () => {
        const target = context.config.resolve(repo);
        return ok(await context.github.getFileContent(target, path, branch));
      })
  );
}
