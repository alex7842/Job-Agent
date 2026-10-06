import { JobPreferences, RawJob } from '@job-agent/shared';
import { Profile } from '../../profile/profile.entity.js';

export interface JobSource {
  /** unique id, stored in jobs.source */
  readonly name: string;
  /** false -> skipped (missing API key, no boards configured, ...) */
  isEnabled(profile: Profile): boolean;
  fetch(profile: Profile): Promise<RawJob[]>;
}

/**
 * Fetch failure that carries the HTTP status.
 *
 * Sources need to tell a *credential* problem from a transient one: a key that
 * is rejected or not subscribed to will be rejected on every future request
 * too, so the source should switch itself off rather than fail the run and be
 * retried by Temporal until the workflow gives up. A 429 or a 5xx is the
 * opposite and must keep propagating.
 */
export class SourceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly host: string,
    readonly detail: string,
  ) {
    // only the host and the provider's own message go in -> API keys, which
    // ride in the query string of some of these calls, never reach logs or DB
    super(`${status} from ${host}${detail ? `: ${detail}` : ''}`);
    this.name = 'SourceHttpError';
  }
}

export async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    // Providers say why in the body ("You are not subscribed to this API"), and
    // that is the difference between a config mistake and a bad request.
    const detail = await res
      .text()
      .then((t) => t.slice(0, 200).replace(/https?:\/\/\S+/g, '<url>'))
      .catch(() => '');
    throw new SourceHttpError(res.status, new URL(url).host, detail);
  }
  return (await res.json()) as T;
}

/** A credential the provider will reject forever, as opposed to a flaky call. */
export function isCredentialFailure(error: unknown): boolean {
  return error instanceof SourceHttpError && (error.status === 401 || error.status === 403);
}

/**
 * Progressively looser forms of one query, narrowest first.
 *
 * A profile's roles and locations are written by the resume parser, so they are
 * literal strings off a CV — "Associate Software Engineer (Full Stack Developer)"
 * searched in "Tirunelveli, Tamil Nadu, India". Boards match neither well, and a
 * query that is merely too narrow returns an empty page that is indistinguishable
 * from "no jobs today". Adzuna has zero postings indexed for that city, so every
 * single query came back empty.
 *
 * Each form is only tried after the one before it returned nothing, so a query
 * that works still costs exactly one API call.
 */
export function broadenings(
  role: string,
  where?: string,
): { role: string; where?: string | undefined }[] {
  // "(Full Stack Developer)" is a gloss on the title, not part of it, and the
  // board reads it as required tokens.
  const bare =
    role
      .replace(/\s*\([^)]*\)\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || role;
  const forms: { role: string; where?: string }[] = [{ role, where }];
  if (bare !== role) forms.push({ role: bare, where });
  // The location is the usual culprit: a town with no postings, or a spelling the
  // board does not recognise. Dropping it costs precision, not coverage.
  if (where) forms.push({ role: bare, where: undefined });
  return forms;
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
