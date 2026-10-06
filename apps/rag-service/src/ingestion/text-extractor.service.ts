import { Injectable, Logger } from '@nestjs/common';
import { extname } from 'node:path';

export type DetectedKind = 'pdf' | 'docx' | 'text';

export interface ExtractedDocument {
  text: string;
  /** Chosen by sniffing, because browsers lie about content types. */
  detected: DetectedKind;
  truncated: boolean;
  /** How the kind was decided: the bytes, or the file name when they were ambiguous. */
  detectedBy: 'magic-bytes' | 'extension' | 'fallback';
}

const MAX_CHARS = 2_000_000; // ~500k tokens; far beyond any real resume

/**
 * Pulls plain text out of an uploaded document.
 *
 * Extraction is lazy: `pdf-parse` and `mammoth` are heavy and only needed for
 * their own format, so they load on first use. That keeps the service's boot
 * time and memory low when users mostly upload .txt or .md.
 */
@Injectable()
export class TextExtractor {
  private readonly log = new Logger(TextExtractor.name);

  async extract(bytes: Buffer, fileName: string): Promise<ExtractedDocument> {
    const { kind: ext, by } = this.sniff(bytes, fileName);
    let text: string;

    switch (ext) {
      case 'pdf': {
        const { default: pdfParse } = await import('pdf-parse');
        const parsed = await pdfParse(bytes);
        // pdf-parse's typings predate its export shape; normalize defensively.
        text = typeof parsed === 'string' ? parsed : (parsed?.text ?? '');
        break;
      }
      case 'docx': {
        const mammoth = await import('mammoth');
        const result = await mammoth.extractRawText({ buffer: bytes });
        text = result.value;
        break;
      }
      default:
        // A resume is often pasted with Windows newlines and smart quotes.
        text = bytes.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }

    // Normalize once, here, so every downstream stage (chunking, embedding,
    // reranking) sees the same text and vectors match what the user typed.
    const normalized = text
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const truncated = normalized.length > MAX_CHARS;

    // One line per upload, at log level: which extractor ran, how it was chosen,
    // and what came back. An empty result is the case worth reading the log for,
    // and without this line the caller only learns "400 Bad Request".
    this.log.log(
      `extract ${fileName}: ${ext} via ${by}, ${bytes.length} bytes in -> ` +
        `${normalized.length} chars out${truncated ? ` (truncated to ${MAX_CHARS})` : ''}`,
    );
    if (normalized.length === 0) {
      this.log.warn(
        `extract ${fileName}: ${ext} produced no text. A PDF with no text layer ` +
          `(a scan or an export of an image) needs OCR, which is not wired up.`,
      );
    }

    return {
      text: truncated ? normalized.slice(0, MAX_CHARS) : normalized,
      detected: ext,
      truncated,
      detectedBy: by,
    };
  }

  /**
   * Prefer the magic bytes over the extension: a .txt that is really a PDF is
   * common enough (wrong drag-and-drop) that trusting the name loses the text.
   *
   * `by` is reported so a wrong pick is diagnosable: magic-bytes means the bytes
   * decided it, extension means they were uninformative (plain text has no
   * signature).
   */
  private sniff(
    bytes: Buffer,
    fileName: string,
  ): { kind: DetectedKind; by: 'magic-bytes' | 'extension' | 'fallback' } {
    if (bytes.subarray(0, 5).toString('latin1') === '%PDF-')
      return { kind: 'pdf', by: 'magic-bytes' };
    // DOCX/XLSX/PPTX are zip archives: "PK\x03\x04".
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
      return extname(fileName).toLowerCase() === '.docx'
        ? { kind: 'docx', by: 'magic-bytes' }
        : { kind: 'text', by: 'fallback' };
    }
    if (bytes.subarray(0, 2).toString('latin1') === '{\\')
      return { kind: 'text', by: 'magic-bytes' };
    if (bytes.subarray(0, 2).toString('latin1') === 'PK')
      return { kind: 'docx', by: 'magic-bytes' };

    // No signature: plain text, markdown, or a file we do not understand. The
    // extension is all there is, so it decides.
    const ext = extname(fileName).toLowerCase();
    if (ext === '.pdf') return { kind: 'pdf', by: 'extension' };
    if (ext === '.docx') return { kind: 'docx', by: 'extension' };
    return { kind: 'text', by: 'extension' };
  }
}
