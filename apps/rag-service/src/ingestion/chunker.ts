/**
 * Splits text into overlapping chunks sized for embedding models.
 *
 * Chunking is the step that most quietly ruins a RAG system: chunk too large and
 * a posting's requirements get averaged into a vague vector; too small and
 * "5+ years of Kubernetes" loses its context. The defaults below target
 * paragraph-level semantic units, which is where job requirements and resume
 * bullets actually live.
 */

export const CHUNK_SIZE = 900; // characters, ~220 tokens
export const CHUNK_OVERLAP = 150; // ~18%; keeps a fact spanning a split intact

export interface Chunk {
  index: number;
  text: string;
}

const PARAGRAPH_SPLIT = /\n\s*\n/;

/**
 * Prefer paragraph boundaries, then sentence boundaries, then hard-wrap.
 * Every candidate boundary is scored by how close it is to the target size, so
 * chunks stay near CHUNK_SIZE without needing a tokenizer.
 */
export function chunkText(
  text: string,
  options: { size?: number; overlap?: number } = {},
): Chunk[] {
  const size = options.size ?? CHUNK_SIZE;
  const overlap = Math.min(options.overlap ?? CHUNK_OVERLAP, Math.floor(size / 2));
  const clean = text.trim();

  if (!clean) return [];
  if (clean.length <= size) return [{ index: 0, text: clean }];

  const units = splitIntoUnits(clean, size);
  const chunks: Chunk[] = [];
  let start = 0;

  while (start < units.length) {
    // Greedily pack units until adding the next one would exceed the target.
    let end = start;
    let length = 0;
    while (end < units.length && length + units[end].length <= size) {
      length += units[end].length;
      end += 1;
    }

    if (end === start) {
      // A single unit longer than `size` (a wall of text with no breaks): emit
      // it as-is rather than looping forever.
      chunks.push({ index: chunks.length, text: units[start].trim() });
      start += 1;
      continue;
    }

    chunks.push({ index: chunks.length, text: units.slice(start, end).join('\n\n').trim() });
    if (end >= units.length) break;

    // Rewind start by roughly `overlap` characters so a fact that straddles the
    // boundary is retrievable from either chunk. Never below start + 1, which
    // would re-emit the window we just produced.
    let next = end;
    let carried = 0;
    while (next > start + 1 && carried < overlap) {
      next -= 1;
      carried += units[next].length;
    }
    start = next;
  }

  return chunks.filter((c) => c.text.length > 0);
}

/** Paragraphs, split further when a single paragraph is too long to fit. */
function splitIntoUnits(text: string, size: number): string[] {
  const paragraphs = text
    .split(PARAGRAPH_SPLIT)
    .map((p) => p.trim())
    .filter(Boolean);
  const units: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= size) {
      units.push(paragraph);
      continue;
    }
    for (const sentence of splitSentences(paragraph, size)) {
      if (sentence.length <= size) {
        units.push(sentence);
      } else {
        // No sentence boundaries at all: hard-wrap so we still make progress.
        for (let i = 0; i < sentence.length; i += size) {
          units.push(sentence.slice(i, i + size));
        }
      }
    }
  }

  return units;
}

/** Split after ., !, ?, or a bullet, but not inside a decimal or an abbreviation. */
function splitSentences(paragraph: string, size: number): string[] {
  const out: string[] = [];
  let start = 0;

  for (let i = 0; i < paragraph.length; i++) {
    const ch = paragraph[i];
    const isBoundary = ch === '.' || ch === '!' || ch === '?' || ch === '\n';
    if (!isBoundary) continue;

    // "3.5 years", "v1.2" — a digit on both sides means a decimal, not an end.
    if (ch === '.' && /\d/.test(paragraph[i - 1] ?? '') && /\d/.test(paragraph[i + 1] ?? ''))
      continue;

    const piece = paragraph.slice(start, i + 1).trim();
    if (piece.length >= size * 0.4) {
      out.push(piece);
      start = i + 1;
    }
  }

  const tail = paragraph.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}
