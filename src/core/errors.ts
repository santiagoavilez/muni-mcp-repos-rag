/**
 * Errores de dominio. Todo lo que se lance desde estas clases lo convierte
 * `tools/shared.ts#guard` en un tool error legible, para que el agente se
 * corrija solo y reintente en vez de ver un crash a nivel de transporte.
 */

/** Un repo, archivo o ruta que no existe (o que el token no puede ver). */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Entrada que el llamador puede corregir: alias desconocido, query vacía, ruta inválida. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Rate limit primario o secundario de GitHub. Lleva la hora de reset cuando GitHub la manda. */
export class RateLimitError extends Error {
  readonly resetAt: Date | null;

  constructor(message: string, resetAt: Date | null = null) {
    super(message);
    this.name = 'RateLimitError';
    this.resetAt = resetAt;
  }
}

/** El token existe pero no tiene el permiso que la llamada necesita. */
export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

/** Ollama no responde, falta el modelo, o contestó algo inservible. */
export class EmbeddingsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingsUnavailableError';
  }
}

/** El índice está vacío o no existe para el alcance pedido; se arregla con refresh_index. */
export class IndexEmptyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexEmptyError';
  }
}

/** Errores cuyo mensaje es seguro y útil para devolverle al agente tal cual. */
export const DOMAIN_ERRORS = [
  NotFoundError,
  ValidationError,
  RateLimitError,
  PermissionError,
  EmbeddingsUnavailableError,
  IndexEmptyError
] as const;
