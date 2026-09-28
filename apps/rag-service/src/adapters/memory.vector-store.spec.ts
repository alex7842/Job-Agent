import { describe, expect, it } from 'vitest';
import { MemoryVectorStore, cosine, matchesFilter } from './memory.vector-store.js';
import { namespaceFor, vectorId } from '../ports.js';
import { VectorKind } from '@job-agent/shared';
import type { VectorRecord } from '@job-agent/shared';

const record = (
  id: string,
  values: number[],
  metadata: Record<string, unknown> = {},
): VectorRecord => ({
  id,
  values,
  metadata: {
    kind: VectorKind.JOB,
    profileId: 'p1',
    userId: 'u1',
    text: 'text',
    ...metadata,
  } as VectorRecord['metadata'],
});

describe('cosine', () => {
  it('is 1 for identical vectors and 0 for orthogonal ones', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('is unaffected by magnitude, since vectors are normalized upstream', () => {
    expect(cosine([1, 1], [10, 10])).toBeCloseTo(1);
  });

  it('returns 0 rather than NaN for a zero vector', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe('matchesFilter', () => {
  it('matches plain equality', () => {
    expect(matchesFilter({ kind: 'job' }, { kind: 'job' })).toBe(true);
    expect(matchesFilter({ kind: 'job' }, { kind: 'document' })).toBe(false);
  });

  it('supports $in, $eq and $ne', () => {
    expect(matchesFilter({ kind: 'job' }, { kind: { $in: ['job', 'document'] } })).toBe(true);
    expect(matchesFilter({ kind: 'job' }, { kind: { $in: ['document'] } })).toBe(false);
    expect(matchesFilter({ runId: 'r1' }, { runId: { $eq: 'r1' } })).toBe(true);
    expect(matchesFilter({ runId: 'r1' }, { runId: { $ne: 'r2' } })).toBe(true);
    expect(matchesFilter({ runId: 'r1' }, { runId: { $ne: 'r1' } })).toBe(false);
  });

  it('accepts an array shorthand for $in', () => {
    expect(matchesFilter({ kind: 'job' }, { kind: ['job'] })).toBe(true);
    expect(matchesFilter({ kind: 'job' }, { kind: ['document'] })).toBe(false);
  });

  it('requires every key to match', () => {
    expect(matchesFilter({ kind: 'job', profileId: 'p1' }, { kind: 'job', profileId: 'p1' })).toBe(
      true,
    );
    expect(matchesFilter({ kind: 'job', profileId: 'p1' }, { kind: 'job', profileId: 'p2' })).toBe(
      false,
    );
  });

  it('treats an unknown operator as no match, so a typo cannot widen a filter', () => {
    // Returning true here would silently turn a scoped query into a full one.
    expect(matchesFilter({ kind: 'job' }, { kind: { $regex: '.*' } })).toBe(false);
  });
});

describe('MemoryVectorStore', () => {
  const ns = namespaceFor('p1');

  it('returns nothing for an unknown or empty namespace', async () => {
    const store = new MemoryVectorStore();
    expect(await store.query(ns, [1, 0], { topK: 5 })).toEqual([]);
    await store.upsert('other', [record('a', [1, 0])]);
    expect(await store.query(ns, [1, 0], { topK: 5 })).toEqual([]);
  });

  it('ranks by descending similarity and honours topK', async () => {
    const store = new MemoryVectorStore();
    await store.upsert(ns, [
      record('exact', [1, 0]),
      record('close', [0.9, 0.1]),
      record('orthogonal', [0, 1]),
    ]);

    const all = await store.query(ns, [1, 0], { topK: 3 });
    expect(all.map((m) => m.id)).toEqual(['exact', 'close', 'orthogonal']);
    expect(all[0].score).toBeGreaterThan(all[1].score);

    const limited = await store.query(ns, [1, 0], { topK: 1 });
    expect(limited).toHaveLength(1);
  });

  it('applies the filter before ranking', async () => {
    const store = new MemoryVectorStore();
    await store.upsert(ns, [
      record('job', [1, 0], { kind: VectorKind.JOB }),
      record('doc', [1, 0], { kind: VectorKind.DOCUMENT }),
    ]);

    const jobsOnly = await store.query(ns, [1, 0], { topK: 10, filter: { kind: VectorKind.JOB } });
    expect(jobsOnly.map((m) => m.id)).toEqual(['job']);
  });

  it('keeps namespaces isolated', async () => {
    const store = new MemoryVectorStore();
    await store.upsert(ns, [record('a', [1, 0])]);
    await store.upsert(namespaceFor('p2'), [record('b', [1, 0])]);

    expect((await store.query(ns, [1, 0], { topK: 5 })).map((m) => m.id)).toEqual(['a']);
    expect((await store.query(namespaceFor('p2'), [1, 0], { topK: 5 })).map((m) => m.id)).toEqual([
      'b',
    ]);
  });

  it('overwrites in place on a repeated upsert of the same id', async () => {
    const store = new MemoryVectorStore();
    const id = vectorId(VectorKind.DOCUMENT, 'doc1', 0);
    await store.upsert(ns, [record(id, [1, 0], { text: 'first' })]);
    await store.upsert(ns, [record(id, [0, 1], { text: 'second' })]);
    expect(store.sizeOf(ns)).toBe(1);
  });

  it('lists and deletes by id so a re-index can drop only what it replaced', async () => {
    const store = new MemoryVectorStore();
    await store.upsert(ns, [
      record(vectorId(VectorKind.DOCUMENT, 'doc1', 0), [1, 0]),
      record(vectorId(VectorKind.DOCUMENT, 'doc1', 1), [0, 1]),
      record(vectorId(VectorKind.DOCUMENT, 'doc2', 0), [1, 1]),
    ]);

    const doc1 = [
      vectorId(VectorKind.DOCUMENT, 'doc1', 0),
      vectorId(VectorKind.DOCUMENT, 'doc1', 1),
    ];
    expect((await store.listIds(ns, `${VectorKind.DOCUMENT}:doc1:`)).sort()).toEqual(doc1.sort());

    // Simulates a re-index that produced one chunk instead of two: keep 0, drop 1.
    await store.deleteByIds(ns, [vectorId(VectorKind.DOCUMENT, 'doc1', 1)]);
    expect(await store.listIds(ns, `${VectorKind.DOCUMENT}:doc1:`)).toEqual([
      vectorId(VectorKind.DOCUMENT, 'doc1', 0),
    ]);
    expect(store.sizeOf(ns)).toBe(2);
  });

  it('deletes by prefix and by namespace', async () => {
    const store = new MemoryVectorStore();
    await store.upsert(ns, [
      record(vectorId(VectorKind.DOCUMENT, 'doc1', 0), [1, 0]),
      record(vectorId(VectorKind.JOB, 'job1', 0), [0, 1]),
    ]);

    await store.deleteByPrefix(ns, `${VectorKind.DOCUMENT}:`);
    expect(store.sizeOf(ns)).toBe(1);

    await store.deleteNamespace(ns);
    expect(store.sizeOf(ns)).toBe(0);
  });

  it('treats deletes of absent ids as a no-op, so re-delivery is harmless', async () => {
    const store = new MemoryVectorStore();
    await store.upsert(ns, [record('a', [1, 0])]);
    await expect(store.deleteByIds(ns, ['nope'])).resolves.toBeUndefined();
    await expect(store.deleteByIds(namespaceFor('ghost'), ['nope'])).resolves.toBeUndefined();
    expect(store.sizeOf(ns)).toBe(1);
  });

  it('refuses vectors of a different dimension once a store is populated', async () => {
    // A model change mid-process would otherwise silently corrupt every
    // similarity score after the first one.
    const store = new MemoryVectorStore();
    await store.upsert(ns, [record('a', [1, 0, 0])]);
    await expect(store.upsert(ns, [record('b', [1, 0])])).rejects.toThrow(/dimension changed/i);
  });

  it('adopts the dimension of the first vector it sees', async () => {
    const store = new MemoryVectorStore();
    await store.upsert(ns, [record('a', [1, 0, 0, 0])]);
    await expect(store.upsert(ns, [record('b', [1, 0, 0, 0])])).resolves.toBeUndefined();
  });
});
