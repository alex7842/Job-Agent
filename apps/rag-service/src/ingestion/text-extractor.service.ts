import { Injectable, Logger } from '@nestjs/common';
import { extname } from 'node:path';

export interface ExtractedDocument {
  text: string;
  /** Chosen by sniffing, because browsers lie about content types. */
  detected: 'pdf' | 'docx' | 'text';
  truncated: boolean;
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
    const ext = this.sniff(bytes, fileName);
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
    return {
      text: truncated ? normalized.slice(0, MAX_CHARS) : normalized,
      detected: ext,
      truncated,
    };
  }

  /**
   * Prefer the magic bytes over the extension: a .txt that is really a PDF is
   * common enough (wrong drag-and-drop) that trusting the name loses the text.
   */
  private sniff(bytes: Buffer, fileName: string): 'pdf' | 'docx' | 'text' {
    if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
    // DOCX/XLSX/PPTX are zip archives: "PK\x03\x04".
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
      return extname(fileName).toLowerCase() === '.docx' ? 'docx' : 'text';
    }
    if (bytes.subarray(0, 2).toString('latin1') === '{\\') return 'text';
    if (bytes.subarray(0, 2).toString('latin1') === 'PK') return 'docx';

    const ext = extname(fileName).toLowerCase();
    if (ext === '.pdf') return 'pdf';
    if (ext === '.docx') return 'docx';
    return 'text';
  }
}
