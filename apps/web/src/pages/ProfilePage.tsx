import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  JOB_SOURCES,
  MAX_DOCUMENT_BYTES,
  type JobPreferences,
  type Profile,
  type UpdateProfileInput,
} from '@job-agent/shared';
import {
  useProfile,
  useRemoveResume,
  useResumeLink,
  useUpdateProfile,
  useUploadResume,
} from '@/lib/queries';
import {
  Button,
  Card,
  CardSection,
  ChipList,
  ErrorNote,
  FieldLabel,
  Input,
  Notice,
  Spinner,
  Switch,
  cx,
} from '@/components/ui';
import { formatDate, formatBytes, parseBytes } from '@/lib/format';

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

/** Up to two initials from the profile name; the fallback covers a blank name. */
const initials = (name: string) => {
  const fromName = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  return fromName || '?';
};

/**
 * The resume, uploaded as a file.
 *
 * One request does everything: the API stores it, the document service extracts
 * the text, the model structures it, and the fields below are written back into
 * the profile. The parsed result is shown rather than silently applied, because a
 * field the user disagrees with should be edited here and not re-derived.
 */
function ResumeUpload({ profile }: { profile: Profile }) {
  const upload = useUploadResume();
  const remove = useRemoveResume();
  const link = useResumeLink();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warn'; text: string } | null>(null);

  const submit = (file: File | undefined) => {
    if (!file) return;
    setNotice(null);
    if (file.size > MAX_DOCUMENT_BYTES) {
      setNotice({
        tone: 'warn',
        text: `That file is ${(file.size / 1048576).toFixed(1)} MB; the limit is 10 MB.`,
      });
      return;
    }
    upload.mutate(file, {
      onSuccess: (result) =>
        setNotice({
          tone: result.enriched ? 'success' : 'warn',
          text: result.enriched
            ? `Parsed ${result.textChars.toLocaleString()} characters — ${result.parsed.experience.length} roles and ${result.parsed.skills.length} skills filled in for you to check.`
            : (result.warnings[0] ?? 'The resume was saved as text.'),
        }),
    });
  };

  /**
   * Open the stored file in a new tab.
   *
   * The tab is opened synchronously, before the request: `window.open` after an
   * await is no longer within the click's user activation, so the browser blocks
   * it as a popup. Navigating the empty tab once the signed URL arrives keeps the
   * gesture intact, and `opener = null` stops the new tab reaching back into
   * this one.
   */
  const view = () => {
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;

    link.mutate(undefined, {
      onSuccess: (signed) => {
        if (!/^https?:\/\//.test(signed.url)) {
          tab?.close();
          setNotice({
            tone: 'warn',
            text: `The ${signed.store} object store has no URL to open; it keeps the file on disk. Set OBJECT_STORE=s3 to view it here.`,
          });
          return;
        }
        if (tab) tab.location.href = signed.url;
        else window.location.href = signed.url;
      },
      onError: () => {
        tab?.close();
        setNotice({ tone: 'warn', text: 'Could not get a link to the stored resume.' });
      },
    });
  };

  const drop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    submit(e.dataTransfer.files[0]);
  };

  const size = parseBytes(profile.resumeSizeBytes);

  return (
    <Card className="overflow-hidden">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
        className={cx(
          'relative border-2 border-dashed px-6 py-10 text-center transition-colors',
          dragging ? 'border-accent bg-accent-soft/40' : 'border-line bg-surface-2/50',
        )}
      >
        <input
          ref={input}
          type="file"
          accept=".pdf,.docx,.txt,.md"
          className="hidden"
          onChange={(e) => {
            submit(e.target.files?.[0]);
            // Reset so re-picking the same file fires change again.
            e.target.value = '';
          }}
        />

        <span
          className={cx(
            'mx-auto mb-4 grid size-12 place-items-center rounded-xl transition-transform',
            dragging ? 'scale-110 bg-accent text-accent-fg' : 'bg-surface-3 text-muted',
          )}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            className="size-6"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            <path d="M12 16V5m0 0L8 9m4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
            <path
              d="M5 16v2.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V16"
              strokeLinecap="round"
            />
          </svg>
        </span>

        <p className="text-sm font-medium text-fg">
          {upload.isPending ? 'Reading your resume…' : 'Drop your resume here'}
        </p>
        <p className="mx-auto mt-1 max-w-sm text-xs text-subtle">
          PDF, DOCX, TXT or MD, up to 10 MB. The text is extracted and your preferences below are
          filled in for you to check.
        </p>

        <Button
          type="button"
          variant="primary"
          className="mt-4"
          loading={upload.isPending}
          onClick={() => input.current?.click()}
        >
          Choose file
        </Button>
      </div>

      <div className="space-y-3 p-5">
        {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
        {upload.isError ? <ErrorNote error={upload.error} /> : null}
        {remove.isError ? <ErrorNote error={remove.error} /> : null}
        {link.isError ? <ErrorNote error={link.error} /> : null}

        {profile.resumeFileName ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-2 px-4 py-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-danger-bg text-danger">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                className="size-4.5"
                stroke="currentColor"
                strokeWidth="1.7"
              >
                <path
                  d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"
                  strokeLinejoin="round"
                />
                <path d="M14 3v5h5" strokeLinejoin="round" />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-fg">{profile.resumeFileName}</p>
              <p className="text-xs text-subtle">
                {[size !== null ? formatBytes(size) : null, profile.resumeMimeType]
                  .filter(Boolean)
                  .join(' · ')}
                {profile.resumeParsedAt ? ` · parsed ${formatDate(profile.resumeParsedAt)}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                loading={link.isPending}
                onClick={view}
                title="Opens the stored file in a new tab via a short-lived signed link"
              >
                View
              </Button>
              <Button
                size="sm"
                variant="ghost"
                loading={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Remove
              </Button>
            </div>
          </div>
        ) : null}

        {profile.resumeError && !upload.isError ? (
          <Notice tone="warn">The file was stored but not parsed: {profile.resumeError}</Notice>
        ) : null}
      </div>
    </Card>
  );
}

/** What the parser read, laid out for reading and for correcting. */
function ParsedResume({ profile }: { profile: Profile }) {
  const data = profile.resumeData!;

  return (
    <CardSection
      title="Parsed resume"
      hint="What the model read out of your file. Correct anything that looks wrong before you save."
      icon={
        <svg
          viewBox="0 0 24 24"
          fill="none"
          className="size-4"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <path d="M4 6h16M4 12h10M4 18h13" strokeLinecap="round" />
        </svg>
      }
      bodyClassName="space-y-5"
    >
      {data.headline ? (
        <div>
          <FieldLabel>Headline</FieldLabel>
          <p className="mt-1.5 text-sm text-fg">{data.headline}</p>
        </div>
      ) : null}

      {data.email || data.phone || data.location ? (
        <div>
          <FieldLabel>Contact</FieldLabel>
          <p className="mt-1.5 text-sm text-muted">
            {[data.email, data.phone, data.location].filter(Boolean).join(' · ')}
          </p>
        </div>
      ) : null}

      <div>
        <FieldLabel
          hint={
            data.yearsOfExperience !== null
              ? `${data.yearsOfExperience} years of experience`
              : undefined
          }
        >
          Skills
        </FieldLabel>
        <div className="mt-1.5">
          <ChipList items={data.skills} tone="accent" empty="none found" />
        </div>
      </div>

      {data.experience.length > 0 ? (
        <div className="space-y-2.5">
          <FieldLabel>Experience</FieldLabel>
          <ol className="space-y-2">
            {data.experience.map((role, i) => (
              <li
                key={`${role.company}-${i}`}
                className="rounded-lg border border-line bg-surface-2 p-3.5"
              >
                <p className="text-sm font-medium text-fg">
                  {role.title || 'Untitled role'}
                  {role.company ? <span className="text-muted"> · {role.company}</span> : null}
                </p>
                <p className="mt-0.5 text-xs text-subtle">
                  {[role.startDate, role.current ? 'Present' : role.endDate, role.location]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {role.summary ? (
                  <p className="mt-1.5 text-xs leading-relaxed text-muted">{role.summary}</p>
                ) : null}
                {role.highlights.length > 0 ? (
                  <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-muted">
                    {role.highlights.map((h, j) => (
                      <li key={j}>{h}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {data.education.length > 0 ? (
        <div className="space-y-2">
          <FieldLabel>Education</FieldLabel>
          <ul className="space-y-1">
            {data.education.map((e, i) => (
              <li key={i} className="text-sm text-muted">
                {[e.degree, e.field, e.institution].filter(Boolean).join(' · ')}
                {[e.startYear, e.endYear].filter(Boolean).join('–')}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {data.certifications.length > 0 ? (
        <div>
          <FieldLabel>Certifications</FieldLabel>
          <div className="mt-1.5">
            <ChipList items={data.certifications} />
          </div>
        </div>
      ) : null}
    </CardSection>
  );
}

export function ProfilePage() {
  const { data: profile, isPending, isError, error } = useProfile();
  const save = useUpdateProfile();
  const upload = useUploadResume();
  const [form, setForm] = useState<FormState | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed the form once, then leave it under the user's control (no clobbering
  // half-typed edits when the query refetches in the background). The exception
  // is an upload: that rewrote the server's copy of every field, so showing the
  // stale form would misrepresent what was just saved.
  useEffect(() => {
    if (profile && (form === null || upload.isSuccess)) {
      setForm(toForm(profile.name, profile.resumeText, profile.isActive, profile.preferences));
    }
  }, [profile, form, upload.isSuccess]);

  const resumeStats = useMemo(() => {
    if (!profile) return null;
    const data = profile.resumeData;
    return {
      skills: data?.skills.length ?? 0,
      roles: data?.experience.length ?? profile.preferences.roles.length,
      years: data?.yearsOfExperience ?? null,
      chars: profile.resumeText.length,
    };
  }, [profile]);

  if (isPending) return <Spinner label="Loading profile" />;
  if (isError) return <ErrorNote error={error} />;
  if (!profile || !form || !resumeStats) return null;

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

    // resumeText has no input of its own: it is what the extractor read out of
    // the uploaded file, and it is the text the search query is built from. It
    // is echoed back unchanged rather than dropped, because omitting it would
    // make every save from this form clear the resume.
    save.mutate(
      { name: form.name, resumeText: form.resumeText, isActive: form.isActive, preferences },
      { onSuccess: () => setSaved(true) },
    );
  };

  const stats = [
    { label: 'Target roles', value: parseList(form.roles).length },
    { label: 'Skills', value: parseList(form.skills).length },
    { label: 'Resume', value: resumeStats.chars > 0 ? 'on file' : 'missing' },
    { label: 'Scheduled', value: form.isActive ? 'daily' : 'paused' },
  ];

  return (
    /*
     * `pb-24` reserves room for the sticky save bar. Without it the bar is a
     * `position: sticky` overlay pinned inside the form's own box, so the last
     * field can never be scrolled clear of it — it ends up under the bar at the
     * bottom of the page.
     */
    <form onSubmit={onSubmit} className="space-y-6 pb-24">
      {/* ---------- hero ---------- */}
      <Card className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-linear-to-br from-accent/10 via-transparent to-transparent"
        />
        <div className="relative flex flex-wrap items-center justify-between gap-5 p-6">
          <div className="flex min-w-0 items-center gap-4">
            <span className="grid size-16 shrink-0 place-items-center rounded-2xl bg-accent text-xl font-semibold text-accent-fg shadow-lift">
              {initials(profile.name)}
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-semibold tracking-tight text-fg">
                {profile.name || 'Your profile'}
              </h1>
              <p className="mt-0.5 truncate text-sm text-muted">
                These preferences drive the source queries, the hard filters, and the scoring
                prompt.
              </p>
            </div>
          </div>

          <Switch
            checked={form.isActive}
            onChange={(v) => set('isActive', v)}
            label={form.isActive ? 'Scheduled searches on' : 'Scheduled searches paused'}
            hint={form.isActive ? 'Included in the daily run' : 'You can still search manually'}
          />
        </div>

        <dl className="relative grid grid-cols-2 divide-x divide-line border-t border-line sm:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="px-5 py-3.5">
              <dt className="text-xs text-subtle">{stat.label}</dt>
              <dd className="mt-0.5 text-sm font-semibold text-fg tabular-nums">{stat.value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          <CardSection
            title="Identity"
            hint="Shown on your profile and used to label your runs."
            icon={
              <svg
                viewBox="0 0 24 24"
                fill="none"
                className="size-4"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <circle cx="12" cy="8" r="3.5" />
                <path d="M5 20a7 7 0 0 1 14 0" strokeLinecap="round" />
              </svg>
            }
          >
            <FieldLabel htmlFor="profile-name">Name</FieldLabel>
            <Input
              id="profile-name"
              className="mt-1.5 max-w-sm"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Ada Lovelace"
            />
          </CardSection>

          {/* ---------- what to look for ---------- */}
          <CardSection
            title="What to look for"
            hint="Roles become the search query; skills and locations go into the prompt the model scores with."
            icon={
              <svg
                viewBox="0 0 24 24"
                fill="none"
                className="size-4"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" strokeLinecap="round" />
              </svg>
            }
            bodyClassName="space-y-5"
          >
            <div className="grid gap-5 sm:grid-cols-2">
              <FieldLabel hint="Comma separated. Used as the search query." htmlFor="roles">
                Roles
              </FieldLabel>
              <FieldLabel hint="Comma separated. Included in the scoring prompt." htmlFor="skills">
                Skills
              </FieldLabel>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <Input
                id="roles"
                value={form.roles}
                onChange={(e) => set('roles', e.target.value)}
                placeholder="Full Stack Developer, React Native Developer"
              />
              <Input
                id="skills"
                value={form.skills}
                onChange={(e) => set('skills', e.target.value)}
                placeholder="React, Node.js, PostgreSQL"
              />
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <FieldLabel
                hint="Comma separated. Left out when “remote only” is on."
                htmlFor="locations"
              >
                Locations
              </FieldLabel>
              <FieldLabel hint="Empty means every enabled source." htmlFor="sources">
                Sources
              </FieldLabel>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <Input
                id="locations"
                value={form.locations}
                onChange={(e) => set('locations', e.target.value)}
                placeholder="Bengaluru, Hyderabad"
              />
              <Input
                id="sources"
                value={form.sources}
                onChange={(e) => set('sources', e.target.value)}
                placeholder={JOB_SOURCES.join(', ')}
              />
            </div>

            {/* Preview of what will actually be sent — the comma string is not
                obviously a list, and this is what the API receives. */}
            <div className="space-y-3 rounded-lg border border-line bg-surface-2 p-4">
              <FieldLabel>Will be saved as</FieldLabel>
              <div className="grid gap-3 sm:grid-cols-2">
                <ChipList items={parseList(form.roles)} empty="no roles — searches will be broad" />
                <ChipList items={parseList(form.skills)} tone="accent" empty="no skills" />
              </div>
            </div>
          </CardSection>

          {/* ---------- search shape ---------- */}
          <CardSection
            title="Search shape"
            hint="The hard numbers a run is built around."
            icon={
              <svg
                viewBox="0 0 24 24"
                fill="none"
                className="size-4"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="M4 7h16M7 12h10M10 17h4" strokeLinecap="round" />
              </svg>
            }
            bodyClassName="space-y-5"
          >
            <Switch
              checked={form.remoteOnly}
              onChange={(v) => set('remoteOnly', v)}
              label="Remote only"
              hint="Drop onsite roles before anything reaches the model"
            />

            <div className="grid gap-5 sm:grid-cols-2">
              <FieldLabel hint="In the posting's own currency, as a number." htmlFor="min-salary">
                Min salary
              </FieldLabel>
              <FieldLabel
                hint="1–30. Postings older than this are ignored."
                htmlFor="posted-within"
              >
                Posted within (days)
              </FieldLabel>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <Input
                id="min-salary"
                inputMode="numeric"
                value={form.minSalary}
                onChange={(e) => set('minSalary', e.target.value)}
                placeholder="optional"
              />
              <Input
                id="posted-within"
                inputMode="numeric"
                value={form.postedWithinDays}
                onChange={(e) => set('postedWithinDays', e.target.value)}
              />
            </div>
          </CardSection>

          {/* ---------- hard filters ---------- */}
          <CardSection
            title="Hard filters"
            hint="Checked before a job reaches the database, so the model never sees a posting you do not want."
            icon={
              <svg
                viewBox="0 0 24 24"
                fill="none"
                className="size-4"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="M4 6h16M7 12h10M10 18h4" strokeLinecap="round" />
                <circle cx="8" cy="6" r="1.8" fill="currentColor" />
              </svg>
            }
            bodyClassName="space-y-5"
          >
            <div className="grid gap-5 sm:grid-cols-2">
              <FieldLabel hint="Title contains any of these → dropped." htmlFor="excluded-keywords">
                Excluded keywords
              </FieldLabel>
              <FieldLabel
                hint="Company name contains any of these → dropped."
                htmlFor="excluded-companies"
              >
                Excluded companies
              </FieldLabel>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <Input
                id="excluded-keywords"
                value={form.excludedKeywords}
                onChange={(e) => set('excludedKeywords', e.target.value)}
                placeholder="intern, staffing"
              />
              <Input
                id="excluded-companies"
                value={form.excludedCompanies}
                onChange={(e) => set('excludedCompanies', e.target.value)}
                placeholder="Acme Corp"
              />
            </div>

            <FieldLabel hint="Greenhouse board tokens, e.g. stripe." htmlFor="greenhouse-boards">
              Greenhouse boards
            </FieldLabel>
            <Input
              id="greenhouse-boards"
              className="max-w-sm"
              value={form.greenhouseBoards}
              onChange={(e) => set('greenhouseBoards', e.target.value)}
              placeholder="stripe, airbnb"
            />
          </CardSection>

          {profile.resumeData ? <ParsedResume profile={profile} /> : null}
        </div>

        {/* ---------- sidebar ---------- */}
        <aside className="space-y-6">
          <CardSection
            title="Resume"
            hint="Everything else on this page is a guess until this is uploaded."
            icon={
              <svg
                viewBox="0 0 24 24"
                fill="none"
                className="size-4"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path
                  d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"
                  strokeLinejoin="round"
                />
                <path d="M14 3v5h5" strokeLinejoin="round" />
              </svg>
            }
            bodyClassName="p-0"
          >
            <ResumeUpload profile={profile} />
          </CardSection>

          <Card className="p-5">
            <FieldLabel>Resume text</FieldLabel>
            <p className="mt-1.5 text-xs leading-relaxed text-subtle">
              {resumeStats.chars.toLocaleString()} characters extracted. This is the text the model
              scores against and the vector index is built from — it updates when you upload a new
              file.
            </p>
            {resumeStats.years !== null ? (
              <p className="mt-3 text-xs text-muted">
                <span className="font-semibold text-fg tabular-nums">{resumeStats.years}</span>{' '}
                years of experience detected
              </p>
            ) : null}
          </Card>
        </aside>
      </div>

      {/* ---------- sticky save bar ---------- */}
      <div className="sticky bottom-4 z-30 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface/90 px-4 py-3 shadow-pop backdrop-blur-md">
        <Button type="submit" variant="primary" size="lg" loading={save.isPending}>
          Save profile
        </Button>

        {saved && !save.isPending ? (
          <span className="flex items-center gap-1.5 text-sm text-success">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="size-4"
              stroke="currentColor"
              strokeWidth="2.2"
            >
              <path d="m5 13 4 4 10-10" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Saved
          </span>
        ) : (
          <span className="text-xs text-subtle">Changes apply to your next search.</span>
        )}

        {save.isError ? <ErrorNote error={save.error} className="w-full py-2" /> : null}
      </div>
    </form>
  );
}
