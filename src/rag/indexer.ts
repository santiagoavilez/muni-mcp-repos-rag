import {
  ConfiguredRepo,
  ReposConfig,
  isGlobPattern,
  isMarkdown,
  matchesDocPattern
} from '../config/repos.js';
import { NotFoundError, RateLimitError } from '../core/errors.js';
import { GitHubClient } from '../github/types.js';
import { chunkMarkdown } from './chunker.js';
import { EmbeddingProvider } from './embeddings.js';
import { ChunkRecord, VectorStore, hashContent } from './store.js';

export interface BranchIndexResult {
  branch: string;
  files: number;
  chunks: number;
  /** Textos distintos que el proveedor tuvo que embeber en esta corrida. */
  embedded_chunks: number;
  /**
   * Textos distintos respondidos desde el caché de embeddings. Se cuentan por
   * texto y no por chunk: el sentido del número es cuánto trabajo se le ahorró al
   * proveedor, y un solo vector cacheado sirve a todos los chunks que repiten ese
   * texto.
   */
  reused_chunks: number;
  /** True cuando la rama entró por la ventana de actividad reciente. */
  active: boolean;
  skipped: string[];
  error: string | null;
}

export interface RepoIndexResult {
  repo: string;
  alias: string;
  branches: BranchIndexResult[];
  files: number;
  chunks: number;
  embedded_chunks: number;
  reused_chunks: number;
  /** Ramas configuradas que no existen en este repo. No es un error. */
  missing_branches: string[];
  pruned_branches: number;
  error: string | null;
}

export interface IndexReport {
  model: string;
  results: RepoIndexResult[];
  indexed_at: string;
}

/** Cuántos chunks se embeben por viaje a Ollama. */
const EMBED_BATCH_SIZE = 16;

/** Cualquier cosa más grande que esto es un volcado de datos, no documentación. */
const MAX_DOC_BYTES = 300_000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Clave de single-flight para un refresh de todos los repos configurados. Los
 * signos de menor y mayor son ilegales en un alias, en un nombre de repo y en un
 * "owner/repo", así que este centinela nunca se puede confundir con un alcance real.
 */
const ALL_REPOS = '<all-repos>';

/** Conteo por rama de cuánto del trabajo le sacó el caché al proveedor. */
interface EmbedCounters {
  embedded: number;
  reused: number;
}

export class Indexer {
  constructor(
    private readonly config: ReposConfig,
    private readonly github: GitHubClient,
    private readonly embeddings: EmbeddingProvider,
    private readonly store: VectorStore
  ) {}

  /** Refreshes ya en curso, por alcance. Ver `refresh`. */
  private readonly inFlight = new Map<string, Promise<IndexReport>>();

  /**
   * Cola serializada. Siempre es una promesa resuelta o pendiente que NUNCA
   * rechaza, así un refresh fallido no puede trabar a los que vienen atrás.
   */
  private queue: Promise<void> = Promise.resolve();

  /**
   * Reindexa un repo, o todos los configurados cuando se omite `reference`.
   *
   * Que un repo falle NO aborta la corrida: la falla se reporta por repo y los
   * demás igual se indexan, porque un solo repo inalcanzable no debería dejar al
   * usuario sin ningún índice. Lo mismo vale por rama.
   *
   * Nunca se ejecuta más de un refresh a la vez, y un segundo llamador que pida
   * un alcance que ya está corriendo se suma a ese en vez de arrancar un
   * duplicado: recibe exactamente el mismo IndexReport en lugar de un error,
   * porque desde su punto de vista el trabajo que pidió sí ocurrió.
   *
   * El guard vive ACÁ y no en lo que programa un refresh: el scheduler de
   * arranque, la tool refresh_index y `pnpm reindex` entran todos por este
   * método, así que un guard puesto en cualquiera de ellos lo esquivan los otros
   * dos, y dos corridas concurrentes significan el doble de requests a GitHub, el
   * doble de carga en Ollama, y dos transacciones reescribiendo la misma rama.
   */
  async refresh(reference?: string): Promise<IndexReport> {
    const scope = reference ?? ALL_REPOS;

    const running = this.inFlight.get(scope);
    if (running) return running;

    const started = this.queue.then(() => this.runRefresh(reference));
    // Se limpia en `finally`, tanto al salir bien COMO al fallar: una promesa
    // rechazada que quedara estacionada bajo este alcance se le entregaría para
    // siempre a todo llamador posterior, así que una sola corrida fallida
    // desactivaría de forma permanente el refresh de ese repo.
    const tracked = started.finally(() => {
      if (this.inFlight.get(scope) === tracked) this.inFlight.delete(scope);
    });

    this.inFlight.set(scope, tracked);
    // La falla ya se le entregó a quien haya esperado `tracked`; la cola solo
    // ordena las corridas, así que se la traga en vez de propagarla a un refresh
    // que no tiene nada que ver (y en vez de volverse un rechazo no manejado).
    this.queue = tracked.then(
      () => undefined,
      () => undefined
    );

    return tracked;
  }

  private async runRefresh(reference?: string): Promise<IndexReport> {
    const targets = reference ? [this.config.resolve(reference)] : this.config.all;
    const results: RepoIndexResult[] = [];

    for (let at = 0; at < targets.length; at += 1) {
      const target = targets[at]!;
      try {
        results.push(await this.refreshRepo(target));
      } catch (error) {
        results.push(
          failedRepoResult(target, error instanceof Error ? error.message : String(error))
        );

        // Un rate limit es una falla global, no por repo: todo repo que siga en
        // la cola tira de la misma cuota agotada, así que seguir quema requests
        // condenados de antemano contra la detección de abuso de GitHub. El resto
        // de la corrida se reporta como salteada en vez de intentarla.
        if (error instanceof RateLimitError) {
          const detail =
            'skipped: GitHub rate limit exhausted' +
            (error.resetAt ? ` (resets at ${error.resetAt.toISOString()})` : '');
          for (const remaining of targets.slice(at + 1)) {
            results.push(failedRepoResult(remaining, detail));
          }
          break;
        }
      }
    }

    return { model: this.embeddings.model, results, indexed_at: new Date().toISOString() };
  }

  private async refreshRepo(target: ConfiguredRepo): Promise<RepoIndexResult> {
    const plan = await this.planBranches(target);
    const branches: BranchIndexResult[] = [];

    for (const branch of plan.index) {
      try {
        branches.push(await this.refreshBranch(target, branch.name, branch.active));
      } catch (error) {
        // No es una falla por rama: los requests de la rama siguiente pegan
        // contra la misma cuota agotada. Se deja que runRefresh aborte toda la corrida.
        if (error instanceof RateLimitError) throw error;
        branches.push({
          branch: branch.name,
          files: 0,
          chunks: 0,
          embedded_chunks: 0,
          reused_chunks: 0,
          active: branch.active,
          skipped: [],
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const indexed = branches.filter(branch => branch.error === null).map(branch => branch.branch);
    const pruned = indexed.length > 0 ? this.store.pruneBranches(target.fullName, indexed) : 0;

    return {
      repo: target.fullName,
      alias: target.alias,
      branches,
      files: branches.reduce((total, branch) => total + branch.files, 0),
      chunks: branches.reduce((total, branch) => total + branch.chunks, 0),
      embedded_chunks: branches.reduce((total, branch) => total + branch.embedded_chunks, 0),
      reused_chunks: branches.reduce((total, branch) => total + branch.reused_chunks, 0),
      missing_branches: plan.missing,
      pruned_branches: pruned,
      error: null
    };
  }

  /**
   * Decide qué ramas indexar.
   *
   * Dos fuentes, en este orden:
   *  1. La lista configurada (convención del equipo: `main` para producción, `dev`
   *     para la réplica). Las ramas configuradas que no existen se reportan, no
   *     hacen fallar: una sola lista tiene que servir para todos los repos.
   *  2. Opcionalmente, las ramas con push dentro de `activeBranchDays`. El
   *     trabajo en curso vive en feature branches cuya documentación nunca llega
   *     a `main`, y es justo eso lo que la gente pregunta.
   */
  private async planBranches(
    target: ConfiguredRepo
  ): Promise<{ index: { name: string; active: boolean }[]; missing: string[] }> {
    const existing = await this.github.listBranches(target);
    const byName = new Map(existing.map(branch => [branch.name, branch]));

    const index: { name: string; active: boolean }[] = [];
    const missing: string[] = [];

    for (const name of target.branches) {
      if (byName.has(name)) index.push({ name, active: false });
      else missing.push(name);
    }

    const windowDays = this.config.activeBranchDays;
    if (windowDays > 0) {
      const cutoff = Date.now() - windowDays * MS_PER_DAY;
      const chosen = new Set(index.map(branch => branch.name));

      const recent = existing
        .filter(branch => !chosen.has(branch.name))
        .filter(branch => {
          const at = Date.parse(branch.last_commit_date ?? '');
          return Number.isFinite(at) && at >= cutoff;
        })
        .slice(0, this.config.maxActiveBranches);

      for (const branch of recent) index.push({ name: branch.name, active: true });
    }

    return { index, missing };
  }

  private async refreshBranch(
    target: ConfiguredRepo,
    branch: string,
    active: boolean
  ): Promise<BranchIndexResult> {
    const paths = await this.resolveDocPaths(target, branch);
    const records: ChunkRecord[] = [];
    const skipped: string[] = [];
    const counters: EmbedCounters = { embedded: 0, reused: 0 };
    let indexedFiles = 0;

    for (const path of paths) {
      let text: string;
      try {
        const file = await this.github.getFileContent(target, path, branch);
        if (file.size_bytes > MAX_DOC_BYTES) {
          skipped.push(`${path} (too large: ${file.size_bytes} bytes)`);
          continue;
        }
        text = file.content;
      } catch (error) {
        // Que un patrón de documentos nombre un archivo que no existe en esta
        // rama es normal (no todo repo tiene NEGOCIO.md); cualquier otra cosa
        // vale la pena mostrarla, pero igual no vale la pena abortar la rama por
        // ella. El rate limit es la excepción: cada archivo restante cuesta un
        // request contra una cuota que ya no existe, así que aborta la corrida en
        // vez de convertirse en cien líneas de "skipped".
        if (error instanceof NotFoundError) continue;
        if (error instanceof RateLimitError) throw error;
        skipped.push(`${path} (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }

      const chunks = chunkMarkdown(text);
      if (chunks.length === 0) continue;
      indexedFiles += 1;

      const hashes = chunks.map(chunk => hashContent(chunk.text));
      const vectors = await this.embedChunks(chunks.map(chunk => chunk.text), hashes, counters);

      chunks.forEach((chunk, offset) => {
        const embedding = vectors.get(hashes[offset]!);
        // Un proveedor que contestó con menos vectores de los que se le pidieron
        // deja un chunk sin el suyo. Descartar ese chunk mantiene indexado el
        // resto del archivo, que es mejor que hacer fallar la rama por una sola
        // respuesta faltante.
        if (!embedding) return;
        records.push({
          repo: target.fullName,
          alias: target.alias,
          branch,
          path,
          chunk_index: chunk.index,
          heading: chunk.heading,
          content: chunk.text,
          embedding
        });
      });
    }

    this.store.replaceBranch(
      target.fullName,
      branch,
      records,
      this.embeddings.model,
      indexedFiles
    );

    return {
      branch,
      files: indexedFiles,
      chunks: records.length,
      embedded_chunks: counters.embedded,
      reused_chunks: counters.reused,
      active,
      skipped,
      error: null
    };
  }

  /**
   * Resuelve a vectores los chunks de un archivo, consultando primero el caché de
   * embeddings.
   *
   * El proveedor es por lejos la parte cara de un refresh, y la mayoría de lo que
   * se le pide es texto que ya vio: el mismo README en main, en dev y en cada
   * rama cortada de ellas, sin cambios desde la corrida anterior. Medido sobre el
   * índice real, los 2790 chunks de un refresh completo son apenas 767 textos
   * distintos, así que primero se consulta el caché y SOLO se mandan los que
   * faltan, igual en viajes de EMBED_BATCH_SIZE.
   *
   * El resultado se indexa por hash de contenido y no por posición, lo que además
   * convierte un texto repetido dentro de un mismo archivo en un único request
   * del que leen los dos chunks.
   */
  private async embedChunks(
    texts: string[],
    hashes: string[],
    counters: EmbedCounters
  ): Promise<Map<string, number[]>> {
    const cached = this.store.cachedEmbeddings(this.embeddings.model, hashes);
    const vectors = new Map(cached);
    const missingTexts: string[] = [];

    // Se deduplica contra los aciertos Y contra sí mismo, así un párrafo que
    // aparece dos veces dentro de un archivo se embebe una sola vez y los dos
    // chunks leen el mismo vector.
    const missing: string[] = [];
    const queued = new Set<string>();
    hashes.forEach((hash, offset) => {
      if (vectors.has(hash) || queued.has(hash)) return;
      queued.add(hash);
      missing.push(hash);
      missingTexts.push(texts[offset]!);
    });

    const fresh: { content_hash: string; embedding: number[] }[] = [];

    for (let at = 0; at < missingTexts.length; at += EMBED_BATCH_SIZE) {
      const batch = missingTexts.slice(at, at + EMBED_BATCH_SIZE);
      const computed = await this.embeddings.embedDocuments(batch);

      batch.forEach((_, offset) => {
        const embedding = computed[offset];
        // Una respuesta corta del proveedor deja este hash sin resolver: no se
        // guarda ni se cachea, y el chunk se saltea más abajo.
        if (!embedding) return;
        const hash = missing[at + offset]!;
        vectors.set(hash, embedding);
        fresh.push({ content_hash: hash, embedding });
      });
    }

    this.store.cacheEmbeddings(this.embeddings.model, fresh);

    // Textos distintos de los dos lados, así la suma da los requests que habría
    // hecho una corrida en frío.
    counters.embedded += fresh.length;
    counters.reused += cached.size;

    return vectors;
  }

  /**
   * Convierte los patrones de documentos configurados en rutas concretas de una
   * rama.
   *
   * Las rutas exactas se toman tal como están escritas: pedir el árbol costaría
   * un request extra y el archivo puede existir sin aparecer en un árbol
   * truncado. Solo un glob ("docs/**") obliga a listar el árbol.
   */
  private async resolveDocPaths(target: ConfiguredRepo, branch: string): Promise<string[]> {
    const exact = target.docPatterns.filter(pattern => !isGlobPattern(pattern));
    const globs = target.docPatterns.filter(isGlobPattern);

    const paths = new Set(exact);

    if (globs.length > 0) {
      const tree = await this.github.listTree(target, branch);
      for (const entry of tree) {
        if (!isMarkdown(entry.path)) continue;
        if (globs.some(pattern => matchesDocPattern(entry.path, pattern))) {
          paths.add(entry.path);
        }
      }
    }

    return [...paths].sort();
  }
}

/** Resultado en cero para un repo que falló o al que nunca le llegó el turno. */
function failedRepoResult(target: ConfiguredRepo, message: string): RepoIndexResult {
  return {
    repo: target.fullName,
    alias: target.alias,
    branches: [],
    files: 0,
    chunks: 0,
    embedded_chunks: 0,
    reused_chunks: 0,
    missing_branches: [],
    pruned_branches: 0,
    error: message
  };
}
