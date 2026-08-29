import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Indexer } from '../src/rag/indexer.js';
import { VectorStore } from '../src/rag/store.js';
import { FakeEmbeddingProvider, tempDbPath, testConfig, testGitHub } from './fixtures.js';

function build(options: Parameters<typeof testConfig>[0] = {}) {
  const store = new VectorStore(tempDbPath());
  const embeddings = new FakeEmbeddingProvider();
  const config = testConfig(options);
  return { store, embeddings, indexer: new Indexer(config, testGitHub(), embeddings, store) };
}

test('indexes every configured branch that exists, and reports the ones that do not', async () => {
  const { indexer, store } = build();

  const report = await indexer.refresh('turnos');
  const result = report.results[0]!;

  assert.deepEqual(
    result.branches.map(branch => branch.branch).sort(),
    ['dev', 'main']
  );
  assert.ok(result.branches.every(branch => branch.error === null));
  assert.ok(store.totalChunks({ repo: 'example-org/turnos', branch: 'main' }) > 0);
  assert.ok(store.totalChunks({ repo: 'example-org/turnos', branch: 'dev' }) > 0);

  // tramites has no dev branch — that is a note, never a failure.
  const tramites = (await indexer.refresh('tramites')).results[0]!;
  assert.equal(tramites.error, null);
  assert.deepEqual(tramites.missing_branches, ['dev']);
  assert.deepEqual(
    tramites.branches.map(branch => branch.branch),
    ['main']
  );

  store.close();
});

test('the same file on two branches is stored separately, with its own content', async () => {
  const { indexer, store, embeddings } = build();
  await indexer.refresh('turnos');

  const hits = store.search(await embeddings.embedQuery('reportes de asistencia'), 20, {
    repo: 'example-org/turnos'
  });
  const tracker = hits.filter(hit => hit.path === 'TRACKER.md');

  // Identical text on both branches collapses into ONE hit naming both...
  const shared = tracker.filter(hit => hit.branches.length > 1);
  assert.ok(shared.length > 0, 'identical chunks must collapse across branches');
  assert.ok(shared.every(hit => hit.branches.join() === 'main,dev' || hit.branches.join() === 'dev,main'));

  // ...while text that differs stays separate and is attributed correctly.
  const onlyDev = tracker.find(hit => /replica/.test(hit.content))!;
  assert.deepEqual(onlyDev.branches, ['dev'], 'dev-only content belongs to dev alone');

  const onlyMain = tracker.find(hit => /Pendiente/.test(hit.content))!;
  assert.deepEqual(onlyMain.branches, ['main']);

  store.close();
});

test('a branch filter restricts the search to that branch only', async () => {
  const { indexer, store, embeddings } = build();
  await indexer.refresh('turnos');

  const hits = store.search(await embeddings.embedQuery('turnos'), 20, {
    repo: 'example-org/turnos',
    branch: 'dev'
  });

  assert.ok(hits.length > 0);
  assert.ok(hits.every(hit => hit.branches.every(branch => branch === 'dev')));

  store.close();
});

test('feature-branch docs are invisible until the active window is enabled', async () => {
  // Default config: only main and dev. The pagos doc lives on a feature branch.
  const off = build();
  await off.indexer.refresh('turnos');
  const missed = off.store.search(await off.embeddings.embedQuery('pagos con tarjeta'), 20, {
    repo: 'example-org/turnos'
  });
  assert.equal(
    missed.filter(hit => hit.path === 'docs/PAGOS.md').length,
    0,
    'without the active window, work in progress must not be indexed'
  );
  off.store.close();

  // Same repo, same fixtures, activeBranchDays on.
  const on = build({ activeBranchDays: 30 });
  const result = (await on.indexer.refresh('turnos')).results[0]!;

  const active = result.branches.filter(branch => branch.active).map(branch => branch.branch);
  assert.ok(active.includes('feat/pagos-online'), 'the recent feature branch is picked up');
  assert.ok(!active.includes('feat/abandonada'), 'the stale branch stays out');
  assert.ok(!active.includes('main') && !active.includes('dev'), 'configured branches are not "active"');

  const found = on.store.search(await on.embeddings.embedQuery('pagos con tarjeta'), 20, {
    repo: 'example-org/turnos'
  });
  const pagos = found.find(hit => hit.path === 'docs/PAGOS.md');
  assert.ok(pagos, 'the feature branch doc should now be searchable');
  assert.deepEqual(pagos.branches, ['feat/pagos-online']);

  on.store.close();
});

test('a stale branch is outside the window and never indexed', async () => {
  const { indexer, store } = build({ activeBranchDays: 30 });
  const result = (await indexer.refresh('turnos')).results[0]!;

  assert.ok(
    !result.branches.some(branch => branch.branch === 'feat/abandonada'),
    'a branch untouched for years must not be indexed'
  );

  store.close();
});

test('maxActiveBranches caps how many feature branches are indexed', async () => {
  // Two branches are inside the window; the cap must let exactly one through,
  // and it must be the most recently pushed one.
  const uncapped = build({ activeBranchDays: 30 });
  const all = (await uncapped.indexer.refresh('turnos')).results[0]!;
  assert.equal(all.branches.filter(branch => branch.active).length, 2);
  uncapped.store.close();

  const capped = build({ activeBranchDays: 30, maxActiveBranches: 1 });
  const result = (await capped.indexer.refresh('turnos')).results[0]!;
  const active = result.branches.filter(branch => branch.active);

  assert.equal(active.length, 1);
  assert.equal(active[0]!.branch, 'feat/pagos-online', 'newest active branch wins');

  capped.store.close();
});

test('branches that fall out of the config are pruned from the index', async () => {
  const dbPath = tempDbPath();
  const embeddings = new FakeEmbeddingProvider();
  const github = testGitHub();

  // First run indexes the feature branch too.
  const wide = new VectorStore(dbPath);
  await new Indexer(testConfig({ activeBranchDays: 30 }), github, embeddings, wide).refresh(
    'turnos'
  );
  assert.ok(wide.totalChunks({ repo: 'example-org/turnos', branch: 'feat/pagos-online' }) > 0);
  wide.close();

  // Second run, window disabled: the feature branch must disappear, and the
  // configured branches must survive untouched.
  const narrow = new VectorStore(dbPath);
  const result = (
    await new Indexer(testConfig(), github, embeddings, narrow).refresh('turnos')
  ).results[0]!;

  assert.ok(result.pruned_branches > 0);
  assert.equal(narrow.totalChunks({ repo: 'example-org/turnos', branch: 'feat/pagos-online' }), 0);
  assert.ok(narrow.totalChunks({ repo: 'example-org/turnos', branch: 'main' }) > 0);
  assert.deepEqual(
    narrow.statsFor('example-org/turnos').map(entry => entry.branch),
    ['dev', 'main']
  );

  narrow.close();
});

test('a branch that fails does not take the other branches down with it', async () => {
  const store = new VectorStore(tempDbPath());
  const github = testGitHub();

  const broken = {
    listBranches: github.listBranches.bind(github),
    getRepoMeta: github.getRepoMeta.bind(github),
    getProjectStatus: github.getProjectStatus.bind(github),
    getRecentCommits: github.getRecentCommits.bind(github),
    listTree: async (target: unknown, ref?: string) => {
      if (ref === 'dev') throw new Error('boom: dev unreachable');
      return github.listTree(target as never, ref);
    },
    getFileContent: github.getFileContent.bind(github)
  };

  const result = (
    await new Indexer(testConfig(), broken as never, new FakeEmbeddingProvider(), store).refresh(
      'turnos'
    )
  ).results[0]!;

  const main = result.branches.find(branch => branch.branch === 'main')!;
  const dev = result.branches.find(branch => branch.branch === 'dev')!;

  assert.equal(main.error, null);
  assert.ok(main.chunks > 0);
  assert.match(dev.error ?? '', /boom: dev unreachable/);
  // The repo itself is not marked failed: most of it indexed fine.
  assert.equal(result.error, null);

  store.close();
});

test('a stale v1 index is dropped instead of being read with the wrong shape', async () => {
  const dbPath = tempDbPath();

  // Recreate the schema the first release shipped: no `branch` column.
  const { default: Database } = await import('better-sqlite3');
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY, repo TEXT NOT NULL, alias TEXT NOT NULL, path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL, heading TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
      embedding BLOB NOT NULL, dimensions INTEGER NOT NULL, indexed_at TEXT NOT NULL
    );
    CREATE TABLE index_runs (
      repo TEXT PRIMARY KEY, model TEXT NOT NULL, files INTEGER NOT NULL,
      chunks INTEGER NOT NULL, indexed_at TEXT NOT NULL
    );
    INSERT INTO chunks VALUES (1,'example-org/turnos','turnos','README.md',0,'h','texto',x'00000000',1,'2026-01-01');
  `);
  legacy.close();

  const store = new VectorStore(dbPath);

  // Dropped, not silently reused: the old rows cannot say which branch they are.
  assert.equal(store.totalChunks(), 0);

  // And the new schema works on the same file.
  const indexer = new Indexer(testConfig(), testGitHub(), new FakeEmbeddingProvider(), store);
  await indexer.refresh('turnos');
  assert.ok(store.totalChunks({ repo: 'example-org/turnos', branch: 'dev' }) > 0);

  store.close();
});
