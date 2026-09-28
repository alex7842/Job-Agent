import { JobPreferences, RawJob } from '@job-agent/shared';
import { Profile } from '../../profile/profile.entity.js';

export interface JobSource {
  /** unique id, stored in jobs.source */
  readonly name: string;
  /** false -> skipped (missing API key, no boards configured, ...) */
  isEnabled(profile: Profile): boolean;
  fetch(profile: Profile): Promise<RawJob[]>;
}

export async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  // only the host goes in the error -> API keys in the URL never leak into logs / DB
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).host}`);
  return (await res.json()) as T;
}

/** role x location combos (capped to keep API usage low) */
export function searchQueries(prefs: JobPreferences, maxRoles = 4, maxLocations = 2) {
  const roles = prefs.roles.slice(0, maxRoles);
  const places: (string | undefined)[] =
    prefs.remoteOnly || prefs.locations.length === 0
      ? [undefined]
      : prefs.locations.slice(0, maxLocations);
  return roles.flatMap((role) => places.map((where) => ({ role, where })));
}
