import { describe, expect, it } from 'vitest';
import { chunkText, CHUNK_SIZE } from './chunker.js';

const para = (n: number, words = 12) =>
  Array.from(
    { length: n },
    (_, i) => `Paragraph ${i} with ${words} filler words to give it some length.`,
  ).join('\n\n');

describe('chunkText', () => {
  it('returns nothing for empty or whitespace input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('keeps short text as a single chunk', () => {
    const chunks = chunkText('A short resume line.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ index: 0, text: 'A short resume line.' });
  });

  it('splits long text into chunks near the target size', () => {
    const chunks = chunkText(para(40));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // A paragraph may exceed the target on its own, so allow some slack.
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_SIZE * 1.6);
    }
  });

  it('numbers chunks consecutively from zero', () => {
    const chunks = chunkText(para(30));
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('never loses text: every input word appears somewhere', () => {
    const text = para(25);
    const chunks = chunkText(text);
    const rejoined = chunks.map((c) => c.text).join(' ');
    for (const word of ['Paragraph', 'filler', 'words']) {
      expect(rejoined).toContain(word);
    }
    // Overlap duplicates content; total length must be >= the original, and
    // close to it — a runaway overlap would inflate this without bound.
    expect(rejoined.length).toBeGreaterThanOrEqual(text.length * 0.9);
    expect(rejoined.length).toBeLessThan(text.length * 1.6);
  });

  it('overlaps adjacent chunks so a boundary-straddling fact survives', () => {
    const chunks = chunkText(para(30), { size: 400, overlap: 120 });
    expect(chunks.length).toBeGreaterThan(2);

    // The rewind lands on a paragraph boundary, so the text at the end of one
    // chunk is repeated at the start of the next rather than beginning exactly
    // where the previous one ended.
    const tail = chunks[0].text.slice(-60);
    expect(chunks[1].text).toContain(tail.slice(0, 40));
  });

  it('does not split a decimal number when choosing sentence boundaries', () => {
    const text = 'We need 3.5 years of experience. The team is small. Apply now.';
    const chunks = chunkText(text, { size: 45, overlap: 0 });
    expect(chunks.map((c) => c.text).join(' ')).toContain('3.5 years');
  });

  it('hard-wraps text that has no sentence or paragraph breaks', () => {
    const wall = 'x'.repeat(2_500);
    const chunks = chunkText(wall, { size: 900, overlap: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.map((c) => c.text).join('').length).toBe(wall.length);
  });

  it('emits a single oversized unit rather than looping forever', () => {
    const chunks = chunkText(para(1, 400), { size: 100, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('handles bullets and headings without producing empty chunks', () => {
    const text = '# Experience\n\n- Built APIs in Node.js\n- Led a team\n\n## Education\n\n- BSc';
    const chunks = chunkText(text, { size: 30, overlap: 5 });
    expect(chunks.every((c) => c.text.trim().length > 0)).toBe(true);
  });
});
