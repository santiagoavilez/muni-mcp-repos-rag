export interface Chunk {
  /** Posición del chunk dentro de su archivo, empezando en 0. */
  index: number;
  /** Heading markdown más cercano por encima del chunk; se guarda para que las citas se lean bien. */
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
 * Trocea un documento markdown en chunks recuperables.
 *
 * Primero se corta por headings, porque un heading es la señal más fuerte de
 * "una idea" que da un README. Las secciones más largas que maxChars se parten
 * después en límites de párrafo con un pequeño solapamiento, así una oración que
 * queda a caballo del corte aparece entera en al menos uno de los dos chunks.
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
  // Saca el BOM inicial y normaliza los espacios duros, de los que el markdown
  // renderizado por GitHub está lleno y que si no llegarían al modelo de embeddings.
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
    // Un "# " dentro de un bloque de código cercado es código, no un heading.
    if (/^\s*(```|~~~)/.test(line)) insideFence = !insideFence;

    const match = insideFence ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      flush();
      heading = match[2]?.trim() ?? '';
      // El heading queda en el cuerpo para que sus palabras también sean buscables.
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
  /** Largo del solapamiento inicial arrastrado desde el pedazo anterior. */
  let carried = 0;

  const flush = (): void => {
    if (current.length > carried) pieces.push(current);
    const tail = overlapChars > 0 ? current.slice(-overlapChars) : '';
    current = tail;
    carried = tail.length;
  };

  for (const paragraph of paragraphs) {
    // Un párrafo solo más grande que el presupuesto se corta por largo crudo; no
    // hay nada más inteligente disponible sin un tokenizador de oraciones.
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

  // La cola se emite solo si tiene algo más allá del solapamiento arrastrado; si
  // no, el último chunk sería un duplicado del final del anterior.
  if (current.length > carried) pieces.push(current);

  return pieces;
}
