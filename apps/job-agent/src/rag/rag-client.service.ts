import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  INTERNAL_TOKEN_HEADER,
  MIN_INTERNAL_SECRET_LENGTH,
  internalToken,
} from '@job-agent/shared/internal-auth';
import type {
  IngestDocumentsResult,
  PresignDocumentResponse,
  SearchResponse,
} from '@job-agent/shared';

/** Extra headers the relayed-upload endpoint needs to verify what it received. */
const RELAY_HEADERS = {
  profileId: 'x-rag-profile-id',
  sizeBytes: 'x-rag-size-bytes',
} as const;

type CallOptions = {
  body?: unknown;
  /** A file body, for the relayed-upload path. */
  raw?: Buffer;
  contentType?: string;
  headers?: Record<string, string>;
};

/**
 * The job agent's client for the RAG service.
 *
 * Every call is signed with the shared secret, using the same helper the RAG
 * service's guard verifies with (both import it from @job-agent/shared), so the
 * two sides cannot drift apart.
 *
 * The service is optional. `enabled` is false when no usable secret is
 * configured, and every method then returns null instead of throwing: retrieval
 * is an enhancement, and a job agent that cannot reach the RAG service must
 * still crawl, score and list jobs. Failing the whole API because an optional
 * subsystem is down would be strictly worse than a missing semantic score.
 */
@Injectable()
export class RagClientService {
  private readonly log = new Logger(RagClientService.name);
  private readonly baseUrl: string;
  private readonly secret: string | null;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = (config.get<string>('RAG_SERVICE_URL') ?? 'http://localhost:3001').replace(
      /\/+$/,
      '',
    );
    const secret = config.get<string>('RAG_INTERNAL_SECRET') ?? null;
    // An unset or short secret means "not configured", not "misconfigured":
    // there is no call this service could legitimately make.
    this.secret = secret && secret.length >= MIN_INTERNAL_SECRET_LENGTH ? secret : null;
    this.timeoutMs = Number(config.get<string>('RAG_REQUEST_TIMEOUT_MS')) || 15_000;

    if (!this.secret) {
      this.log.warn(
        `RAG_SERVICE_URL is ${this.baseUrl}, but RAG_INTERNAL_SECRET is missing or under ` +
          `${MIN_INTERNAL_SECRET_LENGTH} characters: document indexing and semantic search are DISABLED.`,
      );
    }
  }

  get enabled(): boolean {
    return this.secret !== null;
  }

  /** One signed call. Returns null on any failure; every caller treats RAG as optional. */
  private async call<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    options: CallOptions = {},
  ): Promise<T | null> {
    if (!this.secret) return null;

    const headers: Record<string, string> = {
      [INTERNAL_TOKEN_HEADER]: internalToken(this.secret, method, path),
      ...options.headers,
    };

    let body: BodyInit | undefined;
    if (options.raw) {
      // Copied into a fresh Uint8Array: Buffer's ArrayBufferLike generic does not
      // satisfy fetch's BodyInit under this TypeScript version.
      body = Uint8Array.from(options.raw);
      headers['content-type'] = options.contentType ?? 'application/octet-stream';
      headers['content-length'] = String(options.raw.length);
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['content-type'] = options.contentType ?? 'application/json';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      // `body` is omitted entirely for a method without one: fetch rejects a body
      // on GET, and the health probe is the only GET.
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        this.log.warn(`${method} ${path} -> ${res.status} ${detail.slice(0, 300)}`);
        return null;
      }
      if (res.status === 204) return null;
      return (await res.json()) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`${method} ${path} failed: ${message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Rank indexed jobs against a query built from the candidate's documents. */
  search(body: unknown): Promise<SearchResponse | null> {
    return this.call<SearchResponse>('POST', '/internal/search', { body });
  }

  /** Where to send a document's bytes. Also registers the document on that side. */
  presignUpload(body: unknown): Promise<PresignDocumentResponse | null> {
    return this.call<PresignDocumentResponse>('POST', '/internal/documents/presign', { body });
  }

  /**
   * Relay a document's bytes in local mode, where there is no bucket to presign
   * against. The RAG service stores and indexes them in one step.
   */
  putContent(
    documentId: string,
    profileId: string,
    content: Buffer,
    contentType: string,
  ): Promise<IngestDocumentsResult | null> {
    return this.call<IngestDocumentsResult>('PUT', `/internal/documents/${documentId}/content`, {
      raw: content,
      contentType,
      // The declared size is advisory; the RAG service compares it with the bytes
      // that actually arrived and rejects a mismatch.
      headers: {
        [RELAY_HEADERS.profileId]: profileId,
        [RELAY_HEADERS.sizeBytes]: String(content.length),
      },
    });
  }

  /** Re-run extraction and embedding for a document that already has an object. */
  ingestDocument(documentId: string, profileId: string): Promise<IngestDocumentsResult | null> {
    return this.call<IngestDocumentsResult>('POST', '/internal/documents/ingest', {
      body: { documentId, profileId },
    });
  }

  /** Drop a document's vectors. */
  deleteDocument(documentId: string, profileId: string): Promise<{ deleted: boolean } | null> {
    return this.call<{ deleted: boolean }>('POST', '/internal/documents/delete', {
      body: { documentId, profileId },
    });
  }

  health(): Promise<Record<string, unknown> | null> {
    return this.call<Record<string, unknown>>('GET', '/health');
  }
}
