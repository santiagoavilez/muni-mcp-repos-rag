import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DOMAIN_ERRORS } from '../core/errors.js';

export function ok(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

export function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Runs a tool body and turns domain errors into readable tool errors instead of
 * transport-level exceptions, so the agent can correct itself and retry.
 */
export async function guard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    if (DOMAIN_ERRORS.some(type => error instanceof type)) {
      return fail((error as Error).message);
    }
    const detail = error instanceof Error ? error.message : String(error);
    return fail(`Unexpected error: ${detail}`);
  }
}
