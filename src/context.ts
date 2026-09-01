import { ReposConfig, loadReposConfig } from './config/repos.js';
import { readEnv, requireEnv } from './core/env.js';
import { GitHubClient } from './github/types.js';
import { MockGitHubClient } from './github/mockClient.js';
import { OctokitGitHubClient } from './github/octokitClient.js';
import { EmbeddingProvider, OllamaEmbeddingProvider } from './rag/embeddings.js';
import { Indexer } from './rag/indexer.js';
import { VectorStore } from './rag/store.js';

/** Todo de lo que dependen las tools, construido una sola vez al arrancar. */
export interface ServerContext {
  config: ReposConfig;
  github: GitHubClient;
  embeddings: EmbeddingProvider;
  store: VectorStore;
  indexer: Indexer;
  /** Descripción legible del cableado, para la línea de log del arranque. */
  label: string;
}

export function buildContext(): ServerContext {
  const config = loadReposConfig();
  const mode = readEnv('REPO_RAG_MODE', 'github').toLowerCase();

  let github: GitHubClient;
  if (mode === 'mock') {
    github = new MockGitHubClient();
  } else if (mode === 'github') {
    github = new OctokitGitHubClient(requireEnv('GITHUB_TOKEN'));
  } else {
    throw new Error(`Unknown REPO_RAG_MODE "${mode}". Valid values: github, mock.`);
  }

  const embeddings = new OllamaEmbeddingProvider({
    baseUrl: readEnv('REPO_RAG_OLLAMA_URL', 'http://localhost:11434'),
    // bge-m3 por defecto, no nomic-embed-text. Medido sobre el corpus real con
    // preguntas reales en español: el hit@5 del semántico solo pasó de 2/6 a
    // 4/6, y la pregunta que motivó la búsqueda híbrida saltó del puesto 146 al
    // 3. Importa más de lo que parece: con nomic la mitad semántica era peso
    // muerto y BM25 solo le ganaba a la híbrida, así que la fusión pagaba una
    // complejidad que nunca se ganó. Cuesta 2.3x más por chunk, y eso lo paga
    // solo un reindexado en frío: el caché de embeddings absorbe cada refresh
    // en caliente.
    model: readEnv('REPO_RAG_EMBED_MODEL', 'bge-m3')
  });

  const store = new VectorStore(readEnv('REPO_RAG_DB_PATH', 'data/index.db'));
  const indexer = new Indexer(config, github, embeddings, store);

  return {
    config,
    github,
    embeddings,
    store,
    indexer,
    label: `${mode} · ${config.all.length} repos · embeddings ${embeddings.model}`
  };
}
