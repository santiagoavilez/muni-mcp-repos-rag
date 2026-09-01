import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfiguredRepo } from '../src/config/repos.js';
import { GitHubClient } from '../src/github/types.js';
import { AutoIndexContext, scheduleStartupRefresh } from '../src/rag/autoIndex.js';
import { IndexReport, Indexer } from '../src/rag/indexer.js';
import { selectStaleRepos } from '../src/rag/staleness.js';
import { IndexStats, VectorStore } from '../src/rag/store.js';
import { FakeEmbeddingProvider, tempDbPath, testConfig, testGitHub } from './fixtures.js';

const NOW = new Date('2026-08-29T12:00:00.000Z');
/** El modelo que reporta el FakeEmbeddingProvider de los fixtures. */
const MODEL = 'fake-test-model';
const TURNOS = 'example-org/turnos';
const TRAMITES = 'example-org/tramites';

/** Horas antes de NOW, como el string ISO que habría escrito el store. */
function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

function run(branch: string, repo: string, indexedAt: string, model = MODEL): IndexStats {
  return { repo, branch, model, chunks: 1, files: 1, indexed_at: indexedAt };
}

function aliases(repos: ConfiguredRepo[]): string[] {
  return repos.map(repo => repo.alias).sort();
}

const REPOS = testConfig().all;

test('a max age of zero disables staleness entirely', () => {
  // Ni siquiera cuenta un repo que nunca se indexó: 0 significa que la
  // funcionalidad está apagada, y un interruptor "apagado" que igual dispara un
  // reindexado completo no está apagado.
  assert.deepEqual(selectStaleRepos(REPOS, [], 0, NOW, MODEL), []);
  assert.deepEqual(selectStaleRepos(REPOS, [], -1, NOW, MODEL), []);
});

test('a configured repo with no index run at all is stale', () => {
  const stats = [run('main', TURNOS, hoursAgo(1))];

  assert.deepEqual(aliases(selectStaleRepos(REPOS, stats, 12, NOW, MODEL)), ['tramites']);
});

test('staleness is decided per repo by the age of its newest run', () => {
  const stale = [run('main', TURNOS, hoursAgo(13)), run('main', TRAMITES, hoursAgo(1))];

  assert.deepEqual(aliases(selectStaleRepos(REPOS, stale, 12, NOW, MODEL)), ['turnos']);

  const fresh = [run('main', TURNOS, hoursAgo(11)), run('main', TRAMITES, hoursAgo(1))];
  assert.deepEqual(selectStaleRepos(REPOS, fresh, 12, NOW, MODEL), []);
});

test('a repo with several branches is judged by its newest branch, not its oldest', () => {
  const stats = [
    run('main', TURNOS, hoursAgo(400)),
    run('dev', TURNOS, hoursAgo(2)),
    run('feat/pagos-online', TURNOS, hoursAgo(90)),
    run('main', TRAMITES, hoursAgo(1))
  ];

  assert.deepEqual(selectStaleRepos(REPOS, stats, 12, NOW, MODEL), []);
});

test('an unparseable indexed_at counts as stale', () => {
  const stats = [run('main', TURNOS, 'whenever'), run('main', TRAMITES, hoursAgo(1))];

  assert.deepEqual(aliases(selectStaleRepos(REPOS, stats, 12, NOW, MODEL)), ['turnos']);
});

test('a recent run made with another embedding model still counts as stale', () => {
  // No es solamente viejo: un índice construido por otro modelo responde las
  // consultas con los vectores equivocados, y que coincida la cantidad de
  // dimensiones lo esconde al consultar. Solo las corridas hechas con el modelo
  // ACTUAL pueden certificar la frescura.
  const stats = [
    run('main', TURNOS, hoursAgo(1), 'some-other-model'),
    run('main', TRAMITES, hoursAgo(1))
  ];

  assert.deepEqual(aliases(selectStaleRepos(REPOS, stats, 12, NOW, MODEL)), ['turnos']);
});

/** Cuenta los listados de ramas, que son exactamente uno por repo por corrida real. */
function countingGitHub(): { github: GitHubClient; listings: () => number } {
  const github = testGitHub();
  let listings = 0;
  const original = github.listBranches.bind(github);
  github.listBranches = async target => {
    listings += 1;
    return original(target);
  };
  return { github, listings: () => listings };
}

test('two concurrent refreshes of the same scope are one single run', async () => {
  const store = new VectorStore(tempDbPath());
  const embeddings = new FakeEmbeddingProvider();
  const { github, listings } = countingGitHub();
  const indexer = new Indexer(testConfig(), github, embeddings, store);

  const [first, second] = await Promise.all([indexer.refresh('turnos'), indexer.refresh('turnos')]);

  assert.equal(listings(), 1, 'the second caller must join the run, not start another');
  assert.equal(first, second, 'and must be handed the very same report');
  assert.equal(first.results[0]!.error, null);

  store.close();
});

test('a failed run releases the guard instead of poisoning every later refresh', async () => {
  const store = new VectorStore(tempDbPath());
  const embeddings = new FakeEmbeddingProvider();
  const { github, listings } = countingGitHub();
  const indexer = new Indexer(testConfig(), github, embeddings, store);

  await assert.rejects(() => indexer.refresh('does-not-exist'));
  // Dos veces a propósito: una promesa rechazada estacionada bajo este alcance
  // se devolvería para siempre, y desde afuera eso se ve idéntico.
  await assert.rejects(() => indexer.refresh('does-not-exist'));

  const report = await indexer.refresh('turnos');

  assert.equal(listings(), 1, 'the later refresh has to actually reach GitHub');
  assert.equal(report.results[0]!.error, null);
  assert.ok(embeddings.embedded.length > 0);

  store.close();
});

/** Un stub de contexto: el scheduler no debe necesitar ni base de datos ni red. */
function stubContext(
  stats: IndexStats[],
  refresh: (reference?: string) => Promise<IndexReport>
): AutoIndexContext {
  return {
    config: { all: REPOS },
    store: { stats: () => stats },
    embeddings: { model: MODEL },
    indexer: { refresh }
  };
}

function emptyReport(): IndexReport {
  return { model: 'fake-test-model', results: [], indexed_at: NOW.toISOString() };
}

test('the scheduler does nothing at all when no repo is stale', async () => {
  const asked: string[] = [];
  const context = stubContext(
    [run('main', TURNOS, hoursAgo(1)), run('main', TRAMITES, hoursAgo(1))],
    async reference => {
      asked.push(reference ?? '(all)');
      return emptyReport();
    }
  );

  await scheduleStartupRefresh(context, { maxAgeHours: 12, now: NOW });

  assert.deepEqual(asked, []);
});

test('one failing repo neither throws out of the scheduler nor stops the next one', async () => {
  const asked: string[] = [];
  const context = stubContext([], async reference => {
    asked.push(reference ?? '(all)');
    if (reference === 'turnos') throw new Error('GitHub is down');
    return emptyReport();
  });

  await scheduleStartupRefresh(context, { maxAgeHours: 12, now: NOW });

  assert.deepEqual(asked, ['turnos', 'tramites'], 'every stale repo must be attempted');
});

/**
 * Captura stderr mientras dura `body`. El scheduler reporta todo lo que hace por
 * console.error, así que eso ES su comportamiento observable.
 */
async function captureStderr(body: () => Promise<void>): Promise<string> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => void lines.push(args.join(' '));
  try {
    await body();
  } finally {
    console.error = original;
  }
  return lines.join('\n');
}

test('a branch-level failure is named in the log, not reported as an empty success', async () => {
  // La falla de arranque más probable por lejos: Ollama todavía no está
  // levantado. Fallan todas las ramas mientras el REPO sale bien, así que un
  // resumen que solo mira los errores de repo imprime "0 files, 0 chunks" y
  // parece un repo que simplemente no tiene documentación.
  const report: IndexReport = {
    model: 'fake-test-model',
    results: [
      {
        repo: TURNOS,
        alias: 'turnos',
        branches: [
          {
            branch: 'main',
            files: 0,
            chunks: 0,
            embedded_chunks: 0,
            reused_chunks: 0,
            active: false,
            skipped: [],
            error: 'connect ECONNREFUSED 127.0.0.1:11434'
          }
        ],
        files: 0,
        chunks: 0,
        embedded_chunks: 0,
        reused_chunks: 0,
        missing_branches: [],
        pruned_branches: 0,
        error: null
      }
    ],
    indexed_at: NOW.toISOString()
  };

  const context = stubContext([], async () => report);
  const logged = await captureStderr(() =>
    scheduleStartupRefresh(context, { maxAgeHours: 12, now: NOW })
  );

  assert.match(
    logged,
    /ECONNREFUSED/,
    'the reason a branch failed must reach the log, or nobody will look for it'
  );
  assert.match(logged, /1 branch failure/);
});
