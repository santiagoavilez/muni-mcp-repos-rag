import assert from 'node:assert/strict';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { EmbeddingsUnavailableError } from '../src/core/errors.js';
import { OllamaEmbeddingProvider } from '../src/rag/embeddings.js';

/**
 * El mensaje de falla es todo el sentido de estos tests: cuando Ollama no está
 * corriendo, quien lea la salida tiene que ver algo sobre lo que pueda actuar, no
 * un stack trace.
 */
test('an unreachable Ollama explains how to start it', async () => {
  // El puerto 1 es privilegiado y nunca escucha: un rechazo de conexión determinista.
  const provider = new OllamaEmbeddingProvider({
    baseUrl: 'http://127.0.0.1:1',
    model: 'nomic-embed-text',
    timeoutMs: 2_000
  });

  await assert.rejects(
    () => provider.embedQuery('hola'),
    (error: unknown) =>
      error instanceof EmbeddingsUnavailableError &&
      /Cannot reach Ollama/.test(error.message) &&
      /ollama serve/.test(error.message)
  );
});

test('a missing model says which model to pull', async () => {
  const server = await startTestServer((_request, response) => {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'model "nomic-embed-text" not found, try pulling it' }));
  });

  const provider = new OllamaEmbeddingProvider({
    baseUrl: `http://127.0.0.1:${server.port}`,
    model: 'nomic-embed-text',
    timeoutMs: 2_000
  });

  // Un 404 en /api/embed significa "Ollama viejo, usá el endpoint anterior"; el
  // endpoint anterior después reporta el problema real.
  await assert.rejects(
    () => provider.embedQuery('hola'),
    (error: unknown) =>
      error instanceof EmbeddingsUnavailableError &&
      /ollama pull nomic-embed-text/.test(error.message)
  );

  await server.close();
});

test('the batch endpoint is used when available: one call for many inputs', async () => {
  let calls = 0;
  const server = await startTestServer(async (request, response) => {
    calls += 1;
    assert.equal(request.url, '/api/embed');

    const body = JSON.parse(await readBody(request)) as { input: string | string[] };
    const inputs = Array.isArray(body.input) ? body.input : [body.input];

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ embeddings: inputs.map(() => [0.1, 0.2, 0.3]) }));
  });

  const provider = new OllamaEmbeddingProvider({
    baseUrl: `http://127.0.0.1:${server.port}`,
    model: 'nomic-embed-text',
    timeoutMs: 2_000
  });

  const vectors = await provider.embedDocuments(['uno', 'dos', 'tres']);

  assert.equal(vectors.length, 3);
  // Un tanteo más una llamada por lote: nunca una llamada por documento.
  assert.equal(calls, 2);

  await server.close();
});

test('nomic models get the task prefixes they were trained with', async () => {
  const seen: string[] = [];
  const server = await startTestServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as { input: string | string[] };
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    seen.push(...inputs);

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ embeddings: inputs.map(() => [1, 0]) }));
  });

  const provider = new OllamaEmbeddingProvider({
    baseUrl: `http://127.0.0.1:${server.port}`,
    model: 'nomic-embed-text',
    timeoutMs: 2_000
  });

  await provider.embedDocuments(['un documento']);
  await provider.embedQuery('una pregunta');

  assert.ok(seen.includes('search_document: un documento'));
  assert.ok(seen.includes('search_query: una pregunta'));

  await server.close();
});

interface TestServer {
  port: number;
  close: () => Promise<void>;
}

async function startTestServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
): Promise<TestServer> {
  const server = createServer((request, response) => {
    void handler(request, response);
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');

  return {
    port: address.port,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
