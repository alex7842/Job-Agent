import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  JobStatus,
  MAX_QUERY_CHARS,
  type SearchHit,
  type SearchRequest,
  type SemanticRankResult,
} from '@job-agent/shared';
import { Job } from '../jobs/entities/job.entity.js';
import { ProfileService } from '../profile/profile.service.js';
import { RagClientService } from '../rag/rag-client.service.js';

/** How long to wait for a run's postings to reach the database before ranking. */
const POLL_INTERVAL_MS = 1_000;
const DEFAULT_DRAIN_WAIT_MS = 45_000;

/** The widest search the API allows; "re-rank everything" has to use all of it. */
const RANK_ALL_TOP_K = 200;

/** Retries when a run has postings but the vector store returns nothing. */
const EMPTY_SEARCH_ATTEMPTS = 3;
const DEFAULT_EMPTY_SEARCH_BACKOFF_MS = 2_000;

/**
 * Writes the semantic score onto a job.
 *
 * `semanticScore` is kept separate from the LLM's `matchScore` on purpose. The
 * LLM is the considered verdict on whether a human should apply; the vector
 * score is a cheap lexical-adjacent signal computed against the resume. They
 * disagree often and informatively — a high vector score with a low LLM score is
 * usually a keyword match in a job the human would not want. Averaging them into
 * one number would destroy exactly the information the user needs.
 */
@Injectable()
export class SemanticMatchService {
  private readonly log = new Logger(SemanticMatchService.name);
  private readonly topK: number;
  private readonly drainWaitMs: number;
  private readonly emptySearchBackoffMs: number;

  constructor(
    @InjectRepository(Job) private readonly jobs: Repository<Job>,
    private readonly rag: RagClientService,
    private readonly profiles: ProfileService,
    private readonly config: ConfigService,
  ) {
    this.topK = Number(config.get<string>('RAG_SEARCH_TOP_K')) || 20;
    this.drainWaitMs = Number(config.get<string>('RAG_DRAIN_WAIT_MS')) || DEFAULT_DRAIN_WAIT_MS;
    this.emptySearchBackoffMs =
      Number(config.get<string>('RAG_EMPTY_SEARCH_RETRY_MS')) || DEFAULT_EMPTY_SEARCH_BACKOFF_MS;
  }

  /**
   * Rank a run's postings against the candidate's profile.
   *
   * Called at the end of a search run, once the postings are in the vector store.
   * Jobs with no score are only the ones that failed to index or rank, so this is
   * safe to retry and a later run fills in whatever was missed.
   */
  async rankRun(runId: string, profileId: string): Promise<SemanticRankResult> {
    if (!this.rag.enabled) {
      return { ranked: 0, skipped: 0, degraded: false, embeddingModel: null, vectorStore: null };
    }

    // A run's postings reach the database through Kafka, which is asynchronous:
    // the sources have finished fetching but the pipeline may not have inserted
    // or indexed them yet. Ranking too early would report "no matches" for a run
    // that actually had some, so wait for the pipeline to settle — best effort,
    // because a stuck pipeline must not hold the workflow open.
    const settled = await this.waitForPipeline(runId, profileId);
    if (!settled) {
      this.log.warn(`Run ${runId}: postings were still arriving; ranking what is indexed so far`);
    }

    const sources = await this.querySources(profileId);
    const response = sources
      ? await this.searchWithRetry(
          {
            profileId,
            userId: await this.userIdFor(profileId),
            ...sources,
            runId,
            topK: this.topK,
          },
          () => this.jobs.count({ where: { runId, profileId } }),
        )
      : null;

    if (!response) {
      const pending = await this.jobs.count({
        where: { runId, profileId, semanticScore: IsNull() },
      });
      return {
        ranked: 0,
        skipped: pending,
        degraded: false,
        embeddingModel: null,
        vectorStore: null,
      };
    }

    const applied = await this.applyHits(response.hits, profileId, runId);
    const pending = await this.jobs.count({
      where: { runId, profileId, semanticScore: IsNull(), status: JobStatus.NEW },
    });

    return {
      ranked: applied.ranked,
      skipped: pending,
      degraded: response.degraded,
      embeddingModel: response.embeddingModel,
      vectorStore: response.vectorStore,
    };
  }

  /** Re-rank every job the user has, for after a resume change. */
  async rankAll(profileId: string): Promise<SemanticRankResult> {
    if (!this.rag.enabled) {
      return { ranked: 0, skipped: 0, degraded: false, embeddingModel: null, vectorStore: null };
    }

    const sources = await this.querySources(profileId);
    const response = sources
      ? await this.rag.search({
          profileId,
          userId: await this.userIdFor(profileId),
          ...sources,
          // Not this.topK: the user asked for every job to be re-scored, and the
          // default 20 would quietly leave the rest on their old scores.
          topK: RANK_ALL_TOP_K,
        })
      : null;
    if (!response) {
      const pending = await this.jobs.count({
        where: { profileId, semanticScore: IsNull() },
      });
      return {
        ranked: 0,
        skipped: pending,
        degraded: false,
        embeddingModel: null,
        vectorStore: null,
      };
    }

    const applied = await this.applyHits(response.hits, profileId);
    return {
      ...applied,
      degraded: response.degraded,
      embeddingModel: response.embeddingModel,
      vectorStore: response.vectorStore,
    };
  }

  /**
   * Search, retrying while the result is empty for a run that has postings.
   *
   * A run's rows reaching the database and their vectors reaching the vector
   * store are two independent Kafka consumers, so "every posting is scored" does
   * not mean "every posting is indexed". Ranking in the gap would report no
   * matches for a run that has them, and the scores would stay wrong until
   * something else happened to rerank. Retried only when there is a reason to
   * believe the vectors are merely late, so a genuine no-match is not held up.
   */
  private async searchWithRetry(
    request: SearchRequest & { topK: number; runId?: string },
    expectedHits: () => Promise<number>,
  ) {
    let last = null;
    for (let attempt = 0; attempt < EMPTY_SEARCH_ATTEMPTS; attempt++) {
      last = await this.rag.search(request);
      if (!last) return last; // the service is down; retrying changes nothing
      if (last.hits.length > 0 || (await expectedHits()) === 0) return last;
      this.log.warn(
        `No hits for run ${request.runId} although it has ${await expectedHits()} postings; ` +
          `vectors may still be indexing (attempt ${attempt + 1}/${EMPTY_SEARCH_ATTEMPTS})`,
      );
      if (attempt < EMPTY_SEARCH_ATTEMPTS - 1) await sleep(this.emptySearchBackoffMs);
    }
    return last;
  }

  /**
   * Persist the hits.
   *
   * Each hit is matched back to a job row *within the profile* rather than by id
   * alone, so a vector that somehow references another user's job updates
   * nothing instead of writing to a row it does not own.
   */
  private async applyHits(
    hits: SearchHit[],
    profileId: string,
    runId?: string,
  ): Promise<{ ranked: number; skipped: number }> {
    let ranked = 0;

    for (const [index, hit] of hits.entries()) {
      const where = runId ? { id: hit.jobId, profileId, runId } : { id: hit.jobId, profileId };
      const result = await this.jobs.update(where, {
        semanticScore: hit.score,
        semanticSnippet: hit.snippet,
        // 1-based, matching how the vector store's ranking is usually read.
        semanticRank: index + 1,
        semanticAt: new Date(),
      });
      if (result.affected) ranked += 1;
    }

    return { ranked, skipped: 0 };
  }

  /**
   * What to search with, taken entirely from the profile.
   *
   * The resume text is the candidate's own statement of what they have done, and
   * the wanted roles are what they are looking for; one query per role keeps each
   * one focused, because a single query built from a whole resume is an average
   * vector that matches everything weakly.
   *
   * Null when the profile has nothing to search with: the RAG service requires at
   * least one source and answers 400 otherwise, which would otherwise be
   * indistinguishable from the service being unavailable.
   */
  private async querySources(
    profileId: string,
  ): Promise<{ queryText?: string; roleQueries: string[] } | null> {
    const profile = await this.profiles.getById(profileId);

    const roleQueries = (profile.preferences.roles ?? []).map((r) => String(r)).slice(0, 5);
    const skills = (profile.preferences.skills ?? []).map((s) => String(s)).slice(0, 10);

    // The resume is a query source in its own right, and is the only one available
    // to a user who never filled in their preferences by hand.
    const queryText = [profile.resumeText, skills.join(', ')]
      .filter((t) => t?.trim())
      .join('\n')
      .trim();

    if (!queryText && roleQueries.length === 0) {
      this.log.warn(
        `Profile ${profileId} has no resume and no wanted roles; ` +
          `skipping semantic ranking until it does`,
      );
      return null;
    }

    return {
      ...(queryText ? { queryText: queryText.slice(0, MAX_QUERY_CHARS) } : {}),
      roleQueries,
    };
  }

  private async userIdFor(profileId: string): Promise<string> {
    const profile = await this.profiles.getById(profileId);
    // A profile predating auth has no owner; the RAG service stores the userId
    // with its vectors, so it needs a real value.
    return profile.userId ?? '00000000-0000-0000-0000-000000000000';
  }

  /**
   * Wait until the run's postings have stopped arriving.
   *
   * "Settled" means the count stopped growing across two consecutive polls and
   * every found job has been LLM-scored. Both halves matter: the count alone
   * settles while the last few messages are still being processed.
   */
  private async waitForPipeline(runId: string, profileId: string): Promise<boolean> {
    const deadline = Date.now() + this.drainWaitMs;
    let previous = -1;
    let stablePolls = 0;

    while (Date.now() < deadline) {
      const total = await this.jobs.count({ where: { runId, profileId } });
      const unscored = await this.jobs.count({
        where: { runId, profileId, scoredAt: IsNull() },
      });

      // A run that found nothing settles immediately rather than blocking for the
      // whole timeout: a stable zero is as settled as a stable non-zero.
      if (unscored === 0 && total === previous) {
        stablePolls += 1;
        if (stablePolls >= 1) return true;
      } else {
        stablePolls = 0;
      }
      previous = total;
      await sleep(POLL_INTERVAL_MS);
    }
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
