import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fromProjectRoot } from '../src/core/paths.js';

/**
 * Cubre la única falla que el resto de la suite no puede ver.
 *
 * Todos los demás tests de tools arman su PROPIO McpServer y llaman a mano a las
 * funciones de registro, que es lo que los hace rápidos y sin red, pero también
 * significa que nada ejercita `src/index.ts`. Si se olvida ahí la línea de
 * cableado, toda la suite igual pasa mientras la tool simplemente no existe en
 * runtime, que es la peor forma que puede tomar un bug: invisible en CI y total
 * en producción.
 *
 * `src/index.ts` no se puede importar y ya para chequearlo: carga el entorno,
 * construye el contexto real (que exige un GITHUB_TOKEN) y conecta un transporte
 * stdio a nivel de módulo. Por eso el chequeo es estático: se lee el archivo y se
 * confirma que cada función de registro que exporta una tool se llame realmente ahí.
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
