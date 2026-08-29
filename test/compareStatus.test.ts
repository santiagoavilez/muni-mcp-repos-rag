import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ConfiguredRepo, ReposConfig } from '../src/config/repos.js';
import { ServerContext } from '../src/context.js';
import { NotFoundError } from '../src/core/errors.js';
import { MockGitHubClient, MockRepoFixture } from '../src/github/mockClient.js';
import {
  BranchSummary,
  CommitSummary,
  FileContent,
  GitHubClient,
  ProjectStatus,
  RepoMeta,
  TreeEntry
} from '../src/github/types.js';
import { Indexer } from '../src/rag/indexer.js';
import { VectorStore } from '../src/rag/store.js';
import { registerCompareStatus, wholeDaysSince } from '../src/tools/compareStatus.js';
import { FIXTURES, FakeEmbeddingProvider, tempDbPath, testConfig } from './fixtures.js';

interface InstrumentOptions {
  /** Aliases whose status call must blow up, to exercise partial failure. */
  failing?: string[];
  /** Aliases whose reported last_activity is forced to null. */
  nullActivity?: string[];
  /** Milliseconds each status call takes, so overlap is observable. */
  delayMs?: number;
}

/**
 * Wraps the in-memory GitHub client to record how many status calls overlap.
 * Concurrency is only observable from the outside as calls that were in flight
 * at the same time, so the mock has to keep the receipts itself.
 */
class InstrumentedGitHub implements GitHubClient {
  maxInFlight = 0;
  readonly statusCalls: string[] = [];
  private inFlight = 0;

  constructor(
    private readonly inner: MockGitHubClient,
    private readonly options: InstrumentOptions = {}
  ) {}

  async getProjectStatus(target: ConfiguredRepo): Promise<ProjectStatus> {
    this.statusCalls.push(target.alias);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise(resolve => setTimeout(resolve, this.options.delayMs ?? 1));
      if (this.options.failing?.includes(target.alias)) {
        throw new NotFoundError(`Not found on GitHub: ${target.fullName}.`);
      }
      const status = await this.inner.getProjectStatus(target);
      return this.options.nullActivity?.includes(target.alias)
        ? { ...status, last_activity: null }
        : status;
    } finally {
      this.inFlight -= 1;
    }
  }

  async getRepoMeta(target: ConfiguredRepo): Promise<RepoMeta> {
    return this.inner.getRepoMeta(target);
  }

  async getRecentCommits(target: ConfiguredRepo, limit: number): Promise<CommitSummary[]> {
    return this.inner.getRecentCommits(target, limit);
  }

  async getFileContent(target: ConfiguredRepo, path: string, ref?: string): Promise<FileContent> {
    return this.inner.getFileContent(target, path, ref);
  }

  async listTree(target: ConfiguredRepo, ref?: string): Promise<TreeEntry[]> {
    return this.inner.listTree(target, ref);
  }

  async listBranches(target: ConfiguredRepo): Promise<BranchSummary[]> {
    return this.inner.listBranches(target);
  }
}

interface HarnessOptions extends InstrumentOptions {
  config?: ReposConfig;
  fixtures?: Record<string, MockRepoFixture>;
}

interface Harness {
  client: Client;
  github: InstrumentedGitHub;
  close: () => Promise<void>;
}

async function connect(options: HarnessOptions = {}): Promise<Harness> {
  const config = options.config ?? testConfig();
  const github = new InstrumentedGitHub(
    new MockGitHubClient(options.fixtures ?? FIXTURES),
    options
  );
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
  registerCompareStatus(server, context);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return {
    client,
    github,
    close: async () => {
      await client.close();
      await server.close();
      store.close();
    }
  };
}

interface ComparedProject {
  alias: string;
  repo: string;
  last_activity: string | null;
  open_pull_requests: number;
  open_issues: number;
  days_since_default_branch_commit: number | null;
  days_since_any_activity: number | null;
  days_of_work_off_default_branch: number | null;
}

interface ComparePayload {
  checked_at: string;
  projects: ComparedProject[];
  failed: { repo: string; error: string }[];
  summary: {
    requested: number;
    succeeded: number;
    failed: number;
    total_open_pull_requests: number;
    total_open_issues: number;
  };
}

async function compare(
  harness: Harness,
  args: Record<string, unknown> = {}
): Promise<{ isError: boolean; payload: ComparePayload; text: string }> {
  const result = (await harness.client.callTool({
    name: 'compare_status',
    arguments: args
  })) as { isError?: boolean; content: { type: string; text?: string }[] };
  const text = result.content.map(entry => entry.text ?? '').join('\n');
  return {
    isError: result.isError === true,
    payload: result.isError === true ? (undefined as never) : (JSON.parse(text) as ComparePayload),
    text
  };
}

test('compare_status is registered, read-only and explains when to use it', async () => {
  const harness = await connect();

  const { tools } = await harness.client.listTools();
  const tool = tools.find(entry => entry.name === 'compare_status');

  assert.ok(tool, 'compare_status must be registered');
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.ok((tool.description ?? '').length > 80);
  // The description is the routing logic: it has to name the tools it is
  // confused with, or the model will keep calling those instead.
  assert.match(tool.description ?? '', /get_project_status/);
  assert.match(tool.description ?? '', /list_projects/);

  await harness.close();
});

test('compare_status with no arguments compares every configured repo', async () => {
  const harness = await connect();

  const { isError, payload } = await compare(harness);

  assert.equal(isError, false);
  assert.deepEqual(
    payload.projects.map(project => project.alias).sort(),
    ['tramites', 'turnos']
  );
  assert.equal(payload.failed.length, 0);
  assert.ok(!Number.isNaN(Date.parse(payload.checked_at)), 'checked_at must be an ISO instant');

  await harness.close();
});

test('compare_status with an explicit subset compares only those repos', async () => {
  const harness = await connect();

  const { payload } = await compare(harness, { repos: ['turnos'] });

  assert.deepEqual(payload.projects.map(project => project.alias), ['turnos']);
  assert.deepEqual(harness.github.statusCalls, ['turnos']);
  assert.equal(payload.summary.requested, 1);

  await harness.close();
});

test('an unknown alias lands in failed while the valid repos still return', async () => {
  const harness = await connect();

  const { isError, payload } = await compare(harness, { repos: ['turnos', 'inventado'] });

  assert.equal(isError, false, 'one bad reference must not fail the whole call');
  assert.deepEqual(payload.projects.map(project => project.alias), ['turnos']);
  assert.equal(payload.failed.length, 1);
  assert.equal(payload.failed[0].repo, 'inventado');
  assert.match(payload.failed[0].error, /Unknown repo "inventado"/);

  await harness.close();
});

test('a repo whose GitHub call throws lands in failed, the others still succeed', async () => {
  const harness = await connect({ failing: ['tramites'] });

  const { payload } = await compare(harness);

  assert.deepEqual(payload.projects.map(project => project.alias), ['turnos']);
  assert.equal(payload.failed.length, 1);
  assert.equal(payload.failed[0].repo, 'tramites');
  assert.match(payload.failed[0].error, /Not found on GitHub/);

  await harness.close();
});

test('results are sorted by most recent activity, nulls last', async () => {
  const config = testConfig({
    repos: [
      { alias: 'tramites', repo: 'tramites', description: 'Gestion de tramites' },
      { alias: 'quieto', repo: 'quieto', description: 'Sin actividad' },
      { alias: 'turnos', repo: 'turnos', description: 'Sistema de turnos online' }
    ]
  });
  const harness = await connect({
    config,
    fixtures: { ...FIXTURES, quieto: { commits: [] } },
    nullActivity: ['quieto']
  });

  const { payload } = await compare(harness);

  // turnos pushed 2026-02-01, tramites 2026-01-15, quieto never.
  assert.deepEqual(
    payload.projects.map(project => project.alias),
    ['turnos', 'tramites', 'quieto']
  );

  await harness.close();
});

test('a repo with no commits yields null day counts, never NaN', async () => {
  const harness = await connect();

  const { payload } = await compare(harness, { repos: ['tramites'] });
  const tramites = payload.projects[0];

  assert.equal(tramites.days_since_default_branch_commit, null);
  assert.equal(tramites.days_of_work_off_default_branch, null);
  assert.equal(typeof tramites.days_since_any_activity, 'number');

  // JSON serialises NaN as null, so the boundary cannot tell them apart: the
  // arithmetic itself has to be asserted directly.
  assert.equal(wholeDaysSince(null, Date.now()), null);
  assert.equal(wholeDaysSince('no-es-una-fecha', Date.now()), null);
  assert.equal(wholeDaysSince('2026-02-01T12:00:00Z', Date.parse('2026-02-04T12:00:00Z')), 3);

  await harness.close();
});

test('days_of_work_off_default_branch is 0, not negative, when the commit is newer', async () => {
  const harness = await connect({
    fixtures: {
      ...FIXTURES,
      turnos: {
        ...FIXTURES.turnos,
        last_activity: '2026-02-01T12:00:00Z',
        commits: [
          {
            sha: 'cccccccccccccccc',
            short_sha: 'ccccccc',
            author: 'Ana',
            date: '2026-02-10T12:00:00Z',
            message: 'feat: commit posterior al push registrado',
            url: 'https://github.com/example-org/turnos/commit/ccccccc'
          }
        ]
      }
    }
  });

  const { payload } = await compare(harness, { repos: ['turnos'] });

  assert.equal(payload.projects[0].days_of_work_off_default_branch, 0);

  await harness.close();
});

test('never more than four repos are in flight at once', async () => {
  const aliases = ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis'];
  const config = testConfig({
    repos: aliases.map(alias => ({ alias, repo: alias, description: alias }))
  });
  const fixtures = Object.fromEntries(
    aliases.map(alias => [alias, { commits: [] } as MockRepoFixture])
  );

  const harness = await connect({ config, fixtures, delayMs: 20 });

  const { payload } = await compare(harness);

  assert.equal(payload.projects.length, 6);
  assert.ok(
    harness.github.maxInFlight <= 4,
    `expected at most 4 concurrent status calls, saw ${harness.github.maxInFlight}`
  );
  assert.ok(harness.github.maxInFlight > 1, 'the calls must still overlap, not run one by one');

  await harness.close();
});

test('summary counts match the projects and failed arrays', async () => {
  const harness = await connect();

  const { payload } = await compare(harness, { repos: ['turnos', 'tramites', 'inventado'] });

  assert.equal(payload.summary.requested, 3);
  assert.equal(payload.summary.succeeded, payload.projects.length);
  assert.equal(payload.summary.failed, payload.failed.length);
  assert.equal(payload.summary.succeeded, 2);
  assert.equal(payload.summary.failed, 1);
  // turnos has 2 open PRs and 5 open issues, tramites 0 and 1.
  assert.equal(payload.summary.total_open_pull_requests, 2);
  assert.equal(payload.summary.total_open_issues, 6);

  await harness.close();
});
