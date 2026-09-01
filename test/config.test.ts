import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesDocPattern } from '../src/config/repos.js';
import { ValidationError } from '../src/core/errors.js';
import { testConfig } from './fixtures.js';

test('resolves a repo by alias, bare name and owner/repo', () => {
  const config = testConfig();

  assert.equal(config.resolve('turnos').fullName, 'example-org/turnos');
  assert.equal(config.resolve('TURNOS').fullName, 'example-org/turnos');
  assert.equal(config.resolve('example-org/turnos').alias, 'turnos');
});

test('an unknown repo names the configured aliases so the agent can retry', () => {
  const config = testConfig();

  assert.throws(
    () => config.resolve('no-existe'),
    (error: unknown) =>
      error instanceof ValidationError && /turnos, tramites/.test(error.message)
  );
});

test('per-repo docs fall back to defaultDocs', () => {
  const config = testConfig();
  assert.deepEqual(config.resolve('turnos').docPatterns, ['README.md', 'TRACKER.md', 'docs/**']);
});

test('doc patterns match exact paths and markdown under a glob only', () => {
  assert.equal(matchesDocPattern('README.md', 'README.md'), true);
  assert.equal(matchesDocPattern('docs/README.md', 'README.md'), false);

  assert.equal(matchesDocPattern('docs/NEGOCIO.md', 'docs/**'), true);
  assert.equal(matchesDocPattern('docs/deep/nested.md', 'docs/**'), true);
  // Un glob no puede arrastrar código fuente adentro del índice.
  assert.equal(matchesDocPattern('docs/logo.png', 'docs/**'), false);
  assert.equal(matchesDocPattern('src/app.ts', 'docs/**'), false);
});

test('"*.md" takes root markdown only, never nested files', () => {
  // El sentido de este patrón: documentos de diseño en la raíz que nadie puede nombrar de antemano.
  assert.equal(matchesDocPattern('EXTERNAL_ORIGIN_API_DOCUMENTATION.md', '*.md'), true);
  assert.equal(matchesDocPattern('README.md', '*.md'), true);

  assert.equal(matchesDocPattern('docs/NEGOCIO.md', '*.md'), false);
  assert.equal(matchesDocPattern('deep/nested/file.md', '*.md'), false);
  assert.equal(matchesDocPattern('logo.png', '*.md'), false);
});

test('"**" takes every markdown at any depth', () => {
  assert.equal(matchesDocPattern('README.md', '**'), true);
  assert.equal(matchesDocPattern('a/b/c/deep.md', '**'), true);
  assert.equal(matchesDocPattern('src/app.ts', '**'), false);
});
