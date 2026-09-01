import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DOMAIN_ERRORS } from '../core/errors.js';

export function ok(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

export function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Ejecuta el cuerpo de una tool y convierte los errores de dominio en tool errors
 * legibles en vez de excepciones a nivel de transporte, para que el agente se
 * corrija solo y reintente.
 */
export async function guard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    if (DOMAIN_ERRORS.some(type => error instanceof type)) {
      return fail((error as Error).message);
    }
    // Al agente le llega solo el mensaje; el stack tiene que sobrevivir en algún
    // lado donde una persona pueda encontrarlo, y stderr es el único canal que
    // MCP deja para eso.
    console.error('[tool] unexpected error:', error);
    const detail = error instanceof Error ? error.message : String(error);
    return fail(`Unexpected error: ${detail}`);
  }
}
