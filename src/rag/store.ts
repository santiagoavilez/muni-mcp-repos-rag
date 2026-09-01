import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { fromProjectRoot } from '../core/paths.js';

export interface ChunkRecord {
  repo: string;
  alias: string;
  branch: string;
  path: string;
  chunk_index: number;
  heading: string;
  content: string;
  embedding: number[];
}

export interface SearchHit {
  repo: string;
  alias: string;
  /**
   * Todas las ramas donde aparece exactamente este contenido, con las ramas
   * configuradas primero. Contenido idéntico en varias ramas es UN resultado, no
   * N; si no, un repo con seis ramas activas llena todo el top-k con copias del
   * mismo chunk.
   */
  branches: string[];
  path: string;
  heading: string;
  content: string;
  /**
   * Puntaje de rango fusionado. No es una similitud y no se puede comparar entre
   * consultas distintas: lo único que significa algo es el orden dentro de un
   * mismo conjunto de resultados.
   */
  score: number;
  /** Similitud coseno en [-1, 1]. Más alto es más cerca. */
  semantic_score: number;
  /** Posición en la búsqueda por palabra clave, empezando en 1. Null si no matcheó ninguna. */
  keyword_rank: number | null;
  /** Cómo se encontró este resultado; sirve para explicar una respuesta. */
  matched_by: 'both' | 'semantic' | 'keyword';
  indexed_at: string;
}

export interface IndexStats {
  repo: string;
  branch: string;
  /** Modelo de embeddings con el que se indexó la rama. */
  model: string;
  chunks: number;
  files: number;
  indexed_at: string;
}

export interface SearchScope {
  repo?: string;
  branch?: string;
}

/**
 * Vector store sobre SQLite pelado.
 *
 * Sin sqlite-vec: necesita una extensión nativa incómoda de compilar en la
 * máquina Windows donde esto corre, y acá el corpus son unos pocos markdown por
 * repo. Los vectores se guardan como blobs Float32 y se puntúan con un producto
 * punto por fuerza bruta en JS: con unos miles de chunks eso tarda menos de un
 * milisegundo, y no tiene paso de compilación que pueda fallar.
 *
 * Todo vector se normaliza en L2 al escribirlo, así que al consultar la
 * similitud coseno ES el producto punto.
 */
/** Se incrementa cada vez que cambia la forma de chunks/index_runs/embedding_cache. */
const SCHEMA_VERSION = 4;

/**
 * Constante de Reciprocal Rank Fusion. 60 es el valor del paper original y el
 * default habitual; amortigua la influencia de los primerísimos puestos lo justo
 * para que una lista no pueda dominar a la otra.
 */
const RRF_K = 60;

/** Cuántos resultados por palabra clave se traen antes de fusionar. */
const KEYWORD_CANDIDATES = 200;

export class VectorStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const resolved = fromProjectRoot(dbPath);
    mkdirSync(dirname(resolved), { recursive: true });

    this.db = VectorStore.open(resolved);
    this.migrate();
  }

  /**
   * Un archivo que no es una base SQLite válida (una copia truncada, un disco
   * lleno a mitad de escritura, el resto de un build viejo) no puede voltear todo
   * el server: el índice es un caché derivado según `migrate()` más abajo, así
   * que aplica la misma política: se corre de lugar el archivo ilegible y se
   * arranca uno nuevo en vez de crashear en cada arranque futuro. better-sqlite3
   * abre el descriptor de forma perezosa, así que el error recién aparece en la
   * primera sentencia real, no en `new Database(...)`.
   */
  private static open(resolved: string): Database.Database {
    try {
      return VectorStore.openFresh(resolved);
    } catch (error) {
      if (!isUnreadableDatabaseError(error)) throw error;

      const quarantined = `${resolved}.corrupt-${Date.now()}`;
      console.error(
        `[store] ${resolved} is not a valid SQLite database (${error.code}); ` +
          `moving it to ${quarantined} and starting a fresh index. ` +
          'Run refresh_index (or `pnpm reindex`) to rebuild it.'
      );
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(resolved + suffix)) renameSync(resolved + suffix, quarantined + suffix);
      }
      return VectorStore.openFresh(resolved);
    }
  }

  private static openFresh(resolved: string): Database.Database {
    const db = new Database(resolved);
    try {
      db.pragma('journal_mode = WAL');
    } catch (error) {
      // En Windows el descriptor queda abierto hasta que se cierra
      // explícitamente, y un archivo abierto no se puede renombrar: cerrarlo acá
      // es lo que le permite al `open()` de arriba poner en cuarentena el archivo
      // ilegible en vez de fallar al moverlo.
      db.close();
      throw error;
    }
    return db;
  }

  private migrate(): void {
    // El índice es un caché derivado, nunca una fuente de verdad: un cambio de
    // esquema lo borra y pide un reindexado en vez de arrastrar una migración
    // frágil.
    //
    // El chequeo mira la forma real de la tabla, no user_version: la primera
    // release nunca estampó una versión, así que un índice existente de esa época
    // se lee como 0 y si no se lo confundiría con una base recién creada.
    const columns = this.db.pragma('table_info(chunks)') as { name: string }[];
    const version = (this.db.pragma('user_version', { simple: true }) as number) ?? 0;
    const isStaleSchema = columns.length > 0 && version < SCHEMA_VERSION;

    if (isStaleSchema) {
      this.db.exec(
        'DROP TABLE IF EXISTS chunks_fts; DROP TABLE IF EXISTS chunks; ' +
          'DROP TABLE IF EXISTS index_runs; DROP TABLE IF EXISTS embedding_cache;'
      );
      console.error(
        '[store] index schema upgraded; the previous index was dropped. ' +
          'Run refresh_index (or `pnpm reindex`) to rebuild it.'
      );
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id          INTEGER PRIMARY KEY,
        repo        TEXT    NOT NULL,
        alias       TEXT    NOT NULL,
        branch      TEXT    NOT NULL,
        path        TEXT    NOT NULL,
        chunk_index INTEGER NOT NULL,
        heading     TEXT    NOT NULL DEFAULT '',
        content     TEXT    NOT NULL,
        embedding   BLOB    NOT NULL,
        dimensions  INTEGER NOT NULL,
        indexed_at  TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_repo ON chunks(repo);
      CREATE INDEX IF NOT EXISTS idx_chunks_repo_branch ON chunks(repo, branch);

      CREATE TABLE IF NOT EXISTS index_runs (
        repo        TEXT NOT NULL,
        branch      TEXT NOT NULL,
        model       TEXT NOT NULL,
        files       INTEGER NOT NULL,
        chunks      INTEGER NOT NULL,
        indexed_at  TEXT NOT NULL,
        PRIMARY KEY (repo, branch)
      );

      -- Embeddings ya calculados para un texto, indexados por su hash.
      --
      -- El mismo archivo vive en main, en dev y en cada feature branch cortada
      -- de ellas: medido sobre el índice real, un refresh completo embebe 2790
      -- chunks de los cuales solo 767 son textos distintos. Todo el resto es el
      -- mismo párrafo pedido de nuevo, y el modelo contestándolo de nuevo.
      --
      -- El modelo es PARTE DE LA CLAVE, y ahí está toda la corrección de esta
      -- tabla. Dos modelos pueden coincidir en cantidad de dimensiones
      -- -- nomic-embed-text y bge-m3 coinciden -- así que el guard por
      -- "dimensions" que corre al consultar dejaría servir el vector de un
      -- modelo como el del otro sin un solo error: el índice se vería sano y
      -- cada resultado de búsqueda estaría mal en silencio. Keyear solo por el
      -- hash es el único error de acá que no se puede notar desde afuera.
      --
      -- Nunca se desaloja nada. La cantidad de filas está acotada por el texto
      -- distinto de unos pocos archivos markdown, y una política de desalojo
      -- tiraría justo las entradas con más chances de volver a hacer falta:
      -- las de una rama que reaparece.
      CREATE TABLE IF NOT EXISTS embedding_cache (
        model        TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        embedding    BLOB NOT NULL,
        dimensions   INTEGER NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (model, content_hash)
      );

      -- Mitad por palabra clave de la búsqueda híbrida. Los embeddings son
      -- ciegos a los tokens exactos y raros ("BILLING", un número de
      -- tramite, el nombre de una clase); BM25 los encuentra al instante. Es
      -- una tabla de contenido externo apuntada a chunks.id, así que el texto se
      -- guarda una sola vez.
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        heading,
        path,
        content,
        content='chunks',
        content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );
    `);

    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * Reemplaza todos los chunks de un repo en una sola transacción: un refresh
   * fallido deja el índice anterior intacto en vez de a medio borrar.
   */
  replaceBranch(
    repo: string,
    branch: string,
    records: ChunkRecord[],
    model: string,
    files: number
  ): void {
    const now = new Date().toISOString();

    const remove = this.db.prepare('DELETE FROM chunks WHERE repo = ? AND branch = ?');
    const insert = this.db.prepare(`
      INSERT INTO chunks (repo, alias, branch, path, chunk_index, heading, content, embedding, dimensions, indexed_at)
      VALUES (@repo, @alias, @branch, @path, @chunk_index, @heading, @content, @embedding, @dimensions, @indexed_at)
    `);
    const recordRun = this.db.prepare(`
      INSERT INTO index_runs (repo, branch, model, files, chunks, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo, branch) DO UPDATE SET
        model = excluded.model,
        files = excluded.files,
        chunks = excluded.chunks,
        indexed_at = excluded.indexed_at
    `);

    const write = this.db.transaction((rows: ChunkRecord[]) => {
      remove.run(repo, branch);
      for (const row of rows) {
        const normalized = normalizeVector(row.embedding);
        insert.run({
          repo: row.repo,
          alias: row.alias,
          branch: row.branch,
          path: row.path,
          chunk_index: row.chunk_index,
          heading: row.heading,
          content: row.content,
          embedding: Buffer.from(new Float32Array(normalized).buffer),
          dimensions: normalized.length,
          indexed_at: now
        });
      }
      recordRun.run(repo, branch, model, files, rows.length, now);
      this.rebuildKeywordIndex();
    });

    write(records);
  }

  /**
   * Busca embeddings ya calculados para un modelo. Solo vuelven los aciertos, así
   * que el llamador puede tratar "ausente del mapa" como "hay que embeberlo".
   */
  cachedEmbeddings(model: string, hashes: string[]): Map<string, number[]> {
    const found = new Map<string, number[]>();
    if (hashes.length === 0) return found;

    // Se pide de a un hash a propósito: una lista IN tiene que quedar por debajo
    // del límite de parámetros de SQLite, y una consulta preparada de una fila
    // sobre una clave primaria ya es un seek por índice; el bucle no cuesta nada
    // que valga la pena evitar.
    const select = this.db.prepare(
      'SELECT embedding, dimensions FROM embedding_cache WHERE model = ? AND content_hash = ?'
    );

    for (const hash of new Set(hashes)) {
      const row = select.get(model, hash) as
        | { embedding: Buffer; dimensions: number }
        | undefined;
      if (!row) continue;

      // readFloatLE, no una vista Float32Array, por lo mismo que en search:
      // SQLite devuelve Buffers sin garantía de estar alineados a 4 bytes.
      const vector: number[] = [];
      for (let i = 0; i < row.dimensions; i += 1) vector.push(row.embedding.readFloatLE(i * 4));
      found.set(hash, vector);
    }

    return found;
  }

  /**
   * Guarda los embeddings recién calculados.
   *
   * El vector se almacena exactamente como lo devolvió el proveedor:
   * `replaceBranch` normaliza en su camino hacia `chunks`, y hacerlo también acá
   * dejaría dos lugares atribuyéndose el mismo invariante.
   */
  cacheEmbeddings(model: string, entries: { content_hash: string; embedding: number[] }[]): void {
    if (entries.length === 0) return;
    const now = new Date().toISOString();

    // DO NOTHING en vez de un update: una entrada para este modelo y este texto
    // es por definición el mismo vector, así que reescribirla solo costaría páginas.
    const insert = this.db.prepare(`
      INSERT INTO embedding_cache (model, content_hash, embedding, dimensions, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(model, content_hash) DO NOTHING
    `);

    const write = this.db.transaction((rows: { content_hash: string; embedding: number[] }[]) => {
      for (const row of rows) {
        insert.run(
          model,
          row.content_hash,
          Buffer.from(new Float32Array(row.embedding).buffer),
          row.embedding.length,
          now
        );
      }
    });

    write(entries);
  }

  /**
   * Reconstruye el índice FTS a partir de `chunks`.
   *
   * Una tabla FTS5 de contenido externo necesita los valores ORIGINALES de la
   * fila para borrarla, y cada camino de borrado de acá tendría que ir
   * arrastrándolos. Una reconstrucción completa es una sola sentencia, no puede
   * desincronizarse, y con unos miles de chunks cuesta milisegundos: a este
   * tamaño es el trato más seguro.
   */
  private rebuildKeywordIndex(): void {
    this.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
  }

  /**
   * Olvida las ramas que ya no están configuradas (mergeadas, borradas o caídas
   * fuera de la ventana de actividad), para que una feature branch vencida no
   * siga contestando preguntas después de desaparecer.
   */
  pruneBranches(repo: string, keep: string[]): number {
    if (keep.length === 0) return 0;
    const placeholders = keep.map(() => '?').join(', ');

    const prune = this.db.transaction(() => {
      const removed = this.db
        .prepare(`DELETE FROM chunks WHERE repo = ? AND branch NOT IN (${placeholders})`)
        .run(repo, ...keep);
      this.db
        .prepare(`DELETE FROM index_runs WHERE repo = ? AND branch NOT IN (${placeholders})`)
        .run(repo, ...keep);
      if (removed.changes > 0) this.rebuildKeywordIndex();
      return removed.changes;
    });

    return prune();
  }

  /**
   * Búsqueda híbrida: semántica (coseno por fuerza bruta) fusionada con palabra
   * clave (BM25).
   *
   * Acá ninguna de las dos mitades alcanza por sí sola, y lo importante es que
   * fallan en consultas DISTINTAS: la semántica se pierde cuando la consulta no
   * comparte vocabulario con el documento, y BM25 cuando la pregunta es un
   * parafraseo. A cambio, BM25 clava un token exacto y raro ("BILLING", un
   * número de tramite, el nombre de una clase), que es justo lo que un
   * embedding no ve.
   *
   * Medido sobre el corpus real con seis preguntas tomadas de una conversación
   * de uso real (suma = posición del documento esperado sumada sobre las seis
   * preguntas; más bajo es mejor):
   *
   *                          hit@1   hit@5   suma
   *     semántico bge-m3      2/6     4/6     114
   *     solo BM25             2/6     3/6      61
   *     híbrida con bge-m3    2/6     4/6      62
   *
   * La híbrida le gana a BM25 en hit@5 sin perder nada en la suma de
   * posiciones. Salvedad honesta: n=6, y esa diferencia de hit@5 es UNA sola
   * pregunta. La dirección es sólida — la pregunta real sobre BILLING pasó del
   * puesto 146 al 3 — pero no es una estimación precisa.
   *
   * Las dos se combinan con Reciprocal Rank Fusion, que usa solo la POSICIÓN de
   * cada resultado en su propia lista. Eso importa: una similitud coseno y un
   * score BM25 están en escalas incomparables, y cualquier intento de
   * normalizarlos a un solo número exige recalibrar todo el tiempo. Las
   * posiciones no.
   */
  search(queryEmbedding: number[], limit: number, scope: SearchScope = {}, text = ''): SearchHit[] {
    const query = normalizeVector(queryEmbedding);

    const filters: string[] = [];
    const params: string[] = [];
    if (scope.repo) {
      filters.push('repo = ?');
      params.push(scope.repo);
    }
    if (scope.branch) {
      filters.push('branch = ?');
      params.push(scope.branch);
    }
    const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';

    const rows = this.db
      .prepare(
        'SELECT id, repo, alias, branch, path, heading, content, embedding, dimensions, indexed_at FROM chunks' +
          where
      )
      .all(...params);

    const keywordRankByChunkId = this.keywordRanks(text, scope);

    /** id de chunk -> clave de grupo, para que las posiciones por palabra clave sobrevivan a la deduplicación. */
    const groupOfChunk = new Map<number, string>();

    const grouped = new Map<string, SearchHit>();
    for (const raw of rows as StoredRow[]) {
      // Una diferencia de dimensiones significa que la fila la escribió otro
      // modelo de embeddings. Puntuarla no significaría nada, así que se saltea
      // hasta que se reindexe.
      if (raw.dimensions !== query.length) continue;

      // Se lee directo del blob con readFloatLE: SQLite devuelve Buffers que son
      // vistas sobre una reserva compartida y no tienen garantizada la alineación
      // a 4 bytes, que es justo lo que una vista Float32Array rechaza.
      let score = 0;
      for (let i = 0; i < query.length; i += 1) {
        score += query[i]! * raw.embedding.readFloatLE(i * 4);
      }

      // Contenido idéntico en varias ramas colapsa en un solo resultado. La clave
      // es el contenido en sí, no la ruta: el mismo archivo con un cambio en una
      // feature branch es genuinamente otra respuesta y tiene que quedar separado.
      const key = groupKey(raw.repo, raw.path, raw.content);
      groupOfChunk.set(raw.id, key);

      const existing = grouped.get(key);
      if (existing) {
        existing.branches.push(raw.branch);
        // Las filas son idénticas, así que los puntajes también; max() solo
        // protege del ruido de punto flotante de leer dos blobs distintos.
        existing.semantic_score = Math.max(existing.semantic_score, score);
        if (raw.indexed_at > existing.indexed_at) existing.indexed_at = raw.indexed_at;
        continue;
      }

      grouped.set(key, {
        repo: raw.repo,
        alias: raw.alias,
        branches: [raw.branch],
        path: raw.path,
        heading: raw.heading,
        content: raw.content,
        score: 0,
        semantic_score: score,
        keyword_rank: null,
        matched_by: 'semantic',
        indexed_at: raw.indexed_at
      });
    }

    // Para un grupo gana la mejor posición por palabra clave: el mismo texto en
    // dos ramas son dos ids de chunk, y el grupo merece la mejor de las dos posiciones.
    for (const [chunkId, rank] of keywordRankByChunkId) {
      const hit = grouped.get(groupOfChunk.get(chunkId) ?? '');
      if (!hit) continue;
      hit.keyword_rank = hit.keyword_rank === null ? rank : Math.min(hit.keyword_rank, rank);
    }

    const hits = [...grouped.values()];
    for (const hit of hits) hit.branches.sort(compareBranches);

    // Las posiciones semánticas se asignan después de deduplicar, así coinciden
    // con la lista que el llamador realmente ve.
    const bySemantic = [...hits].sort((a, b) => b.semantic_score - a.semantic_score);
    const semanticRank = new Map(bySemantic.map((hit, at) => [hit, at + 1]));

    for (const hit of hits) {
      const fromSemantic = 1 / (RRF_K + (semanticRank.get(hit) ?? Number.MAX_SAFE_INTEGER));
      const fromKeyword = hit.keyword_rank === null ? 0 : 1 / (RRF_K + hit.keyword_rank);

      hit.score = fromSemantic + fromKeyword;
      hit.matched_by = hit.keyword_rank === null ? 'semantic' : 'both';
    }

    hits.sort((a, b) => b.score - a.score || b.semantic_score - a.semantic_score);
    return hits.slice(0, limit);
  }

  /**
   * Corre la mitad por palabra clave y devuelve id de chunk -> posición (desde 1).
   *
   * Una consulta vacía o inservible no produce posiciones, lo que degrada la
   * búsqueda a puramente semántica en vez de hacerla fallar: el llamador siempre
   * recibe una respuesta.
   */
  private keywordRanks(text: string, scope: SearchScope): Map<number, number> {
    const ranks = new Map<number, number>();

    const match = toFtsQuery(text);
    if (match === null) return ranks;

    const filters = ['chunks_fts MATCH ?'];
    const params: (string | number)[] = [match];
    if (scope.repo) {
      filters.push('chunks.repo = ?');
      params.push(scope.repo);
    }
    if (scope.branch) {
      filters.push('chunks.branch = ?');
      params.push(scope.branch);
    }

    try {
      // Que matchee un heading pesa más que el cuerpo del texto: un término en un
      // heading es DE LO QUE TRATA esa sección, no una mención al pasar.
      const rows = this.db
        .prepare(
          `SELECT chunks.id AS id
             FROM chunks_fts
             JOIN chunks ON chunks.id = chunks_fts.rowid
            WHERE ${filters.join(' AND ')}
            ORDER BY bm25(chunks_fts, 3.0, 1.0, 1.0)
            LIMIT ${KEYWORD_CANDIDATES}`
        )
        .all(...params) as { id: number }[];

      rows.forEach((row, at) => ranks.set(row.id, at + 1));
    } catch {
      // Una expresión MATCH malformada nunca puede voltear toda la búsqueda.
      return new Map();
    }

    return ranks;
  }

  stats(): IndexStats[] {
    return this.db
      .prepare(
        'SELECT repo, branch, model, chunks, files, indexed_at FROM index_runs ORDER BY repo, branch'
      )
      .all() as IndexStats[];
  }

  /** Todas las ramas indexadas de un repo. Vacío si el repo nunca se indexó. */
  statsFor(repo: string): IndexStats[] {
    return this.db
      .prepare(
        'SELECT repo, branch, model, chunks, files, indexed_at FROM index_runs ' +
          'WHERE repo = ? ORDER BY branch'
      )
      .all(repo) as IndexStats[];
  }

  /**
   * Modelos de embeddings distintos registrados en `index_runs`, opcionalmente
   * para un repo. Más de una entrada — o una sola que no sea el modelo
   * configurado — significa que parte del índice la construyó otro modelo, algo
   * que un chequeo de dimensiones no puede detectar cuando los dos modelos
   * coinciden en la cantidad de dimensiones.
   */
  indexedModels(repo?: string): string[] {
    const rows = repo
      ? this.db.prepare('SELECT DISTINCT model FROM index_runs WHERE repo = ?').all(repo)
      : this.db.prepare('SELECT DISTINCT model FROM index_runs').all();
    return (rows as { model: string }[]).map(row => row.model);
  }

  totalChunks(scope: SearchScope = {}): number {
    const filters: string[] = [];
    const params: string[] = [];
    if (scope.repo) {
      filters.push('repo = ?');
      params.push(scope.repo);
    }
    if (scope.branch) {
      filters.push('branch = ?');
      params.push(scope.branch);
    }
    const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';

    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM chunks${where}`).get(...params);
    return (row as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}

interface StoredRow {
  id: number;
  repo: string;
  alias: string;
  branch: string;
  path: string;
  heading: string;
  content: string;
  embedding: Buffer;
  dimensions: number;
  indexed_at: string;
}

/**
 * Identidad de un resultado deduplicado. El separador es un carácter de control
 * a propósito: no puede aparecer en el nombre de un repo, en una ruta ni en
 * markdown, así que dos documentos distintos nunca pueden colisionar en un mismo
 * grupo.
 */
function groupKey(repo: string, path: string, content: string): string {
  return [repo, path, content].join('\u0000');
}

/**
 * Convierte una pregunta en lenguaje natural en una expresión MATCH de FTS5.
 *
 * FTS5 tiene su propia sintaxis de consulta, así que el texto crudo del usuario
 * es un error de sintaxis esperando a ocurrir: comillas, guiones, paréntesis y
 * AND/OR/NOT sueltos significan algo. Por eso cada término se extrae y se vuelve
 * a entrecomillar, y se unen con OR para que matchear algunos términos igual
 * puntúe: un AND de todas las palabras no devolvería nada para una oración normal.
 */
export function toFtsQuery(text: string): string | null {
  const terms = text
    .toLowerCase()
    // Se conservan letras, dígitos y acentos; todo lo demás es un separador.
    .split(/[^\p{L}\p{N}]+/u)
    .filter(term => term.length >= MIN_KEYWORD_LENGTH)
    .filter(term => !STOPWORDS.has(term));

  if (terms.length === 0) return null;

  // Entrecomillar convierte cada término en una cadena literal, inmune a los operadores de FTS5.
  return [...new Set(terms)].map(term => `"${term}"`).join(' OR ');
}

/** Los tokens de una y dos letras no aportan señal y hacen explotar el conjunto de candidatos. */
const MIN_KEYWORD_LENGTH = 3;

/**
 * Palabras funcionales del español y del inglés. Sin esto, "como se hace el pago"
 * matchea todo documento que contenga "como" — o sea, todos — y la mitad por
 * palabra clave deja de discriminar.
 */
const STOPWORDS = new Set([
  'como', 'para', 'por', 'que', 'con', 'del', 'las', 'los', 'una', 'uno', 'unos',
  'unas', 'esta', 'este', 'esto', 'estos', 'estas', 'donde', 'cuando', 'cual',
  'cuales', 'sobre', 'entre', 'desde', 'hasta', 'hace', 'hacer', 'ser', 'son',
  'era', 'fue', 'muy', 'mas', 'pero', 'porque', 'sus', 'nos', 'les', 'the',
  'and', 'for', 'with', 'from', 'that', 'this', 'what', 'when', 'where', 'which',
  'how', 'are', 'was', 'were', 'has', 'have', 'its'
]);

/** Producción y réplica primero; las feature branches después, alfabéticamente. */
const BRANCH_PRIORITY = ['main', 'master', 'dev', 'develop'];

function compareBranches(a: string, b: string): number {
  const rankA = BRANCH_PRIORITY.indexOf(a);
  const rankB = BRANCH_PRIORITY.indexOf(b);
  if (rankA !== -1 || rankB !== -1) {
    return (rankA === -1 ? Number.MAX_SAFE_INTEGER : rankA) -
      (rankB === -1 ? Number.MAX_SAFE_INTEGER : rankB);
  }
  return a.localeCompare(b);
}

/**
 * Clave de caché de un texto. Vive acá para que el indexador y el store nunca
 * puedan estar en desacuerdo sobre qué significa "el mismo texto": una segunda
 * implementación de esta única línea convertiría cada acierto de caché en una
 * moneda al aire.
 */
export function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * better-sqlite3 reporta un archivo que no se puede abrir con su propio
 * `SqliteError` y un `code`, no con un Error genérico: SQLITE_NOTADB para un
 * archivo que directamente no es una base, SQLITE_CORRUPT para uno con la
 * estructura dañada. Los dos son culpa del archivo, no un bug que amerite dejar
 * al server en un ciclo de crasheos; cualquier otro SqliteError (por ejemplo un
 * archivo bloqueado) se deja propagar.
 */
function isUnreadableDatabaseError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'SQLITE_NOTADB' || error.code === 'SQLITE_CORRUPT')
  );
}

/** Normalización L2, para que la similitud coseno se reduzca a un producto punto. */
export function normalizeVector(vector: number[]): number[] {
  let sumOfSquares = 0;
  for (const value of vector) sumOfSquares += value * value;

  const magnitude = Math.sqrt(sumOfSquares);
  // Un vector cero no tiene dirección; devolverlo sin cambios lo puntúa en 0
  // contra todo, que es la respuesta honesta.
  if (magnitude === 0 || !Number.isFinite(magnitude)) return vector;

  return vector.map(value => value / magnitude);
}
