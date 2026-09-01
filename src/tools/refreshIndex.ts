import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ServerContext } from '../context.js';
import { ok, guard } from './shared.js';

export function registerRefreshIndex(server: McpServer, context: ServerContext): void {
  server.registerTool(
    'refresh_index',
    {
      title: 'Rebuild the documentation search index',
      description:
        'Re-reads the configured documentation files from GitHub, splits them, computes local ' +
        'embeddings and rewrites the search index. Run it when search_project_docs says the ' +
        'index is empty or stale, or after someone tells you the docs changed. The index ' +
        'also refreshes itself in the background at server startup when it is older than ' +
        'the configured age (12h by default); use this tool to force a refresh right now — ' +
        'for example after a push you just made. Pass `repo` to rebuild a single ' +
        'project (fast); omit it to rebuild all of them (slow — it can take minutes). ' +
        'Each repo is indexed on every branch configured for it (typically "main" and ' +
        '"dev") plus any recently active branch, and branches that disappeared are dropped ' +
        'from the index. It writes only to the local index and never modifies GitHub.',
      inputSchema: {
        repo: z
          .string()
          .min(1)
          .optional()
          .describe('Repository alias to reindex. Omit to reindex every configured repo.')
      },
      // No es de solo lectura: reescribe el índice local. Igual no es destructiva
      // sobre GitHub, y es segura de repetir: cada corrida reemplaza por completo
      // los chunks del repo.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ repo }) =>
      guard(async () => {
        const report = await context.indexer.refresh(repo);
        const failed = report.results.filter(
          result => result.error !== null || result.branches.some(branch => branch.error !== null)
        );

        return ok({
          ...report,
          summary: {
            repos: report.results.length,
            branches: report.results.reduce(
              (total, result) => total + result.branches.filter(b => b.error === null).length,
              0
            ),
            files: report.results.reduce((total, result) => total + result.files, 0),
            chunks: report.results.reduce((total, result) => total + result.chunks, 0),
            // Cuánto de la corrida absorbió el caché de embeddings. Vale la pena
            // mostrarlo: es la diferencia entre un refresh que tarda minutos y uno
            // que tarda segundos, y explica una corrida sospechosamente rápida.
            embedded_chunks: report.results.reduce(
              (total, result) => total + result.embedded_chunks,
              0
            ),
            reused_chunks: report.results.reduce(
              (total, result) => total + result.reused_chunks,
              0
            ),
            failed: failed.length
          }
        });
      })
  );
}
