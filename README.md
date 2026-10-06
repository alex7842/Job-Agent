# job-agent

A monorepo for a job-search agent: it crawls job boards on a schedule, filters and
dedupes what it finds, has an LLM score every posting against your resume, and
indexes postings and uploaded documents into a vector store for semantic matching.

Four apps, one shared contract package, orchestrated with Turborepo and pnpm
workspaces.

```
job-agent/
├── apps/
│   ├── job-agent/        NestJS API + Kafka consumers + Temporal worker
│   ├── rag-service/      document extraction, embeddings, Pinecone retrieval
│   └── web/              Vite + React + Tailwind dashboard
├── packages/
│   └── shared/           types, event contracts, API schemas (@job-agent/shared)
├── deploy/               pm2 process definitions
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
                    │  ScorerService → Fireworks         │
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
| Document catalog + uploads   | `src/documents/`                                    |
| Semantic ranking             | `src/semantic/semantic-match.service.ts`            |
| Signed client to the RAG svc | `src/rag/rag-client.service.ts`                     |
| Outbox write + relay         | `src/outbox/`                                       |
| Job platforms (add one here) | `src/jobs/sources/` + `sources.registry.ts`         |
| REST endpoints               | `src/jobs/jobs.controller.ts`, `runs.controller.ts` |

## Getting started

Requires Node 22+, pnpm 11+, and Docker.

```bash
pnpm install
cp .env.example .env          # then fill in FIREWORKS_API_KEY and any source keys
pnpm infra:up                 # Postgres + Kafka + Temporal + Temporal UI
pnpm dev                      # API :3000, worker, and the web app
```

`pnpm dev` runs three watch processes at once through Turborepo. If Kafka (9092) or
Temporal (7233) are already running on your machine, start only the database with
`pnpm infra:up:db` — the compose file binds fixed ports and will fail otherwise.

The Vite dev server prints its port; it defaults to 5173 but steps up if that is
taken. All API traffic goes to `/api`, which Vite proxies to `PORT` in both `dev`
and `preview`, so a deployed build behaves exactly like development.

`JWT_SECRET` is required — generate one with

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

The API refuses to boot without it rather than falling back to a shared default.
Open the web app and create an account; every job, run, and profile belongs to it.

### Everything else

```bash
pnpm dev:api | dev:worker | dev:web    # run one process on its own
pnpm build                             # build every package
pnpm lint / typecheck / test           # run across the workspace
pnpm --filter job-agent migration:run  # real migrations (set DB_SYNC=false in prod)
```

## Authentication

Every HTTP route except `GET /` (the health check) and the `/auth` entry points
requires `Authorization: Bearer <accessToken>`.

| Route                   | Auth   | Notes                                       |
| ----------------------- | ------ | ------------------------------------------- |
| `POST /auth/register`   | public | creates the user, their profile, and tokens |
| `POST /auth/login`      | public |                                             |
| `POST /auth/refresh`    | public | body carries the refresh token              |
| `POST /auth/logout`     | public | revokes the refresh token, idempotent       |
| `GET /auth/me`          | bearer |                                             |
| `GET /jobs`, `/runs`, … | bearer | scoped to the caller's profile              |

### Tokens

- **Access** — a 15-minute JWT carrying `sub`, `email`, and `pid` (profile id), so
  the common path needs no extra profile lookup. Stateless.
- **Refresh** — a 30-day JWT whose SHA-256 is stored in `refresh_tokens`. That
  table is what makes a session revocable; the JWT alone could not be withdrawn.

Both are signed with `JWT_SECRET` and tagged `typ`, so a refresh token can never
be used as a bearer token. The web app keeps them in `sessionStorage`: closing the
tab signs you out, and a reload is seamless because the refresh token survives it.

### Rotation and reuse

Refreshing issues a new pair and revokes the token that was presented. Presenting
an already-consumed token is treated as theft and revokes **every** session for
that user, which is the trade-off recommended by the OAuth security BCP: a
genuine double refresh signs the user out, but a stolen token cannot outlive its
detection. Tokens are per-tab, so the double refresh case does not arise in this
app. A fresh login is always available, so this is not a lockout.

### Passwords

`node:crypto` scrypt at N=16384, r=8, p=1, stored as
`scrypt$N$r$p$salt$hash` so the cost parameters can be raised later without
invalidating existing rows. No native dependency. Login answers the same error for
an unknown email and a wrong password, so the endpoint cannot be used to enumerate
accounts.

### Notes for contributors

- The guard is applied per controller with `@UseGuards(JwtAuthGuard)`, **not**
  registered globally: `JobPipelineController` is also a provider in the Kafka
  microservice context, where a global guard would run with no request and no
  header, failing every scoring event.
- `JobsService.getById(id)` is for the Kafka pipeline, which legitimately has no
  user. Anything reachable from HTTP must use `getOwnedById(id, profileId)`, which
  filters `id` + `profileId` so a foreign id is a 404 rather than a read.
- On sign-out the web app clears the TanStack Query cache, so the next person to
  sign in on that tab never renders the previous user's jobs.

## Semantic search (RAG service)

`apps/rag-service` is a separate NestJS process that turns job postings and
uploaded documents into vectors, and answers "which jobs fit this candidate?"
by meaning rather than keyword overlap.

```
  documents.changed ─┐
  jobs.index        ─┴─▶ ┌──────────────────────────────────────┐
                      │  rag-service                          │
  POST /internal/  ────▶│    object store (S3 | local disk)    │
    search              │      │ download                        │
                       │    extractor (pdf | docx | text)        │
                       │      │                                  │
                       │    chunker (900 chars, 150 overlap)    │
                       │      │                                  │
                       │    embeddings (Fireworks, or offline)  │
                       │      │                               │
                       │      │                                  │
                       │    vector store (Pinecone | memory)    │
                       └──────────────────────────────────────┘
```

### Why it is a separate process

PDF extraction and batched embedding are slow and memory-hungry. A restart or
an OOM on the retrieval path should not take the job pipeline down with it, and
the two scale on different axes: indexing is bursty and parallel, search is
short and latency-sensitive. It runs under its own pm2 process (`rag-service`)
with a higher memory limit.

One process serves both transports — HTTP for the synchronous search call, Kafka
for the indexing events — so a search is answerable while indexing continues.

### Retrieval, and why it is built this way

- **Job and document vectors share one namespace and one model.** Comparing them
  is the entire point, and two embedding spaces are not comparable. The namespace
  is `user-${profileId}`, so a missing filter is a hard failure to leak rather
  than a silent cross-user read.
- **Documents are chunked, not embedded whole.** A resume mixes many roles, so
  one vector for the whole file matches everything weakly. Chunking at ~900
  characters with 150 of overlap keeps a requirement like "5+ years of
  Kubernetes" intact across a split.
- **Search is multi-query with Reciprocal Rank Fusion.** One query per wanted
  role focuses each embedding, and RRF merges the ranked lists by _position_
  rather than by score, because cosine scores from different queries are not on
  a common scale.
- **Fusion is keyed by `jobId`.** Each query returns a different object for the
  same posting, so fusing on object identity returns duplicates instead of a
  merged ranking. `reciprocalRankFusion` therefore takes an explicit `keyOf`.
- **Only the head of each ranked list counts as evidence.** A vector store always
  returns k neighbours, so every query "retrieves" every job in its tail; letting
  the tail vote would make `matchedBy` and the averaged similarity meaningless.
- **`score` is the best similarity, not the fused rank.** RRF scores are
  `1/(60+rank)` and are nearly flat, so reporting them as match strength would
  show ~0.98 for a job that barely matched.
- **Re-indexing replaces vectors in place.** Ids are deterministic
  (`document:<id>:<chunk>`), so a repeat is an overwrite; the chunks the new
  generation did not produce are deleted _after_ the upsert, which keeps the
  previous version searchable if extraction fails halfway.

### Adapters, and the degraded path

Every external dependency is a port with a real adapter and a local one:

| Port       | Production                              | Local fallback                  | Selected by          |
| ---------- | --------------------------------------- | ------------------------------- | -------------------- |
| Embeddings | Fireworks (`qwen3-embedding-8b`, 1024d) | `offline` (deterministic, 384d) | `EMBEDDING_PROVIDER` |
| Vectors    | Pinecone                                | `memory` (per-process)          | `VECTOR_STORE`       |
| Objects    | S3                                      | `local` (filesystem)            | `OBJECT_STORE`       |

The fallbacks exist so the whole flow runs and is testable with zero credentials
and no network — the same ports, the same ranking maths. They are **not** good
retrieval models: `offline` is a hashed bag of words, so it matches literally and
has no notion of synonymy.

The service therefore logs `DEGRADED` on boot and returns `degraded: true` in
every search response and on `GET /health`, so a lexical-only result set is never
mistaken for a real semantic one.

**The Pinecone index dimension is fixed at creation and must equal the embedding
model's output** (1024 for `qwen3-embedding-8b`, 384 for `offline`). A mismatch is checked at boot and fails loudly, because
otherwise it shows up as a mysteriously empty index rather than an error.

### Security

`/internal/*` is service-to-service, not browser-facing, but it is not left open:
anything able to reach the port could otherwise enumerate a user's documents or
read back their extracted resume text. Each request carries
`x-internal-token`, an HMAC-SHA256 of `METHOD:/path` keyed by
`RAG_INTERNAL_SECRET`, compared in constant time. Signing the path means a token
minted for one route cannot be replayed against another. The service refuses to
boot if the secret is missing or under 32 characters.

`GET /health` is intentionally unauthenticated and dependency-probing: a static
`200` would report healthy while every request failed.

### Migrations

The RAG service owns `rag_documents` and its own migrations
(`pnpm --filter rag-service migration:run`). It deliberately does **not** share
tables with the job agent even though both use `task_app`: two services sharing
table ownership means one process's `migration:revert` drops the other's data.

The job agent adds three tables, all under `pnpm --filter job-agent migration:run`:
`documents` (the upload catalog, with a partial unique index keeping one primary
resume per profile), the `semantic*` columns on `jobs`, and `outbox_events`.

### The upload and retrieval flow

The RAG service is called by the job agent over `/internal/*`; nothing in the
browser ever talks to it, so its HMAC secret and bucket credentials stay
server-side.

```
browser ──POST /documents──▶ job agent ──presign──▶ RAG service
                                                            │
                              ┌─────────────────────────────┴──────┐
                    S3 mode                                  local mode
                              │                                    │
        browser ──PUT bytes──▶ bucket              browser ──PUT /documents/:id/content──▶ job agent
                                                            │  (raw bytes, max 10 MB)     │
                                                            └────────relay (HMAC)────────▶ RAG service
                                                                                             │
   RAG service: extract ─▶ chunk ─▶ embed ─▶ upsert vectors ─▶ documents.indexed ──────────┘
                                                                                             ▼
                                                            job agent: documents.status = ready | failed
   job agent: jobs.raw ─▶ insert job + outbox(events) ─▶ relay ─▶ jobs.index ─▶ RAG
                                                        └──────▶ jobs.new ─▶ LLM score
   run ends ─▶ rankRunSemantically ─▶ POST /internal/search { documentIds, queryText, roleQueries, runId }
              ─▶ writes semanticScore / semanticSnippet / semanticRank on each job
```

**Two upload modes, one status path.** In S3 mode the browser PUTs the bytes
straight to the bucket with a presigned URL and then calls
`POST /documents/:id/complete`, which is the signal to start indexing. With no
bucket configured, the browser sends the bytes to the API, which relays them to
the RAG service over HMAC; there indexing happens inline because the caller is
watching. Either way the outcome arrives on `documents.indexed`, so the catalog's
status does not depend on which mode was used.

**Documents are a query source, not just an upload.** A search sends
`documentIds` rather than document text: the extracted text was stored next to
the vectors at index time, and re-parsing a PDF on the latency-sensitive search
path would be absurd. Queries are fused — the user's documents first, then the
profile's plain-text resume and skills, then the roles they are targeting — and
RRF merges the ranked lists by `jobId`.

**`semanticScore` is not `matchScore`.** The LLM's 0–100 verdict and the vector
similarity are stored in separate columns and never blended. They disagree often
and informatively: a high vector score with a low LLM score is usually a keyword
match in a job the user would not want. A single averaged number would destroy
exactly the information the user needs. The UI shows them as distinct badges, and
`semanticScore` is rendered as a percentage of similarity rather than on the
LLM's 0–100 scale.

**Ranking is best effort and idempotent.** At the end of a run the workflow waits
for the run's postings to stop arriving, then searches; if the vector store is
still catching up it retries a couple of times rather than reporting "no matches"
for a run that had some. Anything still unscored is counted in `skipped` and
filled in by a later run, or by the per-run **Re-rank** button in the UI.

### Reliability: events are written with the row they describe

`jobs.raw` inserts a job row and then needs to publish two events for it. Doing
both inline left a window where the row existed but a publish had failed — the
consumer had been told the message was handled, so nothing would ever score or
index that job, and it would sit in the list with a null score forever.

So the insert and the two `outbox_events` rows commit in one transaction, and a
relay in the API process publishes them within half a second, marking each row
sent only after the broker accepts it. A failed publish stays unpublished and is
retried on the next pass. Delivery is at-least-once, which both consumers already
tolerate: the RAG service upserts by `jobId`, and the scoring handler returns
early on a job that already has a score.

### Still to come

Nothing on the upload → index → rank → display path. Not yet done, in rough
priority order: true cloud verification (Fireworks/Pinecone/S3 have never been run
against live credentials, only their fallbacks), a proper
`documents.indexed` backfill for documents indexed before this table existed,
and pagination on the jobs list.

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
