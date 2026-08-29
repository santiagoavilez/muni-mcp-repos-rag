import { ReposConfig, loadReposConfig } from './config/repos.js';
import { readEnv, requireEnv } from './core/env.js';
import { GitHubClient } from './github/types.js';
import { MockGitHubClient } from './github/mockClient.js';
import { OctokitGitHubClient } from './github/octokitClient.js';
import { EmbeddingProvider, OllamaEmbeddingProvider } from './rag/embeddings.js';
import { Indexer } from './rag/indexer.js';
import { VectorStore } from './rag/store.js';

/** Everything the tools depend on, built once at startup. */
export interface ServerContext {
  config: ReposConfig;
  github: GitHubClient;
  embeddings: EmbeddingProvider;
  store: VectorStore;
  indexer: Indexer;
  /** Human-readable description of the wiring, for the startup log line. */
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
    // bge-m3 by default, not nomic-embed-text. Measured on the real corpus with
    // real questions in Spanish: semantic-only hit@5 went 2/6 -> 4/6, and the
    // question that motivated the hybrid search moved from rank 146 to rank 3.
    // It matters more than it looks: with nomic the semantic half was dead
    // weight and BM25 alone beat the hybrid, so the fusion was paying for
    // complexity it never earned. It costs 2.3x more per chunk, which only a
    // cold reindex pays — the embedding cache absorbs every warm refresh.
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
