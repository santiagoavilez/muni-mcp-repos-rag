import { ConfiguredRepo } from '../config/repos.js';
import { IndexStats } from './store.js';

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Decide qué repos configurados vale la pena reindexar, según lo que el índice
 * dice de sí mismo.
 *
 * Pura a propósito: acá adentro no vive ni la base de datos ni el reloj, así que
 * cada regla de abajo es un argumento que pasa el llamador y un test puede
 * plantear un escenario entero con tres literales. Los efectos (leer
 * `index_runs`, leer el reloj, gastar presupuesto de GitHub y de Ollama) son del
 * scheduler.
 *
 * La decisión es POR REPO y no un único flag global de "el índice está viejo",
 * porque `Indexer.refresh(alias)` ya acepta un repo solo: juzgar todo el índice
 * por su entrada más vieja volvería a bajar y a embeber repos que se
 * refrescaron hace minutos.
 */
export function selectStaleRepos(
  repos: readonly ConfiguredRepo[],
  stats: readonly IndexStats[],
  maxAgeHours: number,
  now: Date,
  currentModel: string
): ConfiguredRepo[] {
  // Cero (o menos) es el interruptor de apagado, y un interruptor de apagado que
  // igual dispara un reindexado completo sobre un repo que nadie indexó nunca no
  // está apagado.
  if (maxAgeHours <= 0) return [];

  const newestByRepo = new Map<string, number>();
  for (const entry of stats) {
    // Una corrida hecha con otro modelo de embeddings no es solamente vieja, es
    // INCORRECTA: sus vectores responden consultas embebidas por un modelo del
    // que nunca salieron, y dos modelos que coinciden en cantidad de dimensiones
    // hacen que eso sea invisible al consultar. Una corrida así no puede
    // certificar la frescura del repo, así que se ignora igual que una que nunca
    // se registró.
    if (entry.model !== currentModel) continue;

    const at = Date.parse(entry.indexed_at);
    // Un timestamp ilegible no es evidencia de frescura, así que no puede subir
    // la marca de agua del repo: la corrida se trata como si nunca se hubiera
    // registrado, lo que deja al repo en el conjunto de vencidos de abajo.
    if (!Number.isFinite(at)) continue;

    const known = newestByRepo.get(entry.repo);
    if (known === undefined || at > known) newestByRepo.set(entry.repo, at);
  }

  const cutoff = now.getTime() - maxAgeHours * MS_PER_HOUR;

  return repos.filter(repo => {
    const newest = newestByRepo.get(repo.fullName);

    // Que no haya ninguna corrida es el caso para el que existe toda esta
    // funcionalidad. Cubre tanto un repo recién agregado a repos.json COMO un
    // índice borrado por un salto de SCHEMA_VERSION; en ambos casos el usuario
    // queda en silencio sub-indexado, buscando documentación que simplemente no
    // está y recibiendo como respuesta que los docs no lo cubren.
    if (newest === undefined) return true;

    // Un repo se juzga por su rama MÁS NUEVA: las ramas se indexan juntas, así
    // que una rama sin tocar hace mucho no dice nada sobre cuándo se refrescó el
    // repo por última vez.
    return newest < cutoff;
  });
}
