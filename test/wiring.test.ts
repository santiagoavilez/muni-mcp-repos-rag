import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fromProjectRoot } from '../src/core/paths.js';

/**
 * Guards the one failure the rest of the suite cannot see.
 *
 * Every other tool test builds its OWN McpServer and calls the register
 * functions by hand, which is what makes those tests fast and network-free —
 * but it also means nothing exercises `src/index.ts`. Forget the wiring line
 * there and the whole suite still passes while the tool simply does not exist
 * at runtime, which is the worst shape a bug can take: invisible in CI and
 * total in production.
 *
 * `src/index.ts` cannot just be imported to check: it loads the env, builds the
 * real context (which demands a GITHUB_TOKEN) and connects a stdio transport at
 * module level. So the check is static — read the file and confirm every
 * register function a tool exports is actually called there.
 */
test('every tool exported under src/tools is registered in src/index.ts', () => {
  const entry = readFileSync(fromProjectRoot('src/index.ts'), 'utf8');

  const toolFiles = readdirSync(fromProjectRoot('src/tools')).filter(
    name => name.endsWith('.ts') && name !== 'shared.ts'
  );
  assert.ok(toolFiles.length > 0, 'expected to find tool files to check');

  const missing: string[] = [];
  for (const file of toolFiles) {
    const source = readFileSync(fromProjectRoot(`src/tools/${file}`), 'utf8');

    for (const match of source.matchAll(/export function (register\w+)/g)) {
      const fn = match[1]!;
      const imported = new RegExp(`\\b${fn}\\b`).test(entry);
      const called = new RegExp(`${fn}\\s*\\(\\s*server\\s*,\\s*context\\s*\\)`).test(entry);
      if (!imported || !called) missing.push(`${fn} (${file})`);
    }
  }

  assert.deepEqual(missing, [], 'these tools are never registered in src/index.ts');
});
