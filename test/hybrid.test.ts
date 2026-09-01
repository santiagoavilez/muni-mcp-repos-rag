import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Indexer } from '../src/rag/indexer.js';
import { VectorStore, toFtsQuery } from '../src/rag/store.js';
import { FakeEmbeddingProvider, tempDbPath, testConfig, testGitHub } from './fixtures.js';

/**
 * El proveedor de embeddings falso tiene un vocabulario minúsculo, así que un
 * término fuera de él es INVISIBLE para la mitad semántica, exactamente como lo
 * es un nombre propio raro para un modelo de embeddings real. Eso es lo que hace
 * significativos a estos tests: todo lo que se encuentre acá lo encontró la mitad
 * por palabra clave.
 */
async function indexed(): Promise<{ store: VectorStore; embeddings: FakeEmbeddingProvider }> {
  const store = new VectorStore(tempDbPath());
  const embeddings = new FakeEmbeddingProvider();
  const config = testConfig({ activeBranchDays: 30 });
  await new Indexer(config, testGitHub(), embeddings, store).refresh();
  return { store, embeddings };
}

test('toFtsQuery quotes every term and drops noise', () => {
  assert.equal(toFtsQuery('pagos con tarjeta'), '"pagos" OR "tarjeta"');

  // Las stopwords y los tokens de una o dos letras no aportan señal.
  assert.equal(toFtsQuery('como se hace el pago'), '"pago"');

  // Los duplicados colapsan.
  assert.equal(toFtsQuery('pagos pagos pagos'), '"pagos"');

  // Que no haya nada usable tiene que dar null, no una expresión rota.
  assert.equal(toFtsQuery(''), null);
  assert.equal(toFtsQuery('de la el'), null);
});

test('FTS5 operators in a question are treated as literal text, not syntax', () => {
  // Cada uno de estos sería un error de sintaxis si se pasara crudo.
  for (const hostile of [
    'que pasa con AND OR NOT',
    'busca "comillas" sin cerrar"',
    'parentesis ( sin cerrar',
    'guion-medio y asterisco *',
    'NEAR(a b, 3)'
  ]) {
    const query = toFtsQuery(hostile);
    if (query === null) continue;
    // Todo término va entre comillas, así no sobrevive ningún operador suelto.
    const bare = query.split(' OR ').filter(term => !/^".*"$/.test(term));
    assert.deepEqual(bare, [], `unquoted term in: ${query}`);
  }
});

test('a hostile query returns results instead of throwing', async () => {
  const { store, embeddings } = await indexed();

  const hits = store.search(
    await embeddings.embedQuery('pagos'),
    5,
    {},
    'pagos AND ( "roto NEAR(x y, 2) *'
  );

  assert.ok(hits.length > 0, 'the search must degrade, never fail');

  store.close();
});

test('an exact rare term is found even when the embedding is blind to it', async () => {
  const { store, embeddings } = await indexed();

  // "provincial" NO está en el vocabulario falso, así que la mitad semántica no
  // puede distinguirlo. Solo BM25 puede.
  const semanticOnly = store.search(await embeddings.embedQuery('provincial'), 5, {});
  const hybrid = store.search(await embeddings.embedQuery('provincial'), 5, {}, 'provincial');

  const pagosSemantic = semanticOnly.findIndex(hit => hit.path === 'docs/PAGOS.md');
  const pagosHybrid = hybrid.findIndex(hit => hit.path === 'docs/PAGOS.md');

  assert.ok(pagosHybrid >= 0, 'the keyword half must surface the document');
  assert.ok(
    pagosSemantic === -1 || pagosHybrid < pagosSemantic,
    `hybrid should rank it better (semantic ${pagosSemantic}, hybrid ${pagosHybrid})`
  );
  assert.equal(hybrid[pagosHybrid]!.matched_by, 'both');

  store.close();
});

test('a keyword hit is reported as matched_by both, a semantic-only hit is not', async () => {
  const { store, embeddings } = await indexed();

  const hits = store.search(await embeddings.embedQuery('pasarela provincial'), 10, {}, 'pasarela');

  const matched = hits.filter(hit => hit.matched_by === 'both');
  assert.ok(matched.length > 0);
  assert.ok(matched.every(hit => hit.keyword_rank !== null));

  const semantic = hits.filter(hit => hit.matched_by === 'semantic');
  assert.ok(semantic.every(hit => hit.keyword_rank === null));

  store.close();
});

test('the semantic half still works when no keyword matches', async () => {
  const { store, embeddings } = await indexed();

  // Un término que no aparece en ningún lado: la mitad por palabra clave no aporta nada.
  const hits = store.search(
    await embeddings.embedQuery('autenticacion'),
    5,
    {},
    'zzzzinexistente'
  );

  assert.ok(hits.length > 0);
  assert.ok(hits.every(hit => hit.matched_by === 'semantic'));
  assert.equal(hits[0]!.heading, 'Autenticacion');

  store.close();
});

test('the keyword half respects the repo and branch scope', async () => {
  const { store, embeddings } = await indexed();

  const scoped = store.search(
    await embeddings.embedQuery('tramites'),
    20,
    { repo: 'example-org/turnos' },
    'tramites'
  );
  assert.ok(scoped.every(hit => hit.repo === 'example-org/turnos'));

  const branchScoped = store.search(
    await embeddings.embedQuery('pagos'),
    20,
    { repo: 'example-org/turnos', branch: 'main' },
    'pagos tarjeta'
  );
  assert.ok(branchScoped.every(hit => hit.branches.every(branch => branch === 'main')));
  // docs/PAGOS.md vive solo en la feature branch, así que acotar a main lo esconde.
  assert.ok(!branchScoped.some(hit => hit.path === 'docs/PAGOS.md'));

  store.close();
});

test('accents do not change what the keyword half finds', async () => {
  const { store, embeddings } = await indexed();

  const withAccent = store.search(await embeddings.embedQuery('integracion'), 10, {}, 'integración');
  const without = store.search(await embeddings.embedQuery('integracion'), 10, {}, 'integracion');

  const paths = (hits: { path: string }[]) => hits.map(hit => hit.path).join();
  assert.equal(paths(withAccent), paths(without));
  assert.ok(withAccent.some(hit => hit.path === 'docs/PAGOS.md'));

  store.close();
});

test('the keyword index is rebuilt on reindex, so deleted text stops matching', async () => {
  const dbPath = tempDbPath();
  const embeddings = new FakeEmbeddingProvider();

  const wide = new VectorStore(dbPath);
  await new Indexer(
    testConfig({ activeBranchDays: 30 }),
    testGitHub(),
    embeddings,
    wide
  ).refresh('turnos');
  assert.ok(
    wide.search(await embeddings.embedQuery('pagos'), 10, {}, 'pasarela').some(
      hit => hit.path === 'docs/PAGOS.md'
    )
  );
  wide.close();

  // Reindexado sin la ventana de actividad: la feature branch se poda, y su texto
  // tiene que desaparecer también del índice por palabra clave, no solo de `chunks`.
  const narrow = new VectorStore(dbPath);
  await new Indexer(testConfig(), testGitHub(), embeddings, narrow).refresh('turnos');

  const stale = narrow.search(await embeddings.embedQuery('pagos'), 10, {}, 'pasarela');
  assert.ok(
    !stale.some(hit => hit.path === 'docs/PAGOS.md'),
    'pruned content must not survive in the keyword index'
  );

  narrow.close();
});
