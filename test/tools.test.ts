import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ServerContext } from '../src/context.js';
import { Indexer } from '../src/rag/indexer.js';
import { VectorStore } from '../src/rag/store.js';
import { registerGetFileContent } from '../src/tools/getFileContent.js';
import { registerGetProjectStatus } from '../src/tools/getProjectStatus.js';
import { registerGetProjectSummary } from '../src/tools/getProjectSummary.js';
import { registerGetRecentCommits } from '../src/tools/getRecentCommits.js';
import { registerListBranches } from '../src/tools/listBranches.js';
import { registerListProjects } from '../src/tools/listProjects.js';
import { registerRefreshIndex } from '../src/tools/refreshIndex.js';
import { registerSearchProjectDocs } from '../src/tools/searchProjectDocs.js';
import { FakeEmbeddingProvider, tempDbPath, testConfig, testGitHub } from './fixtures.js';

interface Harness {
  client: Client;
  context: ServerContext;
  close: () => Promise<void>;
}

async function connect(): Promise<Harness> {
  const config = testConfig();
  const github = testGitHub();
  const embeddings = new FakeEmbeddingProvider();
  const store = new VectorStore(tempDbPath());
  const context: ServerContext = {
    config,
    github,
    embeddings,
    store,
    indexer: new Indexer(config, github, embeddings, store),
    label: 'test'
  };

  const server = new McpServer({ name: 'repo-rag-test', version: '0.0.0' });
  registerListProjects(server, context);
  registerGetProjectStatus(server, context);
  registerGetRecentCommits(server, context);
  registerListBranches(server, context);
  registerSearchProjectDocs(server, context);
  registerRefreshIndex(server, context);
  registerGetProjectSummary(server, context);
  registerGetFileContent(server, context);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return {
    client,
    context,
    close: async () => {
      await client.close();
      await server.close();
      store.close();
    }
  };
}

interface ToolOutcome {
  isError: boolean;
  text: string;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolOutcome> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text?: string }[];
  };
  return {
    isError: result.isError === true,
    text: result.content.map(entry => entry.text ?? '').join('\n')
  };
}

test('every v1 tool is registered, and only refresh_index is not read-only', async () => {
  const harness = await connect();

  const { tools } = await harness.client.listTools();
  const names = tools.map(tool => tool.name).sort();

  assert.deepEqual(names, [
    'get_file_content',
    'get_project_status',
    'get_project_summary',
    'get_recent_commits',
    'list_branches',
    'list_projects',
    'refresh_index',
    'search_project_docs'
  ]);

  for (const tool of tools) {
    // The description is what the model reads to decide when to call a tool —
    // an empty or throwaway one is a real defect, not a style nit.
    assert.ok(
      (tool.description ?? '').length > 80,
      `${tool.name} needs a description that explains when to use it`
    );
    const readOnly = tool.annotations?.readOnlyHint === true;
    assert.equal(
      readOnly,
      tool.name !== 'refresh_index',
      `${tool.name} has the wrong readOnlyHint`
    );
  }

  await harness.close();
});

test('list_projects reports every configured repo', async () => {
  const harness = await connect();

  const outcome = await call(harness.client, 'list_projects');
  assert.equal(outcome.isError, false);

  const payload = JSON.parse(outcome.text) as { projects: { alias: string }[] };
  assert.deepEqual(
    payload.projects.map(project => project.alias),
    ['turnos', 'tramites']
  );

  await harness.close();
});

test('get_project_status returns live counts and the last commit', async () => {
  const harness = await connect();

  const outcome = await call(harness.client, 'get_project_status', { repo: 'turnos' });
  const payload = JSON.parse(outcome.text);

  assert.equal(payload.repo, 'example-org/turnos');
  assert.equal(payload.open_pull_requests, 2);
  assert.equal(payload.open_issues, 5);
  assert.equal(payload.last_commit.short_sha, 'aaaaaaa');

  await harness.close();
});

test('get_recent_commits defaults to 10 and honours n', async () => {
  const harness = await connect();

  const all = JSON.parse((await call(harness.client, 'get_recent_commits', { repo: 'turnos' })).text);
  assert.equal(all.count, 2);

  const one = JSON.parse(
    (await call(harness.client, 'get_recent_commits', { repo: 'turnos', n: 1 })).text
  );
  assert.equal(one.count, 1);

  await harness.close();
});

test('an unknown repo is a tool error naming the valid aliases, not a crash', async () => {
  const harness = await connect();

  const outcome = await call(harness.client, 'get_project_status', { repo: 'inventado' });

  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /Unknown repo "inventado"/);
  assert.match(outcome.text, /turnos, tramites/);

  await harness.close();
});

test('a missing file is a tool error the agent can act on', async () => {
  const harness = await connect();

  const outcome = await call(harness.client, 'get_file_content', {
    repo: 'turnos',
    path: 'NO_EXISTE.md'
  });

  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /Not found on GitHub/);

  await harness.close();
});

test('search_project_docs tells the agent to reindex instead of returning nothing', async () => {
  const harness = await connect();

  const outcome = await call(harness.client, 'search_project_docs', {
    query: 'como se autentican los vecinos'
  });

  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /refresh_index/);

  await harness.close();
});

test('refresh_index then search_project_docs answers with a cited fragment', async () => {
  const harness = await connect();

  const refreshed = JSON.parse((await call(harness.client, 'refresh_index')).text);
  assert.equal(refreshed.summary.failed, 0);
  assert.ok(refreshed.summary.chunks > 0);

  const outcome = await call(harness.client, 'search_project_docs', {
    query: 'como se autentican los vecinos',
    repo: 'turnos'
  });
  assert.equal(outcome.isError, false);

  const payload = JSON.parse(outcome.text);
  assert.deepEqual(payload.scope, {
    repo: 'example-org/turnos',
    branch: 'all indexed branches'
  });
  assert.ok(payload.results.length > 0);
  assert.equal(payload.results[0].path, 'README.md');
  assert.equal(payload.results[0].heading, 'Autenticacion');
  // Every hit must say which branch it came from — a fragment on a feature
  // branch is not the same claim as one on main.
  assert.ok(
    payload.results.every((hit: { branches?: string[] }) => Array.isArray(hit.branches))
  );
  assert.match(payload.results[0].content, /DNI/);

  await harness.close();
});

test('search_project_docs on an unindexed branch says which branches ARE indexed', async () => {
  const harness = await connect();
  await call(harness.client, 'refresh_index', { repo: 'turnos' });

  const outcome = await call(harness.client, 'search_project_docs', {
    query: 'como se autentican los vecinos',
    repo: 'turnos',
    branch: 'no-existe'
  });

  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /Branch "no-existe"/);
  // The fix here is not refresh_index, so the message must not send the agent there.
  assert.match(outcome.text, /Indexed branches: dev, main/);

  await harness.close();
});

test('get_file_content reads a specific branch when asked', async () => {
  const harness = await connect();

  const onMain = JSON.parse(
    (await call(harness.client, 'get_file_content', { repo: 'turnos', path: 'TRACKER.md' })).text
  );
  const onDev = JSON.parse(
    (
      await call(harness.client, 'get_file_content', {
        repo: 'turnos',
        path: 'TRACKER.md',
        branch: 'dev'
      })
    ).text
  );

  assert.equal(onMain.branch, null, 'no branch argument means the default branch');
  assert.equal(onDev.branch, 'dev');
  assert.notEqual(onMain.content, onDev.content);
  assert.match(onDev.content, /replica/);

  await harness.close();
});

test('get_project_summary combines status and the head of the README', async () => {
  const harness = await connect();

  const payload = JSON.parse(
    (await call(harness.client, 'get_project_summary', { repo: 'turnos', readme_chars: 200 })).text
  );

  assert.equal(payload.open_pull_requests, 2);
  assert.equal(payload.readme.path, 'README.md');
  assert.equal(payload.readme.truncated, true);
  assert.equal(payload.readme.excerpt.length, 200);

  await harness.close();
});

test('get_file_content returns the whole file, unfragmented', async () => {
  const harness = await connect();

  const payload = JSON.parse(
    (await call(harness.client, 'get_file_content', { repo: 'turnos', path: 'TRACKER.md' })).text
  );

  assert.equal(payload.path, 'TRACKER.md');
  assert.match(payload.content, /Migrar el envio de SMS/);
  assert.match(payload.content, /Reportes de asistencia/);

  await harness.close();
});

test('list_branches reports every branch and whether it is indexed', async () => {
  const harness = await connect();

  const before = JSON.parse(
    (await call(harness.client, 'list_branches', { repo: 'turnos' })).text
  );

  assert.equal(before.repo, 'example-org/turnos');
  const names = before.branches.map((branch: { name: string }) => branch.name);
  assert.ok(names.includes('main'));
  assert.ok(names.includes('dev'));
  assert.ok(names.includes('feat/pagos-online'), 'feature branches must be visible');

  const main = before.branches.find((branch: { name: string }) => branch.name === 'main');
  assert.equal(main.is_default, true);
  // Nothing indexed yet, so every branch reports indexed:false.
  assert.ok(before.branches.every((branch: { indexed: boolean }) => branch.indexed === false));

  await call(harness.client, 'refresh_index', { repo: 'turnos' });

  const after = JSON.parse((await call(harness.client, 'list_branches', { repo: 'turnos' })).text);
  const indexedNames = after.branches
    .filter((branch: { indexed: boolean }) => branch.indexed)
    .map((branch: { name: string }) => branch.name)
    .sort();

  assert.deepEqual(indexedNames, ['dev', 'main'], 'only configured branches were indexed');

  await harness.close();
});

test('list_branches on an unknown repo is a tool error, not a crash', async () => {
  const harness = await connect();

  const outcome = await call(harness.client, 'list_branches', { repo: 'inventado' });

  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /Unknown repo "inventado"/);

  await harness.close();
});

test('search_project_docs exposes how each result was matched', async () => {
  const harness = await connect();
  await call(harness.client, 'refresh_index', { repo: 'turnos' });

  const payload = JSON.parse(
    (
      await call(harness.client, 'search_project_docs', {
        query: 'notificaciones por SMS',
        repo: 'turnos'
      })
    ).text
  );

  assert.ok(payload.results.length > 0);
  for (const hit of payload.results) {
    assert.ok(['both', 'semantic', 'keyword'].includes(hit.matched_by));
    assert.equal(typeof hit.semantic_score, 'number');
  }
  // "SMS" is a literal term in the README, so the keyword half must fire.
  assert.ok(payload.results.some((hit: { matched_by: string }) => hit.matched_by === 'both'));

  await harness.close();
});
