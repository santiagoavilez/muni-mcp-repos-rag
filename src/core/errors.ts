/**
 * Domain errors. Anything thrown from these classes is turned into a readable
 * tool error by `tools/shared.ts#guard`, so the agent can correct itself and
 * retry instead of seeing a transport-level crash.
 */

/** A repo, file or path that does not exist (or the token cannot see it). */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Input the caller can fix: unknown alias, empty query, bad path. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** GitHub secondary/primary rate limit. Carries the reset time when GitHub sends one. */
export class RateLimitError extends Error {
  readonly resetAt: Date | null;

  constructor(message: string, resetAt: Date | null = null) {
    super(message);
    this.name = 'RateLimitError';
    this.resetAt = resetAt;
  }
}

/** The token exists but lacks the permission the call needs. */
export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

/** Ollama is unreachable, the model is missing, or it answered something unusable. */
export class EmbeddingsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingsUnavailableError';
  }
}

/** The index is empty or missing for the requested scope — the fix is refresh_index. */
export class IndexEmptyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexEmptyError';
  }
}

/** Errors whose message is safe and useful to hand back to the agent verbatim. */
export const DOMAIN_ERRORS = [
  NotFoundError,
  ValidationError,
  RateLimitError,
  PermissionError,
  EmbeddingsUnavailableError,
  IndexEmptyError
] as const;
