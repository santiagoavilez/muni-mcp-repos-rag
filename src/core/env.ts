import { ENV_PATH } from './paths.js';

let envFileLoaded = false;

/**
 * MCP clients spawn this server over stdio without a shell, so the parent
 * environment is usually empty. The .env next to the server is the real source
 * of configuration and is loaded here, once, before anything reads process.env.
 */
export function loadEnvFile(): void {
  try {
    process.loadEnvFile(ENV_PATH);
    envFileLoaded = true;
  } catch {
    // Absent .env is fine: mock mode needs nothing, and real values may come
    // from the parent environment when the server is started by hand.
  }
}

export function envFileStatus(): string {
  return envFileLoaded ? `loaded from ${ENV_PATH}` : `NOT found at ${ENV_PATH}`;
}

export function readEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

/**
 * Reads a required variable. The message names VARIABLES ONLY, never values —
 * one of these is a token.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. .env ${envFileStatus()}. ` +
        'Expected names are documented in .env.example.'
    );
  }
  return value.trim();
}
