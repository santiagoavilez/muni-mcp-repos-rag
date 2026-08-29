import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The project root — the folder holding package.json, .env and repos.json.
 *
 * Resolved against THIS FILE, not process.cwd(): MCP clients spawn the server
 * from whatever repo the developer happens to be working in, so a cwd-relative
 * lookup would silently miss the config sitting next to the server.
 *
 * src/core/paths.ts -> ../..  and  dist/core/paths.js -> ../..  both land here.
 */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ENV_PATH = join(PROJECT_ROOT, '.env');
export const REPOS_CONFIG_PATH = join(PROJECT_ROOT, 'repos.json');

/** Resolves a configured path, treating relative values as project-root relative. */
export function fromProjectRoot(path: string): string {
  return isAbsolute(path) ? path : join(PROJECT_ROOT, path);
}
