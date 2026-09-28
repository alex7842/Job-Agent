import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentKind, JobStatus, QueryJobs, UpdateProfileInput } from '@job-agent/shared';
import { api } from './api';

/**
 * TanStack Query is the single source of truth for server state. The job score
 * changes asynchronously (the Kafka `jobs.new` -> LLM step lands seconds later),
 * so job queries poll until scoring settles instead of being refetched by hand.
 */

export const qk = {
  jobs: (params: QueryJobs) => ['jobs', params] as const,
  job: (id: string) => ['job', id] as const,
  runs: () => ['runs'] as const,
  profile: () => ['profile'] as const,
  documents: () => ['documents'] as const,
  semanticStatus: () => ['semantic-status'] as const,
};

/** Documents list + semantic ranking + the profile, invalidated together. */
const invalidateRetrieval = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['documents'] });
  void qc.invalidateQueries({ queryKey: ['semantic-status'] });
  void qc.invalidateQueries({ queryKey: ['jobs'] });
  void qc.invalidateQueries({ queryKey: ['job'] });
};

export function useJobs(params: QueryJobs) {
  return useQuery({
    queryKey: qk.jobs(params),
    queryFn: () => api.listJobs(params),
    // The list endpoint does not expose scoreError, so a null score is the
    // only reliable "the pipeline has not finished with this row yet" signal.
    refetchInterval: (query) => {
      const items = query.state.data?.items;
      return items?.some((j) => j.matchScore === null) ? 3_000 : false;
    },
    placeholderData: (prev) => prev,
  });
}

export function useJob(id: string) {
  return useQuery({
    queryKey: qk.job(id),
    queryFn: () => api.getJob(id),
    refetchInterval: (query) => (query.state.data?.scoredAt == null ? 3_000 : false),
  });
}

export function useSetJobStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: JobStatus }) => api.setJobStatus(id, status),
    // Optimistic: the dashboard buttons feel instant, and a failure rolls back.
    onMutate: async ({ id, status }) => {
      await qc.cancelQueries({ queryKey: qk.job(id) });
      const previous = qc.getQueryData(qk.job(id));
      qc.setQueryData(qk.job(id), (old: unknown) =>
        old && typeof old === 'object' && 'status' in old ? { ...old, status } : old,
      );
      return { previous };
    },
    onError: (_err, { id }, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.job(id), ctx.previous);
    },
    onSettled: (_data, _error, { id }) => {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: qk.job(id) });
    },
  });
}

export function useRescoreJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.rescoreJob(id),
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({ queryKey: qk.job(id) });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

export function useRuns() {
  return useQuery({
    queryKey: qk.runs(),
    queryFn: () => api.listRuns(),
    // A running search takes minutes; keep the run list fresh while it works.
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.status === 'running') ? 4_000 : false,
  });
}

export function useTriggerRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.triggerRun(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.runs() });
    },
  });
}

export function useProfile() {
  return useQuery({ queryKey: qk.profile(), queryFn: () => api.getProfile() });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateProfileInput) => api.updateProfile(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.profile() });
    },
  });
}

// ---------- documents & semantic search ----------

/**
 * Polls while something is still being indexed.
 *
 * Indexing happens over Kafka after the upload returns, so the status shown
 * straight after an upload is always stale. Polling only while a row is
 * undecided keeps the page live exactly when it is changing and idle otherwise.
 */
export function useDocuments() {
  return useQuery({
    queryKey: qk.documents(),
    queryFn: () => api.listDocuments(),
    refetchInterval: (query) => {
      const docs = query.state.data;
      return docs?.some((d) => d.status === 'awaiting_upload' || d.status === 'indexing')
        ? 3_000
        : false;
    },
  });
}

export function useSemanticStatus() {
  return useQuery({ queryKey: qk.semanticStatus(), queryFn: () => api.semanticStatus() });
}

export function useUploadDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      file,
      kind,
      isPrimary,
    }: {
      file: File;
      kind: DocumentKind;
      isPrimary: boolean;
    }) => api.uploadDocument(file, kind, isPrimary),
    onSuccess: () => invalidateRetrieval(qc),
  });
}

export function useReindexDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.reindexDocument(id),
    onSuccess: () => invalidateRetrieval(qc),
  });
}

export function useDeleteDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteDocument(id),
    onSuccess: () => invalidateRetrieval(qc),
  });
}

export function useRankRunSemantically() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.rankRunSemantically(runId),
    onSuccess: () => invalidateRetrieval(qc),
  });
}

export function useRankAllSemantically() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.rankAllSemantically(),
    onSuccess: () => invalidateRetrieval(qc),
  });
}
