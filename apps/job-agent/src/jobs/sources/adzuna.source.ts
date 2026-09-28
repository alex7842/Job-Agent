import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RawJob } from '@job-agent/shared';
import { Profile } from '../../profile/profile.entity.js';
import { stripHtml } from '../pipeline/filters.js';
import { getJson, JobSource, searchQueries } from './job-source.interface.js';

interface AdzunaResponse {
  results?: {
    id: string;
    title: string;
    description?: string;
    created?: string;
    redirect_url: string;
    company?: { display_name?: string };
    location?: { display_name?: string };
    salary_min?: number;
    salary_max?: number;
  }[];
}

@Injectable()
export class AdzunaSource implements JobSource {
  readonly name = 'adzuna';
  constructor(private readonly config: ConfigService) {}

  isEnabled = () => !!this.config.get('ADZUNA_APP_ID') && !!this.config.get('ADZUNA_APP_KEY');

  async fetch(profile: Profile): Promise<RawJob[]> {
    const prefs = profile.preferences;
    const country = this.config.get<string>('ADZUNA_COUNTRY', 'in');
    const out: RawJob[] = [];

    for (const { role, where } of searchQueries(prefs)) {
      const params = new URLSearchParams({
        app_id: this.config.get<string>('ADZUNA_APP_ID')!,
        app_key: this.config.get<string>('ADZUNA_APP_KEY')!,
        results_per_page: '50',
        what: prefs.remoteOnly ? `${role} remote` : role,
        max_days_old: String(prefs.postedWithinDays),
        sort_by: 'date',
      });
      if (where) params.set('where', where);

      const res = await getJson<AdzunaResponse>(
        `https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params}`,
      );
      for (const j of res.results ?? []) {
        out.push({
          externalId: String(j.id),
          title: j.title,
          company: j.company?.display_name ?? 'Unknown',
          location: j.location?.display_name,
          salaryText: j.salary_min
            ? `${Math.round(j.salary_min)}-${Math.round(j.salary_max ?? j.salary_min)}`
            : undefined,
          description: stripHtml(j.description),
          applyUrl: j.redirect_url,
          postedAt: j.created,
        });
      }
    }
    return out;
  }
}
