import { ENV_PATH } from './paths.js';

let envFileLoaded = false;

/**
 * Los clientes MCP levantan este server por stdio y sin shell, así que el
 * entorno del proceso padre suele venir vacío. El .env que está al lado del
 * server es la verdadera fuente de configuración: se carga acá, una sola vez,
 * antes de que algo lea process.env.
 */
export function loadEnvFile(): void {
  try {
    process.loadEnvFile(ENV_PATH);
    envFileLoaded = true;
  } catch {
    // Que falte el .env no es problema: el modo mock no necesita nada, y los
    // valores reales pueden venir del entorno padre si el server se arranca a mano.
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
 * Lee una variable obligatoria. El mensaje nombra SOLO VARIABLES, nunca
 * valores: una de ellas es un token.
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
