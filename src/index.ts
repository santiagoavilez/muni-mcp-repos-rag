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

  // stdout is the MCP channel — every log must go to stderr.
  console.error(`repo-rag MCP server running on stdio — ${context.label}`);
  if (hasPlaceholders(context.config)) {
    console.error(
      '[warn] repos.json still contains placeholder repositories. ' +
        'Replace them with the real repos or every GitHub call will 404.'
    );
  }

  // Deliberately NOT awaited. The MCP handshake is already done by this point
  // and must not wait for GitHub and Ollama: the tools keep answering from the
  // existing — possibly stale — index while this runs, and the index is simply
  // fresher a little later. Awaiting it would hang the client for minutes on a
  // cold start, which is exactly what the background placement avoids.
  void scheduleStartupRefresh(context).catch(error => {
    // The scheduler already swallows its own failures; this is the last net, so
    // an unexpected rejection cannot become an unhandled one and kill a server
    // that is otherwise perfectly able to answer.
    console.error('[auto-index] unexpected failure:', error);
  });
}

main().catch(error => {
  console.error('Fatal error starting repo-rag MCP server:', error);
  process.exit(1);
});
