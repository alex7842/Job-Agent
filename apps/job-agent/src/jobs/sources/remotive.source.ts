import { Injectable } from '@nestjs/common';
import { RawJob } from '@job-agent/shared';
import { Profile } from '../../profile/profile.entity.js';
import { stripHtml } from '../pipeline/filters.js';
import { getJson, JobSource } from './job-source.interface.js';

interface RemotiveResponse {
  jobs?: {
    id: number;
    url: string;
    title: string;
    company_name: string;
    candidate_required_location?: string;
    salary?: string;
    description?: string;
    publication_date?: string;
  }[];
}

/** Free remote-jobs feed, no key needed. */
@Injectable()
export class RemotiveSource implements JobSource {
  readonly name = 'remotive';
  isEnabled = () => true;

  async fetch(profile: Profile): Promise<RawJob[]> {
    const out: RawJob[] = [];
    for (const role of profile.preferences.roles.slice(0, 4)) {
      const res = await getJson<RemotiveResponse>(
        `https://remotive.com/api/remote-jobs?${new URLSearchParams({ search: role, limit: '50' })}`,
      );
      for (const j of res.jobs ?? []) {
        out.push({
          externalId: String(j.id),
          title: j.title,
          company: j.company_name,
          location: j.candidate_required_location,
          remote: true,
          salaryText: j.salary || undefined,
          description: stripHtml(j.description),
          applyUrl: j.url,
          postedAt: j.publication_date,
        });
      }
    }
    return out;
  }
}
