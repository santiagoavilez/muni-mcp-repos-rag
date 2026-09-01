import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReposConfig, loadReposConfig } from '../src/config/repos.js';
import { MockGitHubClient, MockRepoFixture } from '../src/github/mockClient.js';
import { EmbeddingProvider } from '../src/rag/embeddings.js';

export const TURNOS_README = `# Sistema de Turnos

Permite a los vecinos sacar turno online para tramites.

## Autenticacion

Los vecinos se autentican con su DNI y una clave que llega por correo.
No usamos usuario y contrasena tradicionales.

## Notificaciones

Cada turno confirmado dispara un correo y un SMS al vecino.
`;

export const TURNOS_TRACKER = `# TRACKER

## En curso

- Migrar el envio de SMS a un proveedor nuevo.

## Pendiente

- Reportes de asistencia por area.
`;

/** Hace dos días: cómodamente dentro de cualquier ventana sensata de activeBranchDays. */
export const RECENT_ISO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

export const FIXTURES: Record<string, MockRepoFixture> = {
  turnos: {
    description: 'Sistema de turnos online',
    default_branch: 'main',
    last_activity: '2026-02-01T12:00:00Z',
    open_pull_requests: 2,
    open_issues: 5,
    commits: [
      {
        sha: 'aaaaaaaaaaaaaaaa',
        short_sha: 'aaaaaaa',
        author: 'Ana',
        date: '2026-02-01T12:00:00Z',
        message: 'feat: recordatorio por SMS',
        url: 'https://github.com/example-org/turnos/commit/aaaaaaa'
      },
      {
        sha: 'bbbbbbbbbbbbbbbb',
        short_sha: 'bbbbbbb',
        author: 'Beto',
        date: '2026-01-28T09:30:00Z',
        message: 'fix: zona horaria en la agenda',
        url: 'https://github.com/example-org/turnos/commit/bbbbbbb'
      }
    ],
    files: {
      'README.md': TURNOS_README,
      'TRACKER.md': TURNOS_TRACKER,
      'docs/NEGOCIO.md': '# Negocio\n\nCada area define su propia agenda.\n',
      'src/app.ts': 'export const app = 1;\n'
    },
    branches: {
      dev: {
        last_commit_date: '2026-02-02T10:00:00Z',
        files: {
          'README.md': TURNOS_README,
          'TRACKER.md': '# TRACKER\n\n## En curso\n\n- Reportes de asistencia en replica.\n'
        }
      },
      // Trabajo en curso: su documentación existe SOLO acá, nunca en main.
      'feat/pagos-online': {
        last_commit_date: RECENT_ISO,
        files: {
          'README.md': TURNOS_README,
          'docs/PAGOS.md':
            '# Pagos online\n\nCobro de tasas con tarjeta al confirmar el turno.\n' +
            'Integracion con la pasarela provincial.\n'
        }
      },
      // Una segunda rama reciente, para que el techo maxActiveBranches tenga algo que recortar.
      'feat/recordatorios': {
        last_commit_date: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        files: { 'README.md': '# Recordatorios\n\nAviso previo al turno.\n' }
      },
      'feat/abandonada': {
        last_commit_date: '2024-01-01T00:00:00Z',
        files: { 'README.md': '# Vieja\n\nRama abandonada hace anios.\n' }
      }
    }
  },
  tramites: {
    description: 'Gestion de tramites',
    open_pull_requests: 0,
    open_issues: 1,
    commits: [],
    files: {
      'README.md': '# Tramites\n\nSeguimiento digital de tramites internos.\n'
    }
  }
};

export interface TestRepoEntry {
  alias: string;
  repo: string;
  description: string;
}

export interface TestConfigOptions {
  activeBranchDays?: number;
  maxActiveBranches?: number;
  defaultBranches?: string[];
  /**
   * Pisa los dos repos por defecto. Las afirmaciones sobre concurrencia acotada
   * necesitan más repos en vuelo que el límite, y el par fijo no puede darlos.
   */
  repos?: TestRepoEntry[];
}

export function testConfig(options: TestConfigOptions = {}): ReposConfig {
  const dir = mkdtempSync(join(tmpdir(), 'repo-rag-cfg-'));
  const path = join(dir, 'repos.json');
  writeFileSync(
    path,
    JSON.stringify({
      org: 'example-org',
      defaultDocs: ['README.md', 'TRACKER.md', 'docs/**'],
      defaultBranches: options.defaultBranches ?? ['main', 'dev'],
      ...(options.activeBranchDays === undefined
        ? {}
        : { activeBranchDays: options.activeBranchDays }),
      ...(options.maxActiveBranches === undefined
        ? {}
        : { maxActiveBranches: options.maxActiveBranches }),
      repos: options.repos ?? [
        { alias: 'turnos', repo: 'turnos', description: 'Sistema de turnos online' },
        { alias: 'tramites', repo: 'tramites', description: 'Gestion de tramites' }
      ]
    })
  );
  return loadReposConfig(path);
}

export function testGitHub(): MockGitHubClient {
  return new MockGitHubClient(FIXTURES);
}

/**
 * Reemplazo determinista de Ollama: un vector de bolsa de palabras sobre un
 * vocabulario fijo. Es tosco, pero hace que "la palabra de la consulta aparece en
 * el chunk" puntúe más alto que "no aparece", que es exactamente la propiedad que
 * el store debe preservar, y no necesita ningún modelo corriendo.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  /**
   * Todos los textos que a este proveedor realmente se le pidió embeber como
   * documento, en orden. Desde afuera el caché de embeddings solo se observa como
   * llamadas que NO ocurrieron, así que los tests necesitan que el proveedor
   * guarde los comprobantes.
   */
  readonly embedded: string[] = [];
  /** Viajes de ida y vuelta, a diferencia de textos: el batching es parte de lo que se afirma. */
  documentCalls = 0;

  constructor(readonly model = 'fake-test-model') {}

  private static readonly VOCAB = [
    'autenticacion',
    'autentican',
    'dni',
    'clave',
    'correo',
    'sms',
    'notificaciones',
    'turno',
    'turnos',
    'vecinos',
    'tramites',
    'reportes',
    'proveedor',
    'agenda',
    'pagos',
    'tarjeta',
    'tasas',
    'replica',
    'asistencia'
  ];

  async embedDocuments(texts: string[]): Promise<number[][]> {
    this.documentCalls += 1;
    this.embedded.push(...texts);
    return texts.map(text => this.vectorize(text));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.vectorize(text);
  }

  private vectorize(text: string): number[] {
    const lower = text.toLowerCase();
    const vector: number[] = FakeEmbeddingProvider.VOCAB.map(word =>
      lower.includes(word) ? 1 : 0
    );
    // Se mantiene distinto de cero para que la normalización siempre tenga una dirección con la que trabajar.
    vector.push(0.01);
    return vector;
  }
}

export function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'repo-rag-db-')), 'index.db');
}
