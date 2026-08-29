import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ServerContext } from '../context.js';
import { NotFoundError } from '../core/errors.js';
import { ok, guard } from './shared.js';

const DEFAULT_README_CHARS = 2_000;

export function registerGetProjectSummary(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'get_project_summary',
    {
      title: 'Executive summary of one repository',
      description:
        'One-call overview of a project: its live status (branch, last commit, open pull ' +
        'requests and issues) plus the opening section of its README, read live from GitHub. ' +
        'This is the right first call for "contame como viene X" — it saves chaining ' +
        'get_project_status and get_file_content. It does not use the search index, so it ' +
        'needs no refresh_index, and it returns only the START of the README: for a specific ' +
        'question use search_project_docs, for a whole file use get_file_content. Read-only.',
      inputSchema: {
        repo: z
          .string()
          .min(1)
          .describe('Repository alias from list_projects (also accepts "owner/repo").'),
        readme_chars: z
          .number()
          .int()
          .min(200)
          .max(10_000)
          .default(DEFAULT_README_CHARS)
          .describe('How much of the README to include. Defaults to 2000 characters.')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ repo, readme_chars }) =>
      guard(async () => {
        const target = context.config.resolve(repo);
        const limit = readme_chars ?? DEFAULT_README_CHARS;

        const [status, readme] = await Promise.all([
          context.github.getProjectStatus(target),
          readReadme(context, target.alias)
        ]);

        return ok({
          ...status,
          readme: readme
            ? {
                path: readme.path,
                truncated: readme.content.length > limit,
                excerpt: readme.content.slice(0, limit)
              }
            : null,
          readme_note: readme ? null : 'This repository has no README at its root.'
        });
      })
  );
}

/** README casing is not standardised across repos, so a few spellings are tried. */
async function readReadme(
  context: ServerContext,
  alias: string
): Promise<{ path: string; content: string } | null> {
  const target = context.config.resolve(alias);
  const candidates = ['README.md', 'readme.md', 'README.MD', 'README'];

  for (const path of candidates) {
    try {
      const file = await context.github.getFileContent(target, path);
      return { path: file.path, content: file.content };
    } catch (error) {
      if (error instanceof NotFoundError) continue;
      throw error;
    }
  }
  return null;
}
