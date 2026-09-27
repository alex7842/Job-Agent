import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RawJob } from '../../common/types.js';
import { Profile } from '../../profile/profile.entity.js';
import { stripHtml } from '../pipeline/filters.js';
import { getJson, JobSource, searchQueries } from './job-source.interface.js';

interface JSearchResponse {
  data?: {
    job_id: string; job_title: string; employer_name: string;
    job_city?: string; job_state?: string; job_country?: string; job_is_remote?: boolean;
    job_apply_link: string; job_description?: string; job_posted_at_datetime_utc?: string;
    job_min_salary?: number; job_max_salary?: number; job_salary_currency?: string; job_publisher?: string;
  }[];
}

/** RapidAPI JSearch - aggregates Google for Jobs (LinkedIn, Indeed, Glassdoor, company pages...). */
@Injectable()
export class JSearchSource implements JobSource {
  readonly name = 'jsearch';
  constructor(private readonly config: ConfigService) {}

  isEnabled = () => !!this.config.get('RAPIDAPI_KEY');

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

      const res = await getJson<JSearchResponse>(`https://jsearch.p.rapidapi.com/search?${params}`, {
        'X-RapidAPI-Key': this.config.get<string>('RAPIDAPI_KEY')!,
        'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
      });

      for (const j of res.data ?? []) {
        const salary = j.job_min_salary
          ? `${j.job_min_salary}-${j.job_max_salary ?? ''} ${j.job_salary_currency ?? ''}`.trim()
          : undefined;
        out.push({
          externalId: j.job_id,
          title: j.job_title,
          company: j.employer_name,
          location: [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', ') || undefined,
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
