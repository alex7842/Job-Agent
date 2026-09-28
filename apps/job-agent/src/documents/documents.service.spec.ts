import { describe, expect, it } from 'vitest';
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TOPICS, type DocumentIndexedEvent } from '@job-agent/shared';
import { DocumentsService } from './documents.service.js';
import { Document } from './entities/document.entity.js';
import type { RagClientService } from '../rag/rag-client.service.js';
import type { KafkaProducerService } from '../kafka/kafka-producer.service.js';

const PROFILE_A = '11111111-1111-4111-8111-111111111111';
const PROFILE_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

const OWNER = { id: USER, profileId: PROFILE_A };
const OTHER = { id: '44444444-4444-4444-8444-444444444444', profileId: PROFILE_B };

/**
 * An in-memory stand-in that enforces the same partial unique index the
 * migration creates: at most one primary document per profile. Reproducing the
 * constraint is the point — a catalog that only works because the test store is
 * lenient would fail the first time two primaries raced in production.
 */
class FakeRepository {
  readonly rows = new Map<string, Document>();
  saves = 0;
  private sequence = 0;

  create(input: Partial<Document>) {
    return {
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'awaiting_upload',
      chunkCount: 0,
      errorMessage: null,
      ...input,
      id: input.id ?? `doc-${++this.sequence}`,
    } as Document;
  }

  async save(row: Document) {
    this.saves += 1;
    const existing = [...this.rows.values()].filter(
      (r) => r.profileId === row.profileId && r.isPrimary && r.id !== row.id,
    );
    if (row.isPrimary && existing.length > 0) {
      throw new Error('duplicate key value violates unique constraint "uq_documents_primary"');
    }
    this.rows.set(row.id, row);
    return row;
  }

  async update(criteria: string | Partial<Document>, patch: Partial<Document>) {
    // TypeORM also accepts a bare id as the first argument, and the service uses
    // that form for its single-row updates.
    const matches = (row: Document) =>
      typeof criteria === 'string' ? row.id === criteria : matchesWhere(row, criteria);
    for (const [id, row] of this.rows) {
      if (!matches(row)) continue;
      // Replaced rather than mutated: TypeORM's update() runs a query and leaves
      // any entity the caller already holds untouched, and code that reads a
      // field after updating it would behave differently here than in production.
      this.rows.set(id, { ...row, ...patch, updatedAt: new Date() });
    }
  }

  async find(options: { where: Partial<Document>; order?: Record<string, 'ASC' | 'DESC'> }) {
    const rows = [...this.rows.values()].filter((row) => matchesWhere(row, options.where));
    const [column, direction] = Object.entries(options.order ?? {})[0] ?? [];
    if (column) {
      rows.sort((a, b) =>
        direction === 'DESC'
          ? String(b[column as keyof Document]).localeCompare(String(a[column as keyof Document]))
          : String(a[column as keyof Document]).localeCompare(String(b[column as keyof Document])),
      );
    }
    return rows;
  }

  async findOne(options: { where: Partial<Document>; order?: Record<string, 'ASC' | 'DESC'> }) {
    return (await this.find(options))[0] ?? null;
  }

  async findOneBy(where: Partial<Document>) {
    return (await this.find({ where }))[0] ?? null;
  }

  async count(options: { where: Partial<Document> }) {
    return (await this.find(options)).length;
  }
}

/**
 * A where-clause match, including the `Not()` / `In()` find operators the
 * service uses. Skipping them would make the fake quietly return more rows than
 * Postgres would, and the scoping tests would pass for the wrong reason.
 */
function matchesWhere(row: Document, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    const actual = row[key as keyof Document];
    const operator = value as { type?: string; value?: unknown };
    if (operator && typeof operator === 'object' && 'type' in operator) {
      if (operator.type === 'not') return actual !== operator.value;
      if (operator.type === 'in') return (operator.value as unknown[]).includes(actual);
      if (operator.type === 'isNull') return actual === null;
      return true;
    }
    if (Array.isArray(value)) return value.includes(actual);
    if (actual instanceof Date && value instanceof Date)
      return actual.getTime() === value.getTime();
    return actual === value;
  });
}

class FakeRag {
  enabled = true;
  presignCalls: unknown[] = [];
  ingestResult: unknown = { status: 'ready', indexed: 3, errorMessage: null };
  putResult: unknown = { status: 'ready', indexed: 4, errorMessage: null };

  async presignUpload(input: Record<string, unknown>) {
    this.presignCalls.push(input);
    return {
      objectKey: `documents/${input.profileId}/${input.fileName}`,
      mode: 'local',
      uploadUrl: null,
      expiresInSeconds: 900,
      maxBytes: 10_485_760,
    };
  }

  async putContent() {
    return this.putResult;
  }

  async ingestDocument() {
    return this.ingestResult;
  }
}

class FakeProducer {
  readonly emitted: { topic: string; key: string; value: unknown }[] = [];
  async emit(topic: string, key: string, value: unknown) {
    this.emitted.push({ topic, key, value });
  }
}

function build() {
  const repository = new FakeRepository();
  const rag = new FakeRag();
  const producer = new FakeProducer();
  const service = new DocumentsService(
    repository as never,
    rag as unknown as RagClientService,
    producer as unknown as KafkaProducerService,
  );
  return { repository, rag, producer, service };
}

const upload = {
  fileName: 'resume.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  kind: 'resume',
} as const;

describe('DocumentsService', () => {
  // ---------- creation ----------

  it('refuses a file type it cannot extract before asking for an upload target', async () => {
    const { service, rag } = build();
    // No presign is issued, so there is no URL to hand to a browser for a file
    // the pipeline would only reject later.
    await expect(
      service.create(OWNER, {
        ...upload,
        fileName: 'payload.exe',
        mimeType: 'application/x-msdownload',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rag.presignCalls).toHaveLength(0);
  });

  it('refuses an oversized file', async () => {
    const { service } = build();
    await expect(
      service.create(OWNER, { ...upload, sizeBytes: 50 * 1024 * 1024 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns a local-mode upload path and no URL when there is no bucket', async () => {
    const { service } = build();
    const result = await service.create(OWNER, upload);
    // A `local://` string in uploadUrl would be fetched by a browser as a host.
    expect(result.mode).toBe('local');
    expect(result.uploadUrl).toBeNull();
    expect(result.uploadPath).toBe(`/documents/${result.document.id}/content`);
  });

  it('explains itself when the search service is not configured', async () => {
    const { service, rag } = build();
    rag.enabled = false;
    await expect(service.create(OWNER, upload)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  // ---------- the single primary ----------

  it('demotes the previous primary before storing the new one', async () => {
    const { service, repository } = build();
    const first = await service.create(OWNER, { ...upload, isPrimary: true });
    const second = await service.create(OWNER, { ...upload, fileName: 'cv.pdf', isPrimary: true });

    // The unique index permits one primary per profile, so the old row has to be
    // demoted first: saving the new one first would be rejected outright.
    expect(repository.saves).toBe(2);
    const primaries = [...repository.rows.values()].filter((r) => r.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].id).toBe(second.document.id);
    expect(first.document.isPrimary).toBe(true);
  });

  it('leaves the primary alone when the new document is not one', async () => {
    const { service, repository } = build();
    await service.create(OWNER, { ...upload, isPrimary: true });
    await service.create(OWNER, { ...upload, fileName: 'notes.txt', isPrimary: false });

    expect([...repository.rows.values()].filter((r) => r.isPrimary)).toHaveLength(1);
  });

  it('promotes another ready document when the primary is deleted', async () => {
    const { service, repository } = build();
    const primary = await service.create(OWNER, { ...upload, isPrimary: true });
    const other = await service.create(OWNER, { ...upload, fileName: 'cv.pdf' });
    await repository.update(other.document.id, { status: 'ready' });

    await service.remove(OWNER, primary.document.id);

    // A search still needs a query source after the resume is gone.
    expect(repository.rows.get(other.document.id)?.isPrimary).toBe(true);
    expect(repository.rows.get(primary.document.id)?.status).toBe('deleted');
  });

  // ---------- ownership ----------

  it('does not find another profile’s document', async () => {
    const { service } = build();
    const created = await service.create(OWNER, upload);
    // 404 rather than 403: the existence of another profile's ids is not ours
    // to disclose.
    await expect(service.reindex(OTHER, created.document.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('only lists its own profile’s documents', async () => {
    const { service } = build();
    await service.create(OWNER, upload);
    await service.create(OTHER, upload);

    // The list is scoped by profile, not by owner id: two profiles can share a
    // user, and one profile's uploads must never surface under another.
    expect(await service.list(OWNER)).toHaveLength(1);
    expect(await service.list(OTHER)).toHaveLength(1);
  });

  it('omits deleted documents from the search sources', async () => {
    const { service } = build();
    const created = await service.create(OWNER, { ...upload, isPrimary: true });
    await repository_status(service, created.document.id);
    const ready = await service.readyForSearch(PROFILE_A);
    expect(ready.documentIds).toEqual([created.document.id]);
    expect(ready.primaryId).toBe(created.document.id);
  });

  // ---------- lifecycle ----------

  it('asks the RAG service to index once the bytes are in the bucket', async () => {
    const { service, producer, repository } = build();
    const created = await service.create(OWNER, upload);
    await repository.update(created.document.id, { status: 'awaiting_upload' });
    const record = await service.complete(OWNER, created.document.id);

    expect(producer.emitted[0].topic).toBe(TOPICS.DOC_CHANGED);
    expect(record.status).toBe('indexing');
  });

  it('relays local-mode bytes and marks the row indexing', async () => {
    const { service, repository } = build();
    const created = await service.create(OWNER, upload);
    const record = await service.uploadContent(OWNER, created.document.id, Buffer.from('resume'));

    expect(record.status).toBe('indexing');
    expect(repository.rows.get(created.document.id)?.status).toBe('indexing');
  });

  it('marks a failed relay rather than leaving the row claiming an upload', async () => {
    const { service, rag, repository } = build();
    const created = await service.create(OWNER, upload);
    rag.putResult = null;

    await expect(
      service.uploadContent(OWNER, created.document.id, Buffer.from('resume')),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(repository.rows.get(created.document.id)?.status).toBe('failed');
  });

  it('refuses a reindex before the file exists', async () => {
    const { service } = build();
    const created = await service.create(OWNER, upload);
    await expect(service.reindex(OWNER, created.document.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  // ---------- inbound status ----------

  it('applies an indexing report to its own document', async () => {
    const { service, repository } = build();
    const created = await service.create(OWNER, upload);
    const event: DocumentIndexedEvent = {
      documentId: created.document.id,
      profileId: PROFILE_A,
      status: 'ready',
      chunkCount: 12,
      errorMessage: null,
    };

    await service.applyIndexStatus(event);
    const row = repository.rows.get(created.document.id);
    expect(row?.status).toBe('ready');
    expect(row?.chunkCount).toBe(12);
  });

  it('ignores a report for a document that belongs to someone else', async () => {
    const { service, repository } = build();
    const created = await service.create(OWNER, upload);

    // A forged or misrouted event must not be able to mark a document ready.
    await service.applyIndexStatus({
      documentId: created.document.id,
      profileId: PROFILE_B,
      status: 'ready',
      chunkCount: 99,
      errorMessage: null,
    });
    expect(repository.rows.get(created.document.id)?.status).not.toBe('ready');
  });

  it('ignores a report for a document the user has already deleted', async () => {
    const { service, repository } = build();
    const created = await service.create(OWNER, upload);
    await service.remove(OWNER, created.document.id);

    await service.applyIndexStatus({
      documentId: created.document.id,
      profileId: PROFILE_A,
      status: 'ready',
      chunkCount: 5,
      errorMessage: null,
    });
    // Late indexing of deleted bytes must not resurrect the row.
    expect(repository.rows.get(created.document.id)?.status).toBe('deleted');
  });
});

/** Marks a document ready, the way the RAG service's report would. */
async function repository_status(service: DocumentsService, documentId: string) {
  await service.applyIndexStatus({
    documentId,
    profileId: PROFILE_A,
    status: 'ready',
    chunkCount: 3,
    errorMessage: null,
  });
}
