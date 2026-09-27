import { Injectable } from '@nestjs/common';
import { Profile } from '../../profile/profile.entity.js';
import { AdzunaSource } from './adzuna.source.js';
import { GreenhouseSource } from './greenhouse.source.js';
import { JobSource } from './job-source.interface.js';
import { JSearchSource } from './jsearch.source.js';
import { RemotiveSource } from './remotive.source.js';

/** To add a platform: implement JobSource, add it to the constructor + array below, provide it in JobsModule. */
@Injectable()
export class SourcesRegistry {
  private readonly sources: JobSource[];

  constructor(jsearch: JSearchSource, adzuna: AdzunaSource, remotive: RemotiveSource, greenhouse: GreenhouseSource) {
    this.sources = [jsearch, adzuna, remotive, greenhouse];
  }

  enabledFor(profile: Profile): string[] {
    const allow = profile.preferences.sources;
    return this.sources
      .filter((s) => s.isEnabled(profile) && (!allow?.length || allow.includes(s.name)))
      .map((s) => s.name);
  }

  get(name: string): JobSource {
    const s = this.sources.find((x) => x.name === name);
    if (!s) throw new Error(`Unknown job source: ${name}`);
    return s;
  }
}
