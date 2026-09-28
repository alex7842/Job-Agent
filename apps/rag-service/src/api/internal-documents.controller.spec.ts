import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DOCUMENT_STATUS, MAX_DOCUMENT_BYTES, TOPICS } from '@job-agent/shared';
import { InternalDocumentsController } from './internal-documents.controller.js';
import { relayedUploadHeaders } from './internal.schemas.js';
import { IngestionService } from '../ingestion/ingestion.service.js';
import { TextExtractor } from '../ingestion/text-extractor.service.js';
import { LocalObjectStore } from '../adapters/local.object-store.js';
import { MemoryVectorStore } from '../adapters/memory.vector-store.js';
import { OfflineEmbedding } from '../adapters/offline.embedding.js';
import type { DocumentRepository } from '../database/document.repository.js';
import type { KafkaPublisherService } from '../kafka/publisher.service.js';
import type { ObjectStore } from '../ports.js';

const PROFILE_A = '11111111-1111-4111-8111-111111111111';
const PROFILE_B = '22222222-2222-4222-8222-222222222222';
const DOC_ID = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';

/** Records what the controller asked it to store, and what it published. */
class StubRepository {
  readonly rows = new Map<string, Record<string, unknown>>();
  upserts: unknown[] = [];

  async upsert(input: { documentId: string } & Record<string, unknown>) {
    this.upserts.push(input);
    this.rows.set(input.documentId, { ...input, status: DOCUMENT_STATUS.UPLOADED });
    return this.rows.get(input.documentId);
  }

  async findById(documentId: string) {
    return this.rows.get(documentId) ?? null;
  }

  async updateStatus(
    documentId: string,
    status: string,
    errorMessage: string | null = null,
    chunkCount?: number,
  ) {
    const row = this.rows.get(documentId);
    if (!row) return;
    row.status = status;
    row.errorMessage = errorMessage;
    if (chunkCount !== undefined) row.chunkCount = chunkCount;
  }

  async setExtractedText(documentId: string, text: string | null) {
    const row = this.rows.get(documentId);
    if (row) row.extractedText = text;
  }

  async extractedTextFor() {
    return [];
  }

  async markDeleted(documentId: string) {
    const row = this.rows.get(documentId);
    if (row) row.status = DOCUMENT_STATUS.DELETED;
  }
}

class StubPublisher {
  readonly published: { topic: string; key: string; value: unknown }[] = [];
  async emit(topic: string, key: string, value: unknown) {
    this.published.push({ topic, key, value });
  }
}

/** Stands in for the presigner an S3 store would produce. */
class S3LikeObjectStore extends LocalObjectStore {
  presignCalls: { key: string; contentType: string; expiresIn: number }[] = [];
  override async presignPut(key: string, contentType: string, expiresIn: number) {
    this.presignCalls.push({ key, contentType, expiresIn });
    return `https://bucket.s3.example/${key}?sig=abc`;
  }
}

const config = (dir: string) =>
  ({
    get: (key: string, fallback?: unknown) =>
      key === 'LOCAL_STORAGE_DIR' ? dir : (fallback as string | undefined),
  }) as unknown as ConfigService;

describe('InternalDocumentsController', () => {
  let dir: string;
  let objects: S3LikeObjectStore;
  let repository: StubRepository;
  let publisher: StubPublisher;
  let controller: InternalDocumentsController;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rag-presign-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    objects = new S3LikeObjectStore(config(dir));
    repository = new StubRepository();
    publisher = new StubPublisher();
    const ingestion = new IngestionService(
      new OfflineEmbedding(),
      new MemoryVectorStore(),
      objects,
      new TextExtractor(),
      repository as unknown as DocumentRepository,
      config(dir),
    );
    controller = new InternalDocumentsController(
      objects as ObjectStore,
      repository as unknown as DocumentRepository,
      ingestion,
      publisher as unknown as KafkaPublisherService,
      config(dir),
    );
  });

  const body = {
    documentId: DOC_ID,
    profileId: PROFILE_A,
    userId: USER,
    kind: 'resume',
    fileName: 'resume.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    isPrimary: true,
  };

  // ---------- presign ----------

  it('registers the document and returns an s3 upload target', async () => {
    const result = await controller.presign(body);

    expect(result.mode).toBe('s3');
    expect(result.uploadUrl).toMatch(/^https:\/\/bucket\.s3\.example\//);
    expect(result.objectKey).toContain(PROFILE_A);
    expect(result.maxBytes).toBe(MAX_DOCUMENT_BYTES);
    expect(repository.upserts).toHaveLength(1);
  });

  it('signs the presign with the mime type the file will be sent as', async () => {
    await controller.presign(body);
    // A presigned PUT signed for one content type rejects a body sent with
    // another, so the caller's declared type has to be the signed one.
    expect(objects.presignCalls[0].contentType).toBe('application/pdf');
    expect(objects.presignCalls[0].expiresIn).toBe(900);
  });

  it('reports local mode with no upload URL rather than a fake one', async () => {
    // The filesystem store answers with its own scheme, which is not a URL.
    const localStore = new LocalObjectStore(config(dir));
    const local = new InternalDocumentsController(
      localStore,
      repository as unknown as DocumentRepository,
      new IngestionService(
        new OfflineEmbedding(),
        new MemoryVectorStore(),
        localStore,
        new TextExtractor(),
        repository as unknown as DocumentRepository,
        config(dir),
      ),
      publisher as unknown as KafkaPublisherService,
      config(dir),
    );

    const result = await local.presign(body);
    expect(result.mode).toBe('local');
    // Handed to a browser as-is, a `local://` string would be fetched as a host.
    expect(result.uploadUrl).toBeNull();
  });

  it('refuses a request that violates the store invariants', async () => {
    await expect(
      controller.presign({ ...body, sizeBytes: MAX_DOCUMENT_BYTES + 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.presign({ ...body, mimeType: 'application/x-msdownload' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ---------- relayed content ----------

  const request = (raw: Buffer, profileId?: string, declaredSize?: number) =>
    ({
      rawBody: raw,
      headers: {
        [relayedUploadHeaders.profileId.toLowerCase()]: profileId,
        [relayedUploadHeaders.sizeBytes.toLowerCase()]:
          declaredSize === undefined ? undefined : String(declaredSize),
      },
    }) as never;

  /** A text/plain document, since the content tests send real readable bytes. */
  const textBody = { ...body, fileName: 'resume.txt', mimeType: 'text/plain' };

  it('stores the bytes, indexes them and reports the outcome back', async () => {
    await controller.presign(textBody);
    const content = Buffer.from(
      'Senior backend engineer with Kubernetes and PostgreSQL experience.',
    );

    const result = await controller.putContent(
      request(content, PROFILE_A, content.length),
      DOC_ID,
      PROFILE_A,
      String(content.length),
    );

    expect(result.status).toBe(DOCUMENT_STATUS.READY);
    expect(result.indexed).toBeGreaterThan(0);
    // The catalog learns the outcome the same way it would after a direct
    // upload, so the UI does not depend on which mode was used.
    const event = publisher.published.find((m) => m.topic === TOPICS.DOC_INDEXED);
    expect(event?.value).toMatchObject({ documentId: DOC_ID, status: DOCUMENT_STATUS.READY });
  });

  it('publishes a failure instead of claiming success on unreadable bytes', async () => {
    await controller.presign(textBody);

    const result = await controller.putContent(
      request(Buffer.from('   \n  '), PROFILE_A, 6),
      DOC_ID,
      PROFILE_A,
      '6',
    );

    expect(result.status).toBe(DOCUMENT_STATUS.FAILED);
    const event = publisher.published.find((m) => m.topic === TOPICS.DOC_INDEXED);
    expect(event?.value).toMatchObject({ status: DOCUMENT_STATUS.FAILED });
  });

  it('rejects bytes that contradict the declared size', async () => {
    await controller.presign(textBody);
    await expect(
      controller.putContent(
        request(Buffer.from('short'), PROFILE_A, 9999),
        DOC_ID,
        PROFILE_A,
        '9999',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an oversized relayed body', async () => {
    await controller.presign(textBody);
    const huge = Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x61);
    await expect(
      controller.putContent(
        request(huge, PROFILE_A, huge.length),
        DOC_ID,
        PROFILE_A,
        String(huge.length),
      ),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it("will not accept another profile's document id", async () => {
    await controller.presign(textBody);
    const content = Buffer.from('resume text');
    await expect(
      controller.putContent(
        request(content, PROFILE_B, content.length),
        DOC_ID,
        PROFILE_B,
        String(content.length),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports an unknown document the same way as a forbidden one', async () => {
    await expect(
      controller.putContent(request(Buffer.from('x'), PROFILE_A, 1), DOC_ID, PROFILE_A, '1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects an empty body', async () => {
    await controller.presign(textBody);
    await expect(
      controller.putContent(request(Buffer.alloc(0), PROFILE_A, 0), DOC_ID, PROFILE_A, '0'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
