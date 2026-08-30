import { EmbeddingsUnavailableError } from '../core/errors.js';

export interface EmbeddingProvider {
  readonly model: string;
  /** Embeds documents being indexed. */
  embedDocuments(texts: string[]): Promise<number[][]>;
  /** Embeds a search query. Some models want a different prefix than documents. */
  embedQuery(text: string): Promise<number[]>;
}

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  /** Per-request timeout. Embedding a cold model can genuinely take a while. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Embeddings from a local Ollama, over plain fetch — no SDK.
 *
 * Ollama moved from POST /api/embeddings (one prompt) to POST /api/embed
 * (batched). Which one exists depends on the installed version, so the first
 * call probes /api/embed and remembers the answer for the rest of the process.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private endpoint: 'batch' | 'legacy' | null = null;

  constructor(options: OllamaOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this.embed(texts.map(text => this.prefix(text, 'search_document')));
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embed([this.prefix(text, 'search_query')]);
    if (!vector) {
      throw new EmbeddingsUnavailableError('Ollama returned no embedding for the query.');
    }
    return vector;
  }

  /**
   * nomic-embed-text is trained with task prefixes and loses accuracy without
   * them. Other models are not, so they are left untouched.
   */
  private prefix(text: string, task: 'search_document' | 'search_query'): string {
    return /nomic/i.test(this.model) ? `${task}: ${text}` : text;
  }

  private async embed(inputs: string[]): Promise<number[][]> {
    if (this.endpoint === null) {
      this.endpoint = (await this.supportsBatchEndpoint()) ? 'batch' : 'legacy';
    }

    if (this.endpoint === 'batch') {
      const body = await this.post('/api/embed', { model: this.model, input: inputs });
      const vectors = (body as { embeddings?: number[][] }).embeddings;
      if (!Array.isArray(vectors) || vectors.length !== inputs.length) {
        throw new EmbeddingsUnavailableError(
          `Ollama /api/embed returned ${Array.isArray(vectors) ? vectors.length : 'no'} ` +
            `embeddings for ${inputs.length} inputs.`
        );
      }
      return vectors.map(vector => assertVector(vector, this.model));
    }

    // Legacy endpoint takes one prompt per call; sequential keeps a laptop-sized
    // Ollama from queueing dozens of parallel generations.
    const out: number[][] = [];
    for (const input of inputs) {
      const body = await this.post('/api/embeddings', { model: this.model, prompt: input });
      out.push(assertVector((body as { embedding?: number[] }).embedding, this.model));
    }
    return out;
  }

  private async supportsBatchEndpoint(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: 'ping' }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (response.status === 404) return false;
      if (!response.ok) throw await this.describeFailure(response);
      return true;
    } catch (error) {
      if (error instanceof EmbeddingsUnavailableError) throw error;
      throw this.describeNetworkFailure(error);
    }
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw this.describeNetworkFailure(error);
    }

    if (!response.ok) throw await this.describeFailure(response);

    try {
      return await response.json();
    } catch {
      throw new EmbeddingsUnavailableError(
        `Ollama at ${this.baseUrl} answered ${path} with something that is not JSON.`
      );
    }
  }

  private async describeFailure(response: Response): Promise<EmbeddingsUnavailableError> {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    if (/not found|no such model|pull the model/i.test(detail)) {
      return new EmbeddingsUnavailableError(
        `Ollama does not have the model "${this.model}". Run: ollama pull ${this.model}`
      );
    }
    return new EmbeddingsUnavailableError(
      `Ollama at ${this.baseUrl} answered ${response.status}${detail ? `: ${detail}` : '.'}`
    );
  }

  private describeNetworkFailure(error: unknown): EmbeddingsUnavailableError {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new EmbeddingsUnavailableError(
        `Ollama at ${this.baseUrl} did not answer within ${this.timeoutMs}ms. ` +
          'The model may still be loading — retry once.'
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    return new EmbeddingsUnavailableError(
      `Cannot reach Ollama at ${this.baseUrl} (${detail}). Start it with "ollama serve" ` +
        `and make sure the model is pulled: ollama pull ${this.model}`
    );
  }
}

function assertVector(vector: unknown, model: string): number[] {
  // Number.isFinite, not typeof: a NaN component would be persisted as-is and
  // every later search against it scores NaN, silently.
  if (!Array.isArray(vector) || vector.length === 0 || vector.some(v => !Number.isFinite(v))) {
    throw new EmbeddingsUnavailableError(
      `Ollama returned an unusable embedding for model "${model}".`
    );
  }
  return vector as number[];
}
