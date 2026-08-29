export interface Chunk {
  /** 0-based position of this chunk inside its file. */
  index: number;
  /** Nearest markdown heading above the chunk, kept so citations read well. */
  heading: string;
  text: string;
}

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
}

const DEFAULT_MAX_CHARS = 1_200;
const DEFAULT_OVERLAP_CHARS = 150;

/**
 * Splits a markdown document into retrievable chunks.
 *
 * Sections are cut at headings first, because a heading is the strongest signal
 * of "one idea" that a README gives us. Sections longer than maxChars are then
 * split on paragraph boundaries with a small overlap, so a sentence straddling
 * the cut still appears whole in one of the two chunks.
 */
export function chunkMarkdown(source: string, options: ChunkOptions = {}): Chunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapChars = Math.max(
    0,
    Math.min(options.overlapChars ?? DEFAULT_OVERLAP_CHARS, maxChars - 1)
  );

  const chunks: Chunk[] = [];
  for (const section of splitByHeading(normalize(source))) {
    for (const piece of splitLongText(section.body, maxChars, overlapChars)) {
      const text = piece.trim();
      if (text === '') continue;
      chunks.push({ index: chunks.length, heading: section.heading, text });
    }
  }
  return chunks;
}

interface Section {
  heading: string;
  body: string;
}

function normalize(source: string): string {
  // Strip a leading BOM and fold non-breaking spaces, which GitHub-rendered
  // markdown is full of and which would otherwise reach the embedding model.
  return source
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00A0/g, ' ');
}

function splitByHeading(source: string): Section[] {
  const lines = source.split('\n');
  const sections: Section[] = [];
  let heading = '';
  let buffer: string[] = [];
  let insideFence = false;

  const flush = (): void => {
    const body = buffer.join('\n').trim();
    if (body !== '') sections.push({ heading, body });
    buffer = [];
  };

  for (const line of lines) {
    // A "# " inside a fenced code block is code, not a heading.
    if (/^\s*(```|~~~)/.test(line)) insideFence = !insideFence;

    const match = insideFence ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      flush();
      heading = match[2]?.trim() ?? '';
      // The heading stays in the body so its words are searchable too.
      buffer.push(line);
      continue;
    }
    buffer.push(line);
  }
  flush();

  return sections;
}

function splitLongText(body: string, maxChars: number, overlapChars: number): string[] {
  if (body.length <= maxChars) return [body];

  const pieces: string[] = [];
  const paragraphs = body.split(/\n{2,}/);

  let current = '';
  /** Length of the leading overlap carried over from the previous piece. */
  let carried = 0;

  const flush = (): void => {
    if (current.length > carried) pieces.push(current);
    const tail = overlapChars > 0 ? current.slice(-overlapChars) : '';
    current = tail;
    carried = tail.length;
  };

  for (const paragraph of paragraphs) {
    // A single paragraph bigger than the budget is cut on raw length; nothing
    // smarter is available without a sentence tokenizer.
    if (paragraph.length > maxChars) {
      flush();
      const stride = Math.max(1, maxChars - overlapChars);
      for (let at = 0; at < paragraph.length; at += stride) {
        pieces.push(paragraph.slice(at, at + maxChars));
      }
      current = '';
      carried = 0;
      continue;
    }

    if (current !== '' && current.length + paragraph.length + 2 > maxChars) flush();
    current = current === '' ? paragraph : `${current}\n\n${paragraph}`;
  }

  // Only emit the tail when it holds something beyond the carried overlap;
  // otherwise the last chunk would be a duplicate of the previous one's end.
  if (current.length > carried) pieces.push(current);

  return pieces;
}
