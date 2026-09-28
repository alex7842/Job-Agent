import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { JOB_SOURCES, type JobPreferences, type UpdateProfileInput } from '@job-agent/shared';
import { useProfile, useUpdateProfile } from '@/lib/queries';
import { ErrorNote, Spinner } from '@/components/ui';

/**
 * Lists arrive as comma-separated strings in the form and are split on save, which
 * keeps the state shape flat and avoids a chip-input component for no benefit.
 */
const LIST_FIELDS = [
  'roles',
  'skills',
  'locations',
  'excludedKeywords',
  'excludedCompanies',
  'greenhouseBoards',
] as const satisfies readonly (keyof JobPreferences)[];

interface FormState {
  name: string;
  resumeText: string;
  isActive: boolean;
  roles: string;
  skills: string;
  locations: string;
  excludedKeywords: string;
  excludedCompanies: string;
  greenhouseBoards: string;
  sources: string;
  remoteOnly: boolean;
  minSalary: string;
  postedWithinDays: string;
}

const parseList = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

function toForm(name: string, resumeText: string, isActive: boolean, p: JobPreferences): FormState {
  return {
    name,
    resumeText,
    isActive,
    roles: p.roles.join(', '),
    skills: p.skills.join(', '),
    locations: p.locations.join(', '),
    excludedKeywords: p.excludedKeywords.join(', '),
    excludedCompanies: p.excludedCompanies.join(', '),
    greenhouseBoards: p.greenhouseBoards.join(', '),
    sources: (p.sources ?? []).join(', '),
    remoteOnly: p.remoteOnly,
    minSalary: p.minSalary?.toString() ?? '',
    postedWithinDays: String(p.postedWithinDays),
  };
}

function Label({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium tracking-wide text-neutral-400 uppercase">
        {children}
      </span>
      {hint ? <span className="block text-xs text-neutral-600">{hint}</span> : null}
    </label>
  );
}

const inputClass =
  'w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none placeholder:text-neutral-600 focus:border-neutral-600';

export function ProfilePage() {
  const { data: profile, isPending, isError, error } = useProfile();
  const save = useUpdateProfile();
  const [form, setForm] = useState<FormState | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed the form once, then leave it under the user's control (no clobbering
  // half-typed edits when the query refetches in the background).
  useEffect(() => {
    if (profile && form === null) {
      setForm(toForm(profile.name, profile.resumeText, profile.isActive, profile.preferences));
    }
  }, [profile, form]);

  if (isPending) return <Spinner label="Loading profile" />;
  if (isError) return <ErrorNote error={error} />;
  if (!profile || !form) return null;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setSaved(false);
    setForm((f) => (f ? { ...f, [key]: value } : f));
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const preferences: UpdateProfileInput['preferences'] = {
      remoteOnly: form.remoteOnly,
      postedWithinDays: Number(form.postedWithinDays) || 7,
    };
    for (const field of LIST_FIELDS) {
      preferences[field] = parseList(form[field]);
    }
    const sources = parseList(form.sources);
    if (sources.length > 0) preferences.sources = sources;

    const minSalary = form.minSalary.trim() === '' ? undefined : Number(form.minSalary);
    if (minSalary !== undefined) preferences.minSalary = minSalary;

    save.mutate(
      { name: form.name, resumeText: form.resumeText, isActive: form.isActive, preferences },
      { onSuccess: () => setSaved(true) },
    );
  };

  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-neutral-50">Profile</h1>
        <p className="text-sm text-neutral-500">
          These preferences drive the source queries, the hard filters, and the AI scoring prompt.
        </p>
      </header>

      <section className="space-y-3 rounded-xl border border-neutral-800 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Label>
            Name
            <input
              className={inputClass}
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </Label>
          <Label>
            Active
            <label className="flex h-[38px] items-center gap-2 text-sm text-neutral-300">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => set('isActive', e.target.checked)}
                className="size-4 accent-neutral-200"
              />
              included in scheduled searches
            </label>
          </Label>
        </div>

        <Label hint="Plain text. The first ~8k characters are sent to the model when scoring.">
          Resume
          <textarea
            className={`${inputClass} h-40 font-mono text-xs`}
            value={form.resumeText}
            onChange={(e) => set('resumeText', e.target.value)}
            placeholder="Paste your resume as plain text…"
          />
        </Label>
      </section>

      <section className="space-y-3 rounded-xl border border-neutral-800 p-4">
        <h2 className="text-sm font-semibold tracking-wide text-neutral-400 uppercase">
          What to look for
        </h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <Label hint="Comma separated. Used as the search query.">
            Roles
            <input
              className={inputClass}
              value={form.roles}
              onChange={(e) => set('roles', e.target.value)}
              placeholder="Full Stack Developer, React Native Developer"
            />
          </Label>
          <Label hint="Comma separated. Included in the scoring prompt.">
            Skills
            <input
              className={inputClass}
              value={form.skills}
              onChange={(e) => set('skills', e.target.value)}
              placeholder="React, Node.js, PostgreSQL"
            />
          </Label>
          <Label hint="Comma separated. Left out when “remote only” is on.">
            Locations
            <input
              className={inputClass}
              value={form.locations}
              onChange={(e) => set('locations', e.target.value)}
              placeholder="Bengaluru, Hyderabad"
            />
          </Label>
          <Label hint="Comma separated. Empty means every enabled source.">
            Sources
            <input
              className={inputClass}
              value={form.sources}
              onChange={(e) => set('sources', e.target.value)}
              placeholder={JOB_SOURCES.join(', ')}
            />
          </Label>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Label>
            Remote only
            <label className="flex h-[38px] items-center gap-2 text-sm text-neutral-300">
              <input
                type="checkbox"
                checked={form.remoteOnly}
                onChange={(e) => set('remoteOnly', e.target.checked)}
                className="size-4 accent-neutral-200"
              />
              drop onsite roles
            </label>
          </Label>
          <Label>
            Min salary
            <input
              className={inputClass}
              inputMode="numeric"
              value={form.minSalary}
              onChange={(e) => set('minSalary', e.target.value)}
              placeholder="optional"
            />
          </Label>
          <Label hint="1–30">
            Posted within (days)
            <input
              className={inputClass}
              inputMode="numeric"
              value={form.postedWithinDays}
              onChange={(e) => set('postedWithinDays', e.target.value)}
            />
          </Label>
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-neutral-800 p-4">
        <h2 className="text-sm font-semibold tracking-wide text-neutral-400 uppercase">
          Hard filters
        </h2>
        <p className="-mt-1 text-xs text-neutral-600">
          Checked before a job reaches the database, so the LLM never sees them.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Label hint="Title contains any of these → dropped.">
            Excluded keywords
            <input
              className={inputClass}
              value={form.excludedKeywords}
              onChange={(e) => set('excludedKeywords', e.target.value)}
              placeholder="intern, staffing"
            />
          </Label>
          <Label hint="Company name contains any of these → dropped.">
            Excluded companies
            <input
              className={inputClass}
              value={form.excludedCompanies}
              onChange={(e) => set('excludedCompanies', e.target.value)}
            />
          </Label>
          <Label hint="Greenhouse board tokens, e.g. stripe.">
            Greenhouse boards
            <input
              className={inputClass}
              value={form.greenhouseBoards}
              onChange={(e) => set('greenhouseBoards', e.target.value)}
              placeholder="stripe, airbnb"
            />
          </Label>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={save.isPending}
          className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 transition hover:bg-white disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save profile'}
        </button>
        {saved && !save.isPending ? <span className="text-xs text-emerald-400">Saved</span> : null}
        {save.isError ? <ErrorNote error={save.error} /> : null}
      </div>
    </form>
  );
}
