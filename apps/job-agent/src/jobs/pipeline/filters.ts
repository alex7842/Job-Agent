import { createHash } from 'crypto';
import { JobPreferences, RawJob, DEFAULT_PREFERENCES } from '@job-agent/shared';

const norm = (s?: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export const dedupeHash = (profileId: string, j: RawJob) =>
  createHash('sha1')
    .update(`${profileId}|${norm(j.company)}|${norm(j.title)}|${norm(j.location)}`)
    .digest('hex');

/** Cheap rules applied before anything hits the DB / LLM. Returns a reason if the job should be dropped. */
export function hardFilter(job: RawJob, prefs: JobPreferences): string | null {
  // prefs is a jsonb column, so it can be a partial object on a row written
  // before a field existed. Defaulting here keeps a malformed profile from
  // throwing and stalling the whole jobs.raw partition.
  const p = { ...DEFAULT_PREFERENCES, ...prefs };
  const includes = (terms: unknown, haystack: string) =>
    Array.isArray(terms) && terms.some((t) => t && haystack.includes(String(t).toLowerCase()));

  const title = job.title.toLowerCase();
  const company = job.company.toLowerCase();
  if (includes(p.excludedCompanies, company)) return 'excluded company';
  if (includes(p.excludedKeywords, title)) return 'excluded keyword';
  if (p.remoteOnly && job.remote === false) return 'not remote';
  return null;
}

export function isFresh(postedAt: string | undefined, days: number): boolean {
  if (!postedAt) return true;
  const t = Date.parse(postedAt);
  return Number.isNaN(t) || Date.now() - t <= days * 86_400_000;
}

const SENIORITY = new Set([
  'senior',
  'junior',
  'lead',
  'staff',
  'principal',
  'associate',
  'intern',
]);

/** For sources that return a whole company board (Greenhouse): keep only titles resembling a wanted role. */
export function looksRelevant(title: string, prefs: JobPreferences): boolean {
  if (prefs.roles.length === 0) return true;
  const t = title.toLowerCase();
  return prefs.roles.some((role) =>
    role
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !SENIORITY.has(w))
      .some((w) => t.includes(w)),
  );
}

export function stripHtml(html?: string, max = 6000): string | undefined {
  if (!html) return undefined;
  return html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
