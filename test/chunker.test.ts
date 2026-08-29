import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkMarkdown } from '../src/rag/chunker.js';
import { TURNOS_README } from './fixtures.js';

test('splits a document at its headings', () => {
  const chunks = chunkMarkdown(TURNOS_README);

  assert.deepEqual(
    chunks.map(chunk => chunk.heading),
    ['Sistema de Turnos', 'Autenticacion', 'Notificaciones']
  );
  // The heading stays inside the text so its words are searchable too.
  assert.match(chunks[1]!.text, /## Autenticacion/);
  assert.match(chunks[1]!.text, /DNI/);
});

test('chunk indexes are contiguous from zero', () => {
  const chunks = chunkMarkdown(TURNOS_README);
  assert.deepEqual(
    chunks.map(chunk => chunk.index),
    chunks.map((_, at) => at)
  );
});

test('a "#" inside a fenced code block is not treated as a heading', () => {
  const source = ['# Real', 'texto', '', '```bash', '# esto es un comentario', '```'].join('\n');

  const headings = chunkMarkdown(source).map(chunk => chunk.heading);
  assert.deepEqual(headings, ['Real']);
});

test('a section longer than the budget is split with overlap and no empty tail', () => {
  const paragraph = 'palabra '.repeat(60).trim();
  const source = `# Larga\n\n${[paragraph, paragraph, paragraph, paragraph].join('\n\n')}`;

  const chunks = chunkMarkdown(source, { maxChars: 400, overlapChars: 50 });

  assert.ok(chunks.length > 1, 'expected the section to be split');
  for (const chunk of chunks) {
    assert.ok(chunk.text.length > 0);
    assert.ok(chunk.text.length <= 400 + 50, `chunk too long: ${chunk.text.length}`);
  }
  // The last chunk must carry real content, not just the previous overlap.
  const last = chunks.at(-1)!.text;
  assert.ok(last.length > 50, 'last chunk is only the carried overlap');
});

test('an empty document produces no chunks', () => {
  assert.deepEqual(chunkMarkdown('   \n\n  '), []);
});
