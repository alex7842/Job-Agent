import { Injectable, Logger } from '@nestjs/common';
import { DEFAULT_PREFERENCES } from '@job-agent/shared';
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
  private readonly log = new Logger(SourcesRegistry.name);

  constructor(
    jsearch: JSearchSource,
    adzuna: AdzunaSource,
    remotive: RemotiveSource,
    greenhouse: GreenhouseSource,
  ) {
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

  /**
   * Every source and whether it is usable at all, for the admin dashboard.
   *
   * The probe profile carries `DEFAULT_PREFERENCES` rather than `{}`, because
   * `isEnabled` reads off `preferences` and an empty object is not a valid one:
   * a source that expected `preferences.greenhouseBoards` to exist threw, and
   * that throw came out of `map()` as a 500 for the whole overview.
   *
   * A source that still throws is reported as disabled rather than taking the
   * dashboard with it. This is the page you open *because* something is broken,
   * so it has to survive one broken source; the warning keeps the failure from
   * being silent.
   */
  status(profile?: Profile) {
    const probe: Profile =
      profile ?? ({ preferences: { ...DEFAULT_PREFERENCES } } as unknown as Profile);

    return this.sources.map((source) => {
      try {
        return { name: source.name, enabled: source.isEnabled(probe) };
      } catch (error) {
        this.log.warn(
          `${source.name}.isEnabled threw, so it is reported as disabled: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return { name: source.name, enabled: false };
      }
    });
  }
}
