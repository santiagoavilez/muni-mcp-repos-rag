import { ConfiguredRepo } from '../config/repos.js';
import { readEnv } from '../core/env.js';
import { IndexReport } from './indexer.js';
import { selectStaleRepos } from './staleness.js';
import { IndexStats } from './store.js';

/**
 * La porción del contexto del server que esto necesita, y nada más. Está
 * acotada a propósito: permite que un test maneje el scheduler con tres
 * literales en vez de un archivo SQLite, un token de GitHub y un Ollama andando.
 */
export interface AutoIndexContext {
  config: { all: ConfiguredRepo[] };
  store: { stats(): IndexStats[] };
  /** El chequeo de vencimiento compara el modelo de cada corrida contra el configurado ahora. */
  embeddings: { model: string };
  indexer: { refresh(reference?: string): Promise<IndexReport> };
}

export interface StartupRefreshOptions {
  /** Pisa REPO_RAG_AUTO_INDEX_HOURS. Sobre todo para tests. */
  maxAgeHours?: number;
  /** Pisa el reloj del sistema. Sobre todo para tests. */
  now?: Date;
}

/** Horas antes de considerar vencido el índice, cuando nada indica otra cosa. */
const DEFAULT_MAX_AGE_HOURS = 12;

/**
 * Reindexa todo lo que se venció mientras el server estaba caído.
 *
 * Existe porque el índice es una foto y no un espejo, que es la cosa más
 * confusa de este server para quien no lo construyó: pregunta por un documento
 * que está claramente en GitHub y se le contesta que la documentación no lo
 * cubre. Refrescar al arrancar elimina el paso manual en vez de documentarlo.
 *
 * NUNCA lanza. Una rutina de arranque que puede fallar se lleva puesto al
 * server, y un server que contesta desde un índice vencido es muchísimo mejor
 * que uno que no arranca, así que toda falla se loguea y se traga, por repo y
 * en conjunto.
 */
export async function scheduleStartupRefresh(
  context: AutoIndexContext,
  options: StartupRefreshOptions = {}
): Promise<void> {
  try {
    const maxAgeHours = options.maxAgeHours ?? readMaxAgeHours();
    if (maxAgeHours <= 0) {
      console.error('[auto-index] disabled (REPO_RAG_AUTO_INDEX_HOURS=0).');
      return;
    }

    const now = options.now ?? new Date();
    const stale = selectStaleRepos(
      context.config.all,
      context.store.stats(),
      maxAgeHours,
      now,
      context.embeddings.model
    );

    if (stale.length === 0) {
      console.error(
        `[auto-index] index is current (every repo refreshed within ${maxAgeHours}h); nothing to do.`
      );
      return;
    }

    console.error(
      `[auto-index] ${stale.length} of ${context.config.all.length} repos older than ` +
        `${maxAgeHours}h or never indexed: ${stale.map(repo => repo.alias).join(', ')}. ` +
        'Refreshing in the background.'
    );

    // En secuencia a propósito. Un Promise.all acá multiplicaría por la cantidad
    // de repos la presión sobre el rate limit de GitHub y la carga de Ollama,
    // justo en el momento en que el agente empieza a preguntar, y no se gana
    // nada: esto corre en segundo plano, así que puede tomarse su tiempo.
    for (const repo of stale) {
      await refreshOne(context, repo);
    }
  } catch (error) {
    // Llegar acá significa que se rompió algo fuera del bucle por repo (leer las
    // estadísticas, lo más probable). Igual no vale la pena hacer fallar un arranque.
    console.error(`[auto-index] skipped: ${describe(error)}`);
  }
}

async function refreshOne(context: AutoIndexContext, repo: ConfiguredRepo): Promise<void> {
  try {
    const report = await context.indexer.refresh(repo.alias);
    const total = (pick: (result: IndexReport['results'][number]) => number): number =>
      report.results.reduce((sum, result) => sum + pick(result), 0);

    // También se cuentan los errores de rama, no solo los de repo. La falla más
    // probable al arrancar es, por lejos, que Ollama todavía no esté levantado, y
    // eso aparece por RAMA: el repo en sí sale bien, todas las ramas fallan, y la
    // línea de abajo diría "0 files, 0 chunks", un éxito vacío. El motivo tiene
    // que aparecer acá o nadie lo va a ir a buscar.
    const failedRepos = report.results.filter(result => result.error !== null);
    const branchErrors = report.results.flatMap(result =>
      result.branches.filter(branch => branch.error !== null)
    );
    const reason =
      failedRepos[0]?.error ?? branchErrors[0]?.error ?? null;

    // El desglose embebidos/reusados es lo que vale la pena leer: es la
    // diferencia entre un refresh que tardó minutos y uno que tardó segundos, y
    // es lo que explica una corrida sospechosamente rápida en vez de volverla
    // sospechosa.
    console.error(
      `[auto-index] ${repo.alias}: ${total(result => result.files)} files, ` +
        `${total(result => result.chunks)} chunks, ` +
        `${total(result => result.embedded_chunks)} embedded / ` +
        `${total(result => result.reused_chunks)} reused` +
        (reason === null
          ? ''
          : ` — ${failedRepos.length} repo and ${branchErrors.length} branch ` +
            `failure(s), first: ${reason}`)
    );
  } catch (error) {
    // Que un repo se caiga no puede costarle el refresh a los demás: si no, un
    // token vencido o un rate limit se llevaría puesta toda la pasada de arranque.
    console.error(`[auto-index] ${repo.alias} failed: ${describe(error)}`);
  }
}

/**
 * Lee del entorno la ventana de vencimiento.
 *
 * Un valor ilegible cae al default en vez de desactivar la funcionalidad: un
 * error de tipeo no debería apagar en silencio justo aquello que la variable
 * existe para configurar, y la advertencia dice qué valor se ignoró.
 */
function readMaxAgeHours(): number {
  const raw = readEnv('REPO_RAG_AUTO_INDEX_HOURS', String(DEFAULT_MAX_AGE_HOURS));
  // Number, no parseFloat: parseFloat("12abc") da 12, así que un error de tipeo
  // pasaría en silencio y la advertencia de abajo nunca se dispararía.
  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(
      `[auto-index] ignoring REPO_RAG_AUTO_INDEX_HOURS="${raw}" (not a number of hours); ` +
        `using ${DEFAULT_MAX_AGE_HOURS}h.`
    );
    return DEFAULT_MAX_AGE_HOURS;
  }

  return parsed;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
