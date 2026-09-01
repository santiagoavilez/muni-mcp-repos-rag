import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ServerContext } from '../context.js';
import { mapWithLimit } from '../core/concurrency.js';
import { ok, guard } from './shared.js';

export function registerListProjects(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'list_projects',
    {
      title: 'List the tracked repositories',
      description:
        'Lists every repository this server tracks: alias, full name, description and the ' +
        'date of its last activity. This is how you turn a project someone named in words ' +
        '("el de turnos") into the alias that every other tool takes. Call it first whenever ' +
        'you are not certain a repo is tracked. Read-only.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () =>
      guard(async () => {
        const projects = await mapWithLimit(context.config.all, 4, async repo => {
          try {
            const meta = await context.github.getRepoMeta(repo);
            return {
              alias: repo.alias,
              repo: repo.fullName,
              description: meta.description ?? repo.description,
              last_activity: meta.last_activity,
              default_branch: meta.default_branch,
              archived: meta.archived,
              // Qué ramas tienen realmente contenido buscable, y qué tan
              // fresca está cada una: el agente necesita esto para decidir si
              // una respuesta está vencida o simplemente no está indexada.
              indexed_branches: context.store.statsFor(repo.fullName).map(entry => ({
                branch: entry.branch,
                files: entry.files,
                chunks: entry.chunks,
                indexed_at: entry.indexed_at
              }))
            };
          } catch (error) {
            // Un repo inalcanzable no puede tapar el resto de la lista.
            return {
              alias: repo.alias,
              repo: repo.fullName,
              description: repo.description,
              last_activity: null,
              error: error instanceof Error ? error.message : String(error)
            };
          }
        });

        return ok({ projects });
      })
  );
}
