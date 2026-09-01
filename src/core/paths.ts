import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * La raíz del proyecto: la carpeta que contiene package.json, .env y repos.json.
 *
 * Se resuelve contra ESTE ARCHIVO, no contra process.cwd(): los clientes MCP
 * levantan el server desde el repo en el que el desarrollador esté trabajando,
 * así que una búsqueda relativa al cwd se perdería en silencio la configuración
 * que está al lado del server.
 *
 * src/core/paths.ts -> ../..  y  dist/core/paths.js -> ../..  caen los dos acá.
 */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ENV_PATH = join(PROJECT_ROOT, '.env');
export const REPOS_CONFIG_PATH = join(PROJECT_ROOT, 'repos.json');

/** Resuelve una ruta configurada; las relativas se toman desde la raíz del proyecto. */
export function fromProjectRoot(path: string): string {
  return isAbsolute(path) ? path : join(PROJECT_ROOT, path);
}
