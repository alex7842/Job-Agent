# job-agent

A monorepo for a job-search agent: it crawls job boards on a schedule, filters and
dedupes what it finds, and has an LLM score every posting against your resume.

One deployable backend, one web app, one shared contract package, orchestrated with
Turborepo and pnpm workspaces.

```
job-agent/
├── apps/
│   ├── job-agent/        NestJS API + Kafka consumers + Temporal worker
│   └── web/              Vite + React + Tailwind dashboard
├── packages/
│   └── shared/           types, event contracts, API schemas (@job-agent/shared)
├── docker-compose.yml    Postgres, Kafka, Temporal, Temporal UI
├── turbo.json            task graph + caching
└── .env                  single env file, shared by every app
```

## The pipeline

```
                    ┌──────────────────────────────────────────────┐
  cron (10:00 IST)  │  Temporal worker  (apps/job-agent, dev:worker) │
        or           │  dailyJobSearchWorkflow                       │
  POST /runs  ──────▶│    for each profile:                           │
                    │      startRun      → search_runs row           │
                    │      fetchAndPublish × N sources (parallel)    │
                    └───────────────────┬──────────────────────────┘
                                        │ RawJobEvent per posting
                                        ▼
                                 ╔════════════╗
                                 ║  jobs.raw  ║
                                 ╚═════╤══════╝
                    ┌──────────────────┴──────────────────┐
                    │  API process  (apps/job-agent,      │
                    │  hybrid microservice, group         │
                    │  job-pipeline-server)                │
                    │                                     │
                    │  isFresh(postedWithinDays)           │
                    │  hardFilter(excluded*, remoteOnly)   │
                    │  insertIfNew(dedupeHash, OR IGNORE) │
                    └──────────────────┬──────────────────┘
                        new rows only   ▼
                                 ╔════════════╗
                                 ║  jobs.new  ║
                                 ╚═════╤══════╝
                    ┌──────────────────┴──────────────────┐
                    │  ScorerService → Anthropic         │
                    │  saveScore (score, reason,          │
                    │  highlights, redFlags)              │
                    └──────────────────┬──────────────────┘
                                       ▼
                                 ╔═════════════╗        ┌──────────┐
                                 ║ jobs.scored ║        │   web    │
                                 ╚═════════════╝        │ dashboard│
                                       │                └──────────┘
                          any failure  ▼
                                 ╔════════════╗
                                 ║  jobs.dlq  ║
                                 ╚════════════╝
```

### Why it is split this way

**Two processes, one codebase.** `dev:api` serves HTTP _and_ runs the Kafka
consumers (`src/main.ts` calls `connectMicroservice`). `dev:worker` is a separate
Nest application context that only polls the Temporal task queue. Same code, same
database — but LLM scoring never competes with workflow polling for the event loop,
and either side can be restarted without killing the other.

**Temporal owns the schedule and the fan-out.** `dailyJobSearchWorkflow` resolves
profiles, records a `search_runs` row, then calls `fetchAndPublish` once per source
in parallel with `Promise.allSettled`, so one dead job board never fails the run.
Per-source retries use exponential backoff. The workflow returns only a _count_ per
source, which keeps job payloads out of Temporal history.

**Kafka owns the fan-in.** Activities publish raw postings to `jobs.raw`; the API
process consumes them, applies cheap filters, and emits `jobs.new` only for rows that
actually made it into the database. A second consumer scores those and emits
`jobs.scored`. Every stage catches its own errors and routes them to `jobs.dlq`, so a
poison message can never block a partition. Re-delivery is safe: `jobs.raw` is
idempotent through the `(profileId, dedupeHash)` unique constraint, and `jobs.new`
skips any job that already has a `scoredAt`.

**Nothing consumes `jobs.scored` or `jobs.dlq` yet.** That is the intended hook for
notifications or a websocket feed.

### Key paths in `apps/job-agent`

| Concern                      | File                                                |
| ---------------------------- | --------------------------------------------------- |
| HTTP bootstrap + consumers   | `src/main.ts`                                       |
| Workflow (deterministic)     | `src/temporal/workflows.ts`                         |
| Activities (real I/O)        | `src/temporal/activities.ts`                        |
| Worker process               | `src/temporal/worker.ts`                            |
| Schedule + manual runs       | `src/temporal/temporal-client.service.ts`           |
| Stage 1 + 2 consumers        | `src/jobs/pipeline/job-pipeline.controller.ts`      |
| Filters + dedupe hash        | `src/jobs/pipeline/filters.ts`                      |
| LLM scoring prompt           | `src/jobs/pipeline/scorer.service.ts`               |
| Job platforms (add one here) | `src/jobs/sources/` + `sources.registry.ts`         |
| REST endpoints               | `src/jobs/jobs.controller.ts`, `runs.controller.ts` |

## Getting started

Requires Node 22+, pnpm 11+, and Docker.

```bash
pnpm install
cp .env.example .env          # then fill in ANTHROPIC_API_KEY and any source keys
pnpm infra:up                 # Postgres + Kafka + Temporal + Temporal UI
pnpm dev                      # API :3000, worker, and the web app
```

`pnpm dev` runs three watch processes at once through Turborepo. If Kafka (9092) or
Temporal (7233) are already running on your machine, start only the database with
`pnpm infra:up:db` — the compose file binds fixed ports and will fail otherwise.

The Vite dev server prints its port; it defaults to 5173 but steps up if that is
taken. All API traffic goes to `/api`, which Vite proxies to `PORT` in both `dev`
and `preview`, so a deployed build behaves exactly like development.

### Everything else

```bash
pnpm dev:api | dev:worker | dev:web    # run one process on its own
pnpm build                             # build every package
pnpm lint / typecheck / test           # run across the workspace
pnpm --filter job-agent migration:run  # real migrations (set DB_SYNC=false in prod)
```

## CI/CD

Two GitHub Actions workflows, one deploy target.

| Workflow                   | Trigger                        | What it does                                          |
| -------------------------- | ------------------------------ | ----------------------------------------------------- |
| `.github/workflows/ci.yml` | every push to `main`, every PR | format, typecheck, lint, test, build                  |
| `.github/workflows/cd.yml` | push to `main`, or manual      | build, then rsync + restart on the single deploy host |

CI installs with `--frozen-lockfile` and caches Turborepo's `.turbo` directory.
Add a `TURBO_TEAM` repository variable and a `TURBO_TOKEN` secret to enable Vercel
Remote Caching — the workflows already pass them through, and CI works without them.

### The deploy target

CD ships source, not `node_modules`: `@temporalio/core-bridge` and `@swc/core` are
native modules built for the target's own CPU and OS, so the host runs
`pnpm install --frozen-lockfile && pnpm build` itself. The host's `.env` is
excluded from the sync and `--delete-excluded` is never passed, so your secrets and
infrastructure addresses survive every release.

Configure it once under **Settings → Environments → production**:

| Kind     | Name             | Value                                           |
| -------- | ---------------- | ----------------------------------------------- |
| variable | `DEPLOY_HOST`    | host name or IP                                 |
| variable | `DEPLOY_USER`    | ssh user                                        |
| variable | `DEPLOY_PATH`    | absolute app directory, e.g. `/opt/job-agent`   |
| variable | `DEPLOY_URL`     | public base URL, e.g. `https://app.example.com` |
| secret   | `DEPLOY_SSH_KEY` | private key for that user                       |

The target host needs Node 24+, `corepack`, and `pm2` globally. The three
processes are defined in `deploy/ecosystem.config.cjs`:

| Process            | Command                        | Role                                 |
| ------------------ | ------------------------------ | ------------------------------------ |
| `job-agent-api`    | `node dist/main.js`            | HTTP API + Kafka consumers, `:3000`  |
| `job-agent-worker` | `node dist/temporal/worker.js` | Temporal activity worker             |
| `job-agent-web`    | `vite preview`                 | serves the built SPA, proxies `/api` |

`pm2 startOrReload … --update-env` restarts only what changed, and the workflow
finishes by polling `${DEPLOY_URL}/api/runs` to confirm the new build is serving.

Because `DB_SYNC` is `false` in production, the deploy runs
`pnpm --filter job-agent migration:run` as an explicit step — a database built
purely from migrations gets the same `jobs_status_enum` and
`search_runs_status_enum` types that `synchronize` produces in dev.

## Adding a job source

1. Implement `JobSource` in `apps/job-agent/src/jobs/sources/` — `name`,
   `isEnabled(profile)`, `fetch(profile)`, returning `RawJob[]`.
2. Add it to the `SourcesRegistry` constructor and array, and to `JobsModule`
   providers.
3. Add the name to `JOB_SOURCES` in `packages/shared/src/domain.ts` so the
   dashboard's source filter offers it.

Return `isEnabled = false` when credentials are missing and the workflow skips it
silently — that is how the app runs with no API keys at all.

## Environment

One `.env` at the repository root, read by every app
(`apps/job-agent/src/env.ts` resolves it; Vite reads it for the dev proxy). Never
prefix a secret with `VITE_` — anything so prefixed is inlined into the browser
bundle. Full annotated list in `.env.example`.
