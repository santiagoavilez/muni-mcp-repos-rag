import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { Indexer } from '../src/rag/indexer.js';
import { VectorStore, normalizeVector } from '../src/rag/store.js';
import { FakeEmbeddingProvider, tempDbPath, testConfig, testGitHub } from './fixtures.js';

function buildIndexer(): { indexer: Indexer; store: VectorStore; embeddings: FakeEmbeddingProvider } {
  const store = new VectorStore(tempDbPath());
  const embeddings = new FakeEmbeddingProvider();
  const indexer = new Indexer(testConfig(), testGitHub(), embeddings, store);
  return { indexer, store, embeddings };
}

test('normalizeVector yields a unit vector and leaves a zero vector alone', () => {
  const unit = normalizeVector([3, 4]);
  assert.ok(Math.abs(Math.hypot(unit[0]!, unit[1]!) - 1) < 1e-9);
  assert.deepEqual(normalizeVector([0, 0]), [0, 0]);
});

test('a corrupt index.db is quarantined instead of taking the server down', () => {
  const dbPath = tempDbPath();
  // La misma falla que deja una copia truncada o una escritura con el disco
  // lleno: un archivo que existe pero que directamente no es una base SQLite.
  writeFileSync(dbPath, 'not a sqlite file');

  const store = new VectorStore(dbPath);
  assert.equal(store.totalChunks(), 0, 'the fresh replacement store must be usable');
  store.close();

  assert.ok(existsSync(dbPath), 'a new, valid database now lives at the original path');
  const quarantined = readdirSync(dirname(dbPath)).filter(name => name.includes('.corrupt-'));
  assert.equal(quarantined.length, 1, 'the unreadable file must be moved aside, not deleted');
});

test('indexing only picks up the configured docs, never source code', async () => {
  const { indexer, store } = buildIndexer();

  const report = await indexer.refresh('turnos');
  const result = report.results[0]!;

  assert.equal(result.error, null);
  assert.equal(result.repo, 'example-org/turnos');
  assert.ok(result.chunks > 0);
  assert.ok(store.totalChunks({ repo: 'example-org/turnos' }) > 0);

  const hit = store.search(await new FakeEmbeddingProvider().embedQuery('turno'), 50);
  const paths = new Set(hit.map(entry => entry.path));
  assert.ok(paths.has('README.md'));
  assert.ok(paths.has('docs/NEGOCIO.md'), 'the docs/** glob should be expanded');
  assert.ok(!paths.has('src/app.ts'), 'source code must never be indexed');

  store.close();
});

test('search ranks the section that actually answers the question first', async () => {
  const { indexer, store, embeddings } = buildIndexer();
  await indexer.refresh();

  const hits = store.search(await embeddings.embedQuery('como se autentican los vecinos'), 3);

  assert.ok(hits.length > 0);
  assert.equal(hits[0]!.heading, 'Autenticacion');
  assert.equal(hits[0]!.repo, 'example-org/turnos');
  assert.ok(hits[0]!.score > 0);

  store.close();
});

test('search scoped to one repo never returns another repo', async () => {
  const { indexer, store, embeddings } = buildIndexer();
  await indexer.refresh();

  const hits = store.search(await embeddings.embedQuery('tramites'), 10, { repo: 'example-org/turnos' });

  assert.ok(hits.length > 0);
  assert.ok(hits.every(hit => hit.repo === 'example-org/turnos'));

  store.close();
});

test('reindexing replaces the previous chunks instead of duplicating them', async () => {
  const { indexer, store } = buildIndexer();

  await indexer.refresh('turnos');
  const first = store.totalChunks({ repo: 'example-org/turnos' });

  await indexer.refresh('turnos');
  assert.equal(store.totalChunks({ repo: 'example-org/turnos' }), first);

  store.close();
});

test('a repo that fails to index does not abort the others', async () => {
  const store = new VectorStore(tempDbPath());
  const config = testConfig();
  const github = testGitHub();
  // Se rompe exactamente un repo, tal como lo haría un GitHub inalcanzable.
  const broken = {
    listTree: github.listTree.bind(github),
    listBranches: github.listBranches.bind(github),
    getRepoMeta: github.getRepoMeta.bind(github),
    getProjectStatus: github.getProjectStatus.bind(github),
    getRecentCommits: github.getRecentCommits.bind(github),
    getFileContent: async (target: { alias: string }, path: string, ref?: string) => {
      if (target.alias === 'tramites') throw new Error('boom: network down');
      return github.getFileContent(target as never, path, ref);
    }
  };

  const report = await new Indexer(
    config,
    broken as never,
    new FakeEmbeddingProvider(),
    store
  ).refresh();

  const turnos = report.results.find(result => result.alias === 'turnos')!;
  const tramites = report.results.find(result => result.alias === 'tramites')!;

  assert.equal(turnos.error, null);
  assert.ok(turnos.chunks > 0);
  // La falla se reporta por archivo, y el repo igual termina con 0 chunks.
  assert.equal(tramites.chunks, 0);
  assert.ok(
    tramites.branches.some(branch =>
      branch.skipped.some(entry => /boom: network down/.test(entry))
    )
  );

  store.close();
});

test('index stats record what was written', async () => {
  const { indexer, store } = buildIndexer();
  await indexer.refresh('turnos');

  const stats = store.statsFor('example-org/turnos').find(entry => entry.branch === 'main')!;
  assert.equal(stats.repo, 'example-org/turnos');
  assert.ok(stats.files >= 3);
  assert.ok(stats.chunks > 0);
  assert.ok(Date.parse(stats.indexed_at) > 0);

  store.close();
});
