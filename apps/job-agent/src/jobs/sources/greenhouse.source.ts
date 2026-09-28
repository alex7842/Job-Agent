import { Injectable } from '@nestjs/common';
import { RawJob } from '@job-agent/shared';
import { Profile } from '../../profile/profile.entity.js';
import { looksRelevant, stripHtml } from '../pipeline/filters.js';
import { getJson, JobSource } from './job-source.interface.js';

interface GreenhouseResponse {
  jobs?: {
    id: number;
    title: string;
    absolute_url: string;
    updated_at?: string;
    company_name?: string;
    location?: { name?: string };
    content?: string;
  }[];
}

/** Public Greenhouse boards for the companies listed in preferences.greenhouseBoards. */
@Injectable()
export class GreenhouseSource implements JobSource {
  readonly name = 'greenhouse';
  isEnabled = (p: Profile) => p.preferences.greenhouseBoards.length > 0;

  async fetch(profile: Profile): Promise<RawJob[]> {
    const out: RawJob[] = [];
    for (const board of profile.preferences.greenhouseBoards) {
      const res = await getJson<GreenhouseResponse>(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`,
      );
      for (const j of res.jobs ?? []) {
        if (!looksRelevant(j.title, profile.preferences)) continue;
        out.push({
          externalId: `${board}-${j.id}`,
          title: j.title,
          company: j.company_name ?? board,
          location: j.location?.name,
          remote: /remote/i.test(j.location?.name ?? '') || undefined,
          description: stripHtml(j.content),
          applyUrl: j.absolute_url,
          postedAt: j.updated_at,
        });
      }
    }
    return out;
  }
}
