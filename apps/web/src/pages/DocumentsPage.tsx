import { useRef, useState } from 'react';
import { DOCUMENT_KINDS, type DocumentKind, type DocumentRecord } from '@job-agent/shared';
import {
  useDeleteDocument,
  useDocuments,
  useRankAllSemantically,
  useReindexDocument,
  useSemanticStatus,
  useUploadDocument,
} from '@/lib/queries';
import { formatBytes, formatDate } from '@/lib/format';
import { Badge, EmptyState, ErrorNote, Spinner, cx } from '@/components/ui';

const KIND_LABEL: Record<DocumentKind, string> = {
  resume: 'Resume',
  cover_letter: 'Cover letter',
  other: 'Other',
};

/**
 * The status shown, with the reason when there is one. A failed index is the
 * most useful thing on this page — a file that silently never became searchable
 * would look identical to one that simply had nothing to say.
 */
function statusBadge(doc: DocumentRecord) {
  switch (doc.status) {
    case 'ready':
      return (
        <Badge
          className="bg-emerald-500/10 text-emerald-300 ring-emerald-500/30"
          title={`${doc.chunkCount} chunks indexed`}
        >
          indexed · {doc.chunkCount} chunks
        </Badge>
      );
    case 'indexing':
      return <Badge className="bg-sky-500/10 text-sky-300 ring-sky-500/30">indexing…</Badge>;
    case 'awaiting_upload':
      return (
        <Badge className="bg-neutral-500/10 text-neutral-400 ring-neutral-600/40">
          awaiting upload
        </Badge>
      );
    case 'failed':
      return (
        <Badge
          className="bg-rose-500/10 text-rose-300 ring-rose-500/30"
          title={doc.errorMessage ?? undefined}
        >
          failed
        </Badge>
      );
    default:
      return null;
  }
}

export function DocumentsPage() {
  const { data, isPending, isError, error } = useDocuments();
  const { data: semantic } = useSemanticStatus();
  const upload = useUploadDocument();
  const reindex = useReindexDocument();
  const remove = useDeleteDocument();
  const rankAll = useRankAllSemantically();

  const fileInput = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<DocumentKind>('resume');
  const [isPrimary, setIsPrimary] = useState(true);

  async function onPick(file: File | undefined) {
    if (!file) return;
    try {
      await upload.mutateAsync({ file, kind, isPrimary });
    } finally {
      // Cleared so re-picking the same file fires change again.
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-neutral-800 p-4">
        <h1 className="text-sm font-semibold text-neutral-100">Documents</h1>
        <p className="mt-1 text-xs text-neutral-500">
          Your resume is what semantic search compares postings against. PDF, DOCX, TXT or MD, up to
          10&nbsp;MB.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as DocumentKind)}
            className="h-9 rounded-lg border border-neutral-800 bg-neutral-900 px-2 text-sm text-neutral-200 outline-none focus:border-neutral-600"
          >
            {DOCUMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-1.5 text-xs text-neutral-400">
            <input
              type="checkbox"
              checked={isPrimary}
              onChange={(e) => setIsPrimary(e.target.checked)}
              className="size-3.5 accent-neutral-500"
            />
            use as the primary resume
          </label>

          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.docx,.txt,.md"
            onChange={(e) => void onPick(e.target.files?.[0])}
            className="text-xs text-neutral-400 file:mr-2 file:rounded-md file:border-0 file:bg-neutral-800 file:px-2.5 file:py-1.5 file:text-xs file:text-neutral-200 hover:file:bg-neutral-700"
          />

          {upload.isPending ? <Spinner label="Uploading" /> : null}
        </div>

        {upload.isError ? (
          <div className="mt-3">
            <ErrorNote error={upload.error} />
          </div>
        ) : null}
        {remove.isError ? (
          <div className="mt-3">
            <ErrorNote error={remove.error} />
          </div>
        ) : null}
        {reindex.isError ? (
          <div className="mt-3">
            <ErrorNote error={reindex.error} />
          </div>
        ) : null}
      </section>

      {semantic?.enabled === false ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
          Semantic search is not configured on the server, so uploaded documents will be stored but
          not indexed. Set <code className="font-mono">RAG_SERVICE_URL</code> and{' '}
          <code className="font-mono">RAG_INTERNAL_SECRET</code> to enable it.
        </p>
      ) : null}

      {semantic?.degraded ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
          Running on the <strong>{semantic.embeddingModel}</strong> fallback, so matches are lexical
          rather than semantic. Configure a real embedding provider for meaningful results.
        </p>
      ) : null}

      {isError ? <ErrorNote error={error} /> : null}
      {isPending ? <Spinner label="Loading documents" /> : null}

      {data && data.length === 0 ? (
        <EmptyState
          title="No documents yet."
          hint="Upload your resume above and it will be indexed for semantic search."
        />
      ) : null}

      {data && data.length > 0 ? (
        <ul className="divide-y divide-neutral-900 overflow-hidden rounded-xl border border-neutral-800">
          {data.map((doc) => (
            <li key={doc.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-neutral-100">
                  {doc.fileName}
                  {doc.isPrimary ? (
                    <span className="ml-2 text-xs text-neutral-500">primary</span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {KIND_LABEL[doc.kind]} · {formatBytes(doc.sizeBytes)} · added{' '}
                  {formatDate(doc.createdAt)}
                </p>
                {doc.status === 'failed' && doc.errorMessage ? (
                  <p className="mt-1 text-xs text-rose-300">{doc.errorMessage}</p>
                ) : null}
              </div>

              {statusBadge(doc)}

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={reindex.isPending || doc.status === 'awaiting_upload'}
                  onClick={() => reindex.mutate(doc.id)}
                  className="rounded-md border border-neutral-800 px-2 py-1 text-xs text-neutral-300 transition hover:border-neutral-700 disabled:opacity-40"
                >
                  Reindex
                </button>
                <button
                  type="button"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(doc.id)}
                  className="rounded-md border border-neutral-800 px-2 py-1 text-xs text-neutral-400 transition hover:border-rose-500/40 hover:text-rose-300 disabled:opacity-40"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <section
        className={cx(
          'flex flex-wrap items-center gap-3 rounded-xl border border-neutral-800 px-4 py-3',
          semantic?.enabled === false && 'opacity-50',
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="text-xs text-neutral-300">Re-score every job against your documents</p>
          <p className="mt-0.5 text-xs text-neutral-500">
            Worth doing after changing your resume or the roles you want.
          </p>
        </div>
        <button
          type="button"
          disabled={rankAll.isPending || semantic?.enabled === false}
          onClick={() => rankAll.mutate()}
          className="rounded-md bg-neutral-800 px-3 py-1.5 text-xs text-neutral-100 transition hover:bg-neutral-700 disabled:opacity-40"
        >
          {rankAll.isPending ? 'Ranking…' : 'Re-rank all jobs'}
        </button>
        {rankAll.isSuccess ? (
          <span className="text-xs text-neutral-500">
            {rankAll.data.ranked} ranked
            {rankAll.data.skipped > 0 ? `, ${rankAll.data.skipped} skipped` : ''}
          </span>
        ) : null}
      </section>
    </div>
  );
}
