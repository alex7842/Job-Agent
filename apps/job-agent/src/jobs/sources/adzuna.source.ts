import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RawJob } from '@job-agent/shared';
import { Profile } from '../../profile/profile.entity.js';
import { stripHtml } from '../pipeline/filters.js';
import {
  broadenings,
  getJson,
  isCredentialFailure,
  JobSource,
  searchQueries,
} from './job-source.interface.js';

interface AdzunaResponse {
  /** Total matches available, not the size of this page. */
  count?: number;
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

/**
 * Same self-disabling behaviour as JSearch: Adzuna rejects a wrong app_id/app_key
 * pair with 401/403 on every call, so the source switches itself off instead of
 * failing the run for a credential that will never start working.
 */
@Injectable()
export class AdzunaSource implements JobSource {
  readonly name = 'adzuna';
  private readonly log = new Logger(AdzunaSource.name);
  private rejected = false;
  constructor(private readonly config: ConfigService) {}

  isEnabled = () =>
    !this.rejected && !!this.config.get('ADZUNA_APP_ID') && !!this.config.get('ADZUNA_APP_KEY');

  async fetch(profile: Profile): Promise<RawJob[]> {
    const prefs = profile.preferences;
    const country = this.config.get<string>('ADZUNA_COUNTRY', 'in');
    const out: RawJob[] = [];

    for (const { role, where } of searchQueries(prefs)) {
      // Narrowest form first; a form that matches is taken and we stop paying for
      // the looser ones. A query that matches nothing all the way down is a real
      // "no jobs", and says so in the log.
      let matched = false;
      for (const form of broadenings(role, where)) {
        const params = new URLSearchParams({
          app_id: this.config.get<string>('ADZUNA_APP_ID')!,
          app_key: this.config.get<string>('ADZUNA_APP_KEY')!,
          results_per_page: '50',
          what: prefs.remoteOnly ? `${form.role} remote` : form.role,
          max_days_old: String(prefs.postedWithinDays),
          sort_by: 'date',
        });
        if (form.where) params.set('where', form.where);

        let res: AdzunaResponse;
        try {
          res = await getJson<AdzunaResponse>(
            `https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params}`,
          );
        } catch (error) {
          if (!isCredentialFailure(error)) throw error;
          this.rejected = true;
          this.log.warn(
            `disabling adzuna: ${(error as Error).message}. Check ADZUNA_APP_ID and ` +
              `ADZUNA_APP_KEY. This run continues with the other sources.`,
          );
          return out;
        }
        const results = res.results ?? [];
        this.log.log(
          `query what="${params.get('what')}"${form.where ? ` where="${form.where}"` : ''} ` +
            `days=${prefs.postedWithinDays} -> ${res.count ?? results.length} available, ` +
            `${results.length} returned`,
        );

        for (const j of results) {
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

        if (results.length > 0) {
          matched = true;
          break;
        }
      }

      if (!matched) {
        this.log.warn(
          `no results for role "${role}"${where ? ` in "${where}"` : ''}, even with the ` +
            `location dropped — widen the role or clear the location on the profile`,
        );
      }
    }
    return out;
  }
}
