#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { hasPlaceholders } from './config/repos.js';
import { buildContext } from './context.js';
import { loadEnvFile } from './core/env.js';
import { scheduleStartupRefresh } from './rag/autoIndex.js';
import { registerCompareStatus } from './tools/compareStatus.js';
import { registerGetFileContent } from './tools/getFileContent.js';
import { registerGetProjectStatus } from './tools/getProjectStatus.js';
import { registerGetProjectSummary } from './tools/getProjectSummary.js';
import { registerGetRecentCommits } from './tools/getRecentCommits.js';
import { registerListBranches } from './tools/listBranches.js';
import { registerListProjects } from './tools/listProjects.js';
import { registerRefreshIndex } from './tools/refreshIndex.js';
import { registerSearchProjectDocs } from './tools/searchProjectDocs.js';

loadEnvFile();

const context = buildContext();

const server = new McpServer({
  name: 'repo-rag',
  version: '0.1.0'
});

registerListProjects(server, context);
registerGetProjectStatus(server, context);
registerGetRecentCommits(server, context);
registerListBranches(server, context);
registerSearchProjectDocs(server, context);
registerRefreshIndex(server, context);
registerGetProjectSummary(server, context);
registerGetFileContent(server, context);
registerCompareStatus(server, context);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout es el canal MCP: todo log tiene que ir a stderr.
  console.error(`repo-rag MCP server running on stdio — ${context.label}`);
  if (hasPlaceholders(context.config)) {
    console.error(
      '[warn] repos.json still contains placeholder repositories. ' +
        'Replace them with the real repos or every GitHub call will 404.'
    );
  }

  // A propósito SIN await. El handshake MCP ya terminó en este punto y no puede
  // quedar esperando a GitHub y a Ollama: las tools siguen contestando desde el
  // índice que ya existe — posiblemente vencido — mientras esto corre, y el
  // índice simplemente queda más fresco un rato después. Esperarlo dejaría al
  // cliente colgado durante minutos en un arranque en frío, que es exactamente
  // lo que evita mandarlo al segundo plano.
  void scheduleStartupRefresh(context).catch(error => {
    // El scheduler ya se traga sus propias fallas; esta es la última red, para
    // que un rechazo inesperado no se convierta en uno no manejado y mate a un
    // server que por lo demás está perfectamente en condiciones de contestar.
    console.error('[auto-index] unexpected failure:', error);
  });
}

main().catch(error => {
  console.error('Fatal error starting repo-rag MCP server:', error);
  process.exit(1);
});
