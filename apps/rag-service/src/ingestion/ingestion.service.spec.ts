import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { DOCUMENT_STATUS, type DocumentChangedEvent } from '@job-agent/shared';
import { IngestionService } from './ingestion.service.js';
import { TextExtractor } from './text-extractor.service.js';
import { MemoryVectorStore } from '../adapters/memory.vector-store.js';
import { LocalObjectStore } from '../adapters/local.object-store.js';
import { OfflineEmbedding } from '../adapters/offline.embedding.js';
import { namespaceFor } from '../ports.js';
import type { DocumentEntity } from '../database/document.entity.js';

/** The smallest object that satisfies what the service actually calls. */
class StubDocumentRepository {
  readonly rows = new Map<string, DocumentEntity>();

  async findById(documentId: string) {
    return this.rows.get(documentId) ?? null;
  }

  async findOwned(documentId: string, profileId: string) {
    const row = this.rows.get(documentId);
    return row && row.profileId === profileId ? row : null;
  }

  async updateStatus(
    documentId: string,
    status: DocumentEntity['status'],
    errorMessage: string | null = null,
    chunkCount?: number,
  ) {
    const row = this.rows.get(documentId);
    if (!row) return;
    row.status = status;
    row.errorMessage = errorMessage;
    if (chunkCount !== undefined) row.chunkCount = chunkCount;
  }

  async markDeleted(documentId: string) {
    const row = this.rows.get(documentId);
    if (row) row.status = DOCUMENT_STATUS.DELETED;
  }

  async setExtractedText(documentId: string, text: string | null) {
    const row = this.rows.get(documentId);
    if (row) row.extractedText = text;
  }

  async extractedTextFor(profileId: string, documentIds: string[]) {
    return documentIds
      .map((id) => this.rows.get(id))
      .filter((r): r is DocumentEntity => Boolean(r?.extractedText))
      .filter((r) => r.profileId === profileId && r.status === DOCUMENT_STATUS.READY)
      .map((r) => ({
        documentId: r.documentId,
        fileName: r.fileName,
        text: r.extractedText ?? '',
      }));
  }

  /** Mirrors the real upsert's observable effect. */
  add(event: DocumentChangedEvent) {
    this.rows.set(event.documentId, {
      documentId: event.documentId,
      profileId: event.profileId,
      userId: event.userId,
      kind: event.kind,
      fileName: event.fileName,
      mimeType: event.mimeType,
      sizeBytes: String(event.sizeBytes),
      objectKey: event.objectKey,
      status: DOCUMENT_STATUS.UPLOADED,
      isPrimary: event.isPrimary,
      chunkCount: 0,
      extractedText: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

const PROFILE_A = '11111111-1111-4111-8111-111111111111';
const PROFILE_B = '22222222-2222-4222-8222-222222222222';
const USER_A = '33333333-3333-4333-8333-333333333333';
const USER_B = '44444444-4444-4444-8444-444444444444';

const resumeText = `
Senior backend engineer with eight years of experience building distributed services.
Deep hands-on Kubernetes and PostgreSQL experience, including schema design and query tuning.
Fluent in TypeScript, Node.js and Go. Mentored four engineers and owned an on-call rotation.
`.trim();

const jobs = [
  {
    jobId: 'job-backend',
    title: 'Senior Backend Engineer',
    company: 'Acme',
    source: 'linkedin',
    text: 'Senior Backend Engineer. Build distributed services in Kubernetes and PostgreSQL. TypeScript and Node.js required. Eight years of experience with schema design and query tuning.',
  },
  {
    jobId: 'job-frontend',
    title: 'Frontend Engineer',
    company: 'Globex',
    source: 'linkedin',
    text: 'Frontend Engineer. Build user interfaces with React, CSS and browser performance tooling. Design systems and accessibility are a core part of the role.',
  },
  {
    jobId: 'job-data',
    title: 'Data Scientist',
    company: 'Initech',
    source: 'indeed',
    text: 'Data Scientist. Statistical modelling, Python and machine learning. Build forecasting pipelines and run experiments to improve business decisions.',
  },
];

describe('IngestionService (offline providers, no credentials)', () => {
  let dir: string;
  let objects: LocalObjectStore;
  let vectors: MemoryVectorStore;
  let documents: StubDocumentRepository;
  let service: IngestionService;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rag-test-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const config = {
      get: (_key: string, fallback?: unknown) => fallback,
    } as unknown as ConfigService;
    objects = new LocalObjectStore({
      ...config,
      get: (k: string, f?: unknown) => (k === 'LOCAL_STORAGE_DIR' ? dir : f),
    } as unknown as ConfigService);
    vectors = new MemoryVectorStore();
    documents = new StubDocumentRepository();
    service = new IngestionService(
      new OfflineEmbedding(),
      vectors,
      objects,
      new TextExtractor(),
      documents as never,
      config,
    );
  });

  it('indexes a document and marks it ready with a chunk count', async () => {
    const key = 'documents/pa/resume.txt';
    await objects.put(key, Buffer.from(resumeText), 'text/plain');
    documents.add({
      documentId: 'd1',
      profileId: PROFILE_A,
      userId: USER_A,
      objectKey: key,
      fileName: 'resume.txt',
      mimeType: 'text/plain',
      kind: 'resume',
      sizeBytes: resumeText.length,
      isPrimary: true,
      etag: null,
    });

    const result = await service.ingestDocument('d1');
    expect(result.status).toBe(DOCUMENT_STATUS.READY);
    expect(result.indexed).toBeGreaterThan(0);
    expect(documents.rows.get('d1')?.chunkCount).toBe(result.indexed);
    expect(documents.rows.get('d1')?.errorMessage).toBeNull();
  });

  it('fails a document with no extractable text instead of marking it ready', async () => {
    const key = 'documents/pa/empty.txt';
    await objects.put(key, Buffer.from('   \n\n  '), 'text/plain');
    documents.add({
      documentId: 'd2',
      profileId: PROFILE_A,
      userId: USER_A,
      objectKey: key,
      fileName: 'empty.txt',
      mimeType: 'text/plain',
      kind: 'other',
      sizeBytes: 6,
      isPrimary: false,
      etag: null,
    });

    const result = await service.ingestDocument('d2');
    expect(result.status).toBe(DOCUMENT_STATUS.FAILED);
    expect(documents.rows.get('d2')?.errorMessage).toMatch(/no extractable text/i);
  });

  it('records a failure reason when the object is missing', async () => {
    documents.add({
      documentId: 'd3',
      profileId: PROFILE_A,
      userId: USER_A,
      objectKey: 'documents/pa/gone.txt',
      fileName: 'gone.txt',
      mimeType: 'text/plain',
      kind: 'other',
      sizeBytes: 10,
      isPrimary: false,
      etag: null,
    });

    const result = await service.ingestDocument('d3');
    expect(result.status).toBe(DOCUMENT_STATUS.FAILED);
    expect(result.errorMessage).toBeTruthy();
  });

  it('rejects a document that belongs to a different profile', async () => {
    documents.add({
      documentId: 'd4',
      profileId: PROFILE_A,
      userId: USER_A,
      objectKey: 'documents/pa/x.txt',
      fileName: 'x.txt',
      mimeType: 'text/plain',
      kind: 'other',
      sizeBytes: 10,
      isPrimary: false,
      etag: null,
    });

    expect(await service.deleteDocument('d4', PROFILE_B)).toBe(false);
    expect(documents.rows.get('d4')?.status).toBe(DOCUMENT_STATUS.UPLOADED);
  });

  it('skips jobs with too little text to embed', async () => {
    const result = await service.ingestJobs(PROFILE_A, USER_A, [
      { jobId: 'tiny', text: 'short' },
      { jobId: 'real', text: jobs[0].text },
    ]);
    expect(result.skipped).toBe(1);
    expect(result.indexed).toBeGreaterThan(0);
  });

  it('ranks the semantically closest job first', async () => {
    await service.ingestJobs(PROFILE_A, USER_A, jobs);

    const response = await service.search({
      profileId: PROFILE_A,
      userId: USER_A,
      queryText: 'Kubernetes and PostgreSQL distributed services in TypeScript',
    });

    expect(response.hits.length).toBeGreaterThan(0);
    expect(response.hits[0].jobId).toBe('job-backend');
    expect(response.hits[0].score).toBeGreaterThan(0);
  });

  it('scores reflect real similarity, not RRF rank position', async () => {
    await service.ingestJobs(PROFILE_A, USER_A, jobs);

    const response = await service.search({
      profileId: PROFILE_A,
      userId: USER_A,
      queryText: 'Kubernetes and PostgreSQL distributed services',
    });

    // RRF scores are 1/(60+rank) and therefore nearly flat. Reporting them as
    // match strength would show ~0.98 even for a job that barely matched, so
    // score must track similarity instead and separate the hits clearly.
    const backend = response.hits.find((h) => h.jobId === 'job-backend');
    const frontend = response.hits.find((h) => h.jobId === 'job-frontend');
    expect(backend!.score).toBeGreaterThan(frontend!.score * 2);
    for (const hit of response.hits) {
      expect(hit.score).toBeGreaterThanOrEqual(0);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
  });

  it('exposes a snippet and the job fields needed to render a result', async () => {
    await service.ingestJobs(PROFILE_A, USER_A, jobs);
    const { hits } = await service.search({
      profileId: PROFILE_A,
      userId: USER_A,
      queryText: jobs[1].text,
    });

    const frontend = hits.find((h) => h.jobId === 'job-frontend');
    expect(frontend).toBeDefined();
    expect(frontend?.title).toBe('Frontend Engineer');
    expect(frontend?.company).toBe('Globex');
    expect(frontend?.source).toBe('linkedin');
    expect(frontend?.snippet).toBeTruthy();
  });

  it("never returns another profile's jobs", async () => {
    await service.ingestJobs(PROFILE_A, USER_A, jobs);

    const response = await service.search({
      profileId: PROFILE_B,
      userId: USER_B,
      queryText: 'Kubernetes',
    });
    expect(response.hits).toHaveLength(0);
  });

  it('restricts results to a single run when asked', async () => {
    await service.ingestJobs(PROFILE_A, USER_A, [
      { ...jobs[0], runId: 'run-1' },
      { ...jobs[1], runId: 'run-2' },
    ]);

    const response = await service.search({
      profileId: PROFILE_A,
      userId: USER_A,
      queryText: 'engineer building services',
      runId: 'run-2',
    });

    expect(response.hits.every((h) => ['job-frontend', 'job-data'].includes(h.jobId))).toBe(true);
  });

  it('honours topK', async () => {
    await service.ingestJobs(PROFILE_A, USER_A, jobs);
    const response = await service.search({
      profileId: PROFILE_A,
      userId: USER_A,
      queryText: 'engineer',
      topK: 1,
    });
    expect(response.hits).toHaveLength(1);
  });

  it('fuses several role queries into one deduplicated result list', async () => {
    await service.ingestJobs(PROFILE_A, USER_A, jobs);

    const response = await service.search({
      profileId: PROFILE_A,
      userId: USER_A,
      queryText: 'distributed backend services',
      roleQueries: ['React frontend interfaces', 'statistical machine learning modelling'],
    });

    // Every query retrieves most of the corpus, so fusing on object identity
    // instead of jobId would return one row per (query, hit) pair. The invariant
    // is that the merged list holds each job at most once.
    const ids = response.hits.map((h) => h.jobId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('job-backend');
    expect(ids).toContain('job-data');
  });

  it('averages similarity across exactly the queries that surfaced a job', async () => {
    await service.ingestJobs(PROFILE_A, USER_A, jobs);
    const q1 = 'Kubernetes PostgreSQL distributed services';
    const q2 = 'Python machine learning modelling pipelines';

    // Similarity is only comparable within a single query, so the expected value
    // for the fused run is the mean of the two single-query runs.
    const first = await service.search({ profileId: PROFILE_A, userId: USER_A, queryText: q1 });
    const second = await service.search({ profileId: PROFILE_A, userId: USER_A, queryText: q2 });
    const fused = await service.search({
      profileId: PROFILE_A,
      userId: USER_A,
      queryText: q1,
      roleQueries: [q2],
    });

    for (const jobId of ['job-backend', 'job-data', 'job-frontend']) {
      const a = first.hits.find((h) => h.jobId === jobId)?.similarity;
      const b = second.hits.find((h) => h.jobId === jobId)?.similarity;
      const merged = fused.hits.find((h) => h.jobId === jobId)?.similarity;

      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(merged).toBeCloseTo(((a! + b!) / 2) as number, 6);
    }
  });

  it('reports score as the best similarity among the matching queries', async () => {
    await service.ingestJobs(PROFILE_A, USER_A, jobs);
    const q1 = 'Kubernetes PostgreSQL distributed services';
    const q2 = 'Python machine learning modelling pipelines';

    const fused = await service.search({
      profileId: PROFILE_A,
      userId: USER_A,
      queryText: q1,
      roleQueries: [q2],
    });
    for (const hit of fused.hits) {
      // score is the strongest single piece of evidence; similarity the average.
      expect(hit.score).toBeGreaterThanOrEqual(hit.similarity);
    }
  });

  it('marks the response degraded when running on fallback adapters', async () => {
    const response = await service.search({
      profileId: PROFILE_A,
      userId: USER_A,
      queryText: 'anything',
    });
    expect(response.degraded).toBe(true);
    expect(response.embeddingModel).toBe('offline-hashed-bow');
    expect(response.vectorStore).toBe('memory');
  });

  it("removes a document's vectors on delete", async () => {
    const key = 'documents/pa/resume.txt';
    await objects.put(key, Buffer.from(resumeText), 'text/plain');
    documents.add({
      documentId: 'd5',
      profileId: PROFILE_A,
      userId: USER_A,
      objectKey: key,
      fileName: 'resume.txt',
      mimeType: 'text/plain',
      kind: 'resume',
      sizeBytes: resumeText.length,
      isPrimary: false,
      etag: null,
    });
    await service.ingestDocument('d5');
    expect(vectors.sizeOf(namespaceFor(PROFILE_A))).toBeGreaterThan(0);

    expect(await service.deleteDocument('d5', PROFILE_A)).toBe(true);
    expect(vectors.sizeOf(namespaceFor(PROFILE_A))).toBe(0);
    expect(documents.rows.get('d5')?.status).toBe(DOCUMENT_STATUS.DELETED);
  });

  it('re-indexing a document does not leave stale duplicate chunks', async () => {
    const key = 'documents/pa/resume.txt';
    await objects.put(key, Buffer.from(resumeText), 'text/plain');
    documents.add({
      documentId: 'd6',
      profileId: PROFILE_A,
      userId: USER_A,
      objectKey: key,
      fileName: 'resume.txt',
      mimeType: 'text/plain',
      kind: 'resume',
      sizeBytes: resumeText.length,
      isPrimary: false,
      etag: null,
    });

    await service.ingestDocument('d6');
    const afterFirst = vectors.sizeOf(namespaceFor(PROFILE_A));
    await service.ingestDocument('d6');
    const afterSecond = vectors.sizeOf(namespaceFor(PROFILE_A));

    expect(afterSecond).toBe(afterFirst);
  });

  it('reports adapter identity and health for the readiness probe', async () => {
    const health = await service.health();
    expect(health).toMatchObject({
      degraded: true,
      vectorStore: { name: 'memory' },
      objectStore: { name: 'local' },
    });
  });

  // ---------- searching with the user's own documents ----------

  /** Uploads and indexes a document, so its text is available as a query source. */
  async function indexDocument(documentId: string, text: string, fileName = 'resume.txt') {
    const key = `documents/pa/${documentId}-${fileName}`;
    await objects.put(key, Buffer.from(text), 'text/plain');
    documents.add({
      documentId,
      profileId: PROFILE_A,
      userId: USER_A,
      objectKey: key,
      fileName,
      mimeType: 'text/plain',
      kind: 'resume',
      sizeBytes: text.length,
      isPrimary: true,
      etag: null,
    });
    await service.ingestDocument(documentId);
  }

  it('searches using an uploaded document with no query text at all', async () => {
    await service.ingestJobs(PROFILE_A, USER_A, jobs);
    await indexDocument('doc-a', resumeText);

    // The caller only knows the document's id: the text was extracted at index
    // time and must be reused, not asked for again.
    const response = await service.search({
      profileId: PROFILE_A,
      userId: USER_A,
      documentIds: ['doc-a'],
    });

    expect(response.hits.length).toBeGreaterThan(0);
    expect(response.hits[0].jobId).toBe('job-backend');
  });

  it('ignores a document that is not ready', async () => {
    await service.ingestJobs(PROFILE_A, USER_A, jobs);

    // Registered but never ingested: no extracted text, so it cannot be a query.
    documents.add({
      documentId: 'doc-pending',
      profileId: PROFILE_A,
      userId: USER_A,
      objectKey: 'documents/pa/pending.txt',
      fileName: 'pending.txt',
      mimeType: 'text/plain',
      kind: 'resume',
      sizeBytes: 10,
      isPrimary: false,
      etag: null,
    });

    const response = await service.search({
      profileId: PROFILE_A,
      userId: USER_A,
      documentIds: ['doc-pending'],
    });
    expect(response.hits).toHaveLength(0);
  });

  it("never uses another profile's document as a query", async () => {
    await service.ingestJobs(PROFILE_A, USER_A, jobs);
    await indexDocument('doc-a', resumeText);

    // Document text must be as isolated as the vectors: reading it would leak one
    // user's resume into another user's search.
    const response = await service.search({
      profileId: PROFILE_B,
      userId: USER_B,
      documentIds: ['doc-a'],
    });
    expect(response.hits).toHaveLength(0);
  });

  it('returns no hits when there is nothing to search with', async () => {
    await service.ingestJobs(PROFILE_A, USER_A, jobs);
    const response = await service.search({ profileId: PROFILE_A, userId: USER_A });
    expect(response.hits).toHaveLength(0);
  });
});
