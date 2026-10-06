import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RawJob } from '@job-agent/shared';
import { Profile } from '../../profile/profile.entity.js';
import { stripHtml } from '../pipeline/filters.js';
import { getJson, isCredentialFailure, JobSource, searchQueries } from './job-source.interface.js';

interface JSearchResponse {
  data?: {
    job_id: string;
    job_title: string;
    employer_name: string;
    job_city?: string;
    job_state?: string;
    job_country?: string;
    job_is_remote?: boolean;
    job_apply_link: string;
    job_description?: string;
    job_posted_at_datetime_utc?: string;
    job_min_salary?: number;
    job_max_salary?: number;
    job_salary_currency?: string;
    job_publisher?: string;
  }[];
}

/**
 * RapidAPI JSearch - aggregates Google for Jobs (LinkedIn, Indeed, Glassdoor,
 * company pages...).
 *
 * A key is not enough to enable this source: RapidAPI keys are per-API, and one
 * that has not subscribed to JSearch answers 403 "You are not subscribed to this
 * API" forever. That used to fail the whole workflow, Temporal retried it three
 * times, and the run produced nothing even though the other three sources were
 * fine. So a 401/403 disables the source for the life of the process and the
 * run carries on without it.
 */
@Injectable()
export class JSearchSource implements JobSource {
  readonly name = 'jsearch';
  private readonly log = new Logger(JSearchSource.name);
  private rejected = false;

  constructor(private readonly config: ConfigService) {}

  isEnabled = () => !this.rejected && !!this.config.get('RAPIDAPI_KEY');

  async fetch(profile: Profile): Promise<RawJob[]> {
    const prefs = profile.preferences;
    const days = prefs.postedWithinDays;
    const datePosted = days <= 1 ? 'today' : days <= 3 ? '3days' : days <= 7 ? 'week' : 'month';
    const out: RawJob[] = [];

    for (const { role, where } of searchQueries(prefs)) {
      const params = new URLSearchParams({
        query: where ? `${role} in ${where}` : role,
        page: '1',
        num_pages: '1',
        date_posted: datePosted,
      });
      if (prefs.remoteOnly) params.set('remote_jobs_only', 'true');

      let res: JSearchResponse;
      try {
        // `/search`, not `/estimated-salary`. The two share a host and a key but
        // nothing else: the salary endpoint takes `job_title` + `location` for one
        // named role and answers "Missing job_title parameter" to a search query,
        // which is a 400 Temporal will retry three times before failing the run.
        res = await getJson<JSearchResponse>(`https://jsearch27.p.rapidapi.com/search?${params}`, {
          'X-RapidAPI-Key': this.config.get<string>('RAPIDAPI_KEY')!,
          'X-RapidAPI-Host': 'jsearch27.p.rapidapi.com',
        });
      } catch (error) {
        if (!isCredentialFailure(error)) throw error;
        this.rejected = true;
        this.log.warn(
          `disabling jsearch: ${(error as Error).message}. RapidAPI keys are per-API — ` +
            `subscribe to JSearch at https://rapidapi.com/letscrape-6bRBa3/search-jobs ` +
            `or clear RAPIDAPI_KEY. This run continues with the other sources.`,
        );
        // Jobs already collected from earlier queries are still worth publishing.
        return out;
      }

      for (const j of res.data ?? []) {
        const salary = j.job_min_salary
          ? `${j.job_min_salary}-${j.job_max_salary ?? ''} ${j.job_salary_currency ?? ''}`.trim()
          : undefined;
        out.push({
          externalId: j.job_id,
          title: j.job_title,
          company: j.employer_name,
          location:
            [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', ') || undefined,
          remote: j.job_is_remote,
          salaryText: salary,
          description: stripHtml(j.job_description),
          applyUrl: j.job_apply_link,
          postedAt: j.job_posted_at_datetime_utc,
        });
      }
    }
    return out;
  }
}
