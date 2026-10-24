# job-agent — Interview Prep

> Read this top to bottom once. Then use the **Q&A** and **Numbers to memorise** sections
> the morning of the interview.

---

## 1. The 60-second pitch

> "job-agent is a job-search agent. On a schedule it crawls several job boards, filters and
> dedupes the postings, has an LLM score every one against my resume, and then uses a RAG
> service to rank them by **semantic** similarity to my resume. It's a monorepo with four
> apps — a NestJS API, a Temporal worker, a separate Python-less NestJS RAG microservice, and
> a React dashboard — glued together with Kafka and Temporal."

If they only remember three things:
1. **Temporal** owns the schedule and the fan-out to job boards.
2. **Kafka** owns the asynchronous fan-in: filter → store → score → index.
3. **A separate RAG service** does embeddings and vector search, kept out of the main API so
   heavy PDF/embedding work can't take down the job pipeline.

**One sentence on the architecture:** *"Temporal is the orchestrator, Kafka is the event bus,
Postgres is the system of record, Pinecone is the retrieval index, and every external AI
dependency is behind a port with a no-credential local fallback."*

---

## 2. Problem it solves + use cases

**Problem:** Job hunting means manually checking many boards, reading hundreds of irrelevant
postings, and guessing which ones actually fit you. Doing that daily is tedious and
error-prone.

**Use cases the app actually implements:**

| Use case | How it works |
| --- | --- |
| **Daily automated search** | Temporal cron (`0 10 * * *`, Asia/Kolkata) runs `dailyJobSearchWorkflow` for every active profile. |
| **On-demand search** | `POST /runs` ("Search now" button) starts the same workflow for one profile. |
| **Multi-board aggregation** | Four sources: JSearch (Google-for-Jobs), Adzuna, Remotive, Greenhouse; a source with no key is skipped silently. |
| **Noise removal** | Freshness check, excluded companies/keywords, remote-only, and a SHA-1 dedupe hash so the same job from two boards is stored once. |
| **AI fit scoring** | LLM returns a 0–100 score, a reason, up to 3 highlights and 3 red flags per job. |
| **Semantic matching (RAG)** | Jobs and the resume are embedded into one vector space; multi-query search with Reciprocal Rank Fusion ranks by meaning, not keywords. |
| **Resume parsing** | Upload a PDF/DOCX/TXT/MD resume; text is extracted, parsed by an LLM into structured fields, and prefills the profile. |
| **Pipeline tracking** | `search_runs` records each run with per-source counts and a status (running/completed/partial/failed). |
| **Job triage UI** | Dashboard to sort by score or semantic score, filter, and mark saved/applied/ignored. |
| **Admin observability** | Admin-only overview of source health and AI provider failover state. |

---

## 3. Repository / architecture map

```
job-agent/
├── apps/
│   ├── job-agent/     NestJS API + Kafka consumers + Temporal worker (one codebase, two processes)
│   ├── rag-service/   NestJS: document extraction, embeddings, vector search (separate process)
│   └── web/           Vite + React 19 + Tailwind 4 + TanStack Query dashboard
├── packages/
│   ├── shared/        Types, Kafka topic names, event contracts, zod schemas, HMAC helper
│   └── ai/            Provider-agnostic LLM + embedding layer (OpenAI-compatible, fallback chain)
├── deploy/            pm2 process definitions (4 processes)
├── docker-compose.yml Postgres, Kafka, Temporal, Temporal UI
├── turbo.json         Task graph + caching
└── .env               ONE env file shared by every app
```

**The four runtime processes (pm2 in prod):**

| Process | Entry | Role |
| --- | --- | --- |
| `job-agent-api` | `dist/main.js` | HTTP API **and** Kafka consumers (hybrid microservice), `:3000` |
| `job-agent-worker` | `dist/temporal/worker.js` | Temporal activity worker (polls `job-search` queue) |
| `rag-service` | `dist/main.js` | HTTP `/internal/*` + Kafka indexing consumer, `:3001` |
| `job-agent-web` | `vite preview` | Serves built SPA and proxies `/api` to the API |

**Two-process split inside `apps/job-agent`:** same code and DB, but `dev:api` serves HTTP and
runs Kafka consumers, while `dev:worker` runs a Nest application context that only polls
Temporal. Reason: **LLM scoring never competes with workflow polling for the event loop, and
either side restarts without killing the other.**

---

## 4. Tech stack — and WHY each choice

### Core

| Tech | Version | Why this choice |
| --- | --- | --- |
| **TypeScript** | 6 | One language across API, worker, RAG, web, and shared contracts — a contract change is a compile error, not a runtime `any`. |
| **pnpm workspaces** | 11 | Fast, disk-efficient, strict dependency isolation; workspace protocol (`workspace:*`) links `@job-agent/shared` and `@job-agent/ai` directly. |
| **Turborepo** | 2 | Task graph + caching across the monorepo. `build` `dependsOn: ["^build"]` so packages build before apps. `dev`/`dev:worker` are persistent, uncached. |
| **Node** | ≥22 (prod 24) | Modern ESM, native fetch, native `node:crypto`. `"type": "module"` everywhere. |

### Backend / orchestration

| Tech | Why |
| --- | --- |
| **NestJS 12** | DI, modules, guards, pipes. First-class support for **hybrid apps** (`connectMicroservice`) — one process serves HTTP *and* Kafka. `@nestjs/microservices` plus `@EventPattern` makes the Kafka consumers declarative. |
| **Temporal** | Durable workflow engine. A multi-minute, multi-source, partially-failing search is exactly what you want persisted and resumable. Built-in retries with exponential backoff, cron scheduling, and `Promise.allSettled` fan-out. |
| **Kafka (kafkajs)** | Durable, ordered, replayable event log. Decouples "fetch" from "filter/score/index" so a slow LLM never blocks a crawl. Consumer groups let API replicas share load. |
| **Postgres 16 + TypeORM** | Relational data with strong constraints: the `(profileId, dedupeHash)` unique index is what makes ingestion idempotent. `jsonb` for flexible preferences. Migrations for prod (`DB_SYNC=false`). |
| **Zod** | Runtime validation at trust boundaries: LLM output, internal RAG request bodies. TypeScript types can't validate network input. |
| **Vitest** | Fast, ESM-native test runner. Specs live next to the code they test. |
| **oxlint** | Fast Rust linter; a much smaller dependency than ESLint. |

### AI layer (`packages/ai`)

| Tech | Why |
| --- | --- |
| **Provider descriptors as data** | Each provider (OpenRouter, NVIDIA, Mistral, Ollama, generic OpenAI-compatible) is declared as a data object: base URL, default model, key env vars, batch caps, structured-output support. Adding a provider = adding a descriptor, no call-site `if (provider === ...)`. |
| **`FallbackChatModel` decorator** | Fails over to a second provider on *provider-specific* failures only (429, 402 out-of-quota, 5xx). A 401/400 doesn't fail over because every provider would reject it the same way. After a failover the primary is **parked for 60s** then retried — a cooldown is a suspicion, not a verdict. |
| **Constrained decoding** | Sends a JSON schema to the provider so the model *cannot* emit prose, then validates again with Zod as the last word. |
| **Embeddings via the same layer** | `openrouter`/`mistral` produce 1024-d vectors; `offline` is a deterministic hashed bag-of-words (384-d) for tests with zero credentials. |

### RAG service

| Tech | Why |
| --- | --- |
| **NestJS (separate process)** | PDF extraction and batched embedding are slow and memory-hungry. A restart/OOM on the retrieval path must not take the job pipeline down. Scales on a different axis (bursty indexing vs. latency-sensitive search). Higher pm2 memory limit (768M). |
| **Pinecone** | Managed vector DB, no infra to run, namespaces for per-user isolation. |
| **`pdf-parse` + `mammoth`** | Extract text from PDF and DOCX. Loaded lazily (dynamic `import()`) so boot stays light when users mostly upload text. |
| **S3 (`@aws-sdk`)** | Object storage with **presigned URLs** so document bytes go browser → bucket directly, never through the API. |
| **Ports & adapters** | Every external dep is an interface with a real adapter and a local fallback (Pinecone/memory, S3/local, cloud/offline embeddings), selected by env. The whole flow is testable with zero credentials. |

### Frontend

| Tech | Why |
| --- | --- |
| **React 19 + Vite 8** | Fast dev server with HMR; simple SPA. |
| **TanStack Query 5** | Server state is the real state. Built-in polling (`refetchInterval`) handles the fact that scores arrive asynchronously seconds after the list loads. Optimistic updates for status changes. |
| **react-router 7** | Standard client-side routing with a `ProtectedRoute` wrapper. |
| **Tailwind 4** | Utility CSS, no separate stylesheet build. Via `@tailwindcss/vite`. |

### Infra / DevOps

- **Docker Compose** for local Postgres, Kafka (KRaft, no ZooKeeper), Temporal + Temporal UI.
- **GitHub Actions**: `ci.yml` (format, typecheck, lint, test, build on every push/PR) and
  `cd.yml` (rsync source + `pnpm install && build` + pm2 reload on the deploy host).
- **Source ships, not `node_modules`** — native modules (`@temporalio/core-bridge`, `@swc/core`)
  must be built for the target's CPU/OS.

---

## 5. End-to-end flow (walk the interviewer through this)

### Flow A — Daily / on-demand job search

```
Temporal schedule (cron 10:00 IST)   ──or──   POST /runs  ("Search now")
        │
        ▼
  dailyJobSearchWorkflow
    1. listActiveProfileIds()                    (all profiles, or one)
    2. startRun()          → inserts search_runs row, status=running
    3. listSourcesFor()    → enabled sources for the profile
    4. Promise.allSettled( fetchAndPublish × N ) → per-source, in parallel
         - each activity fetches a board and publishes RawJobEvent per posting
         - returns only { fetched: count }  → tiny Temporal history
         - a dead board cannot fail the run (allSettled)
    5. finishRun(stats)    → status = completed | partial | failed
    6. rankRunSemantically() → best-effort, failure never fails the run
        │
        ▼  RawJobEvent keys by profileId
   ╔════════════╗
   ║  jobs.raw  ║
   ╚═════╤══════╝
        ▼  API process Kafka consumer (group: job-pipeline)
   1. isFresh(postedAt, postedWithinDays)
   2. hardFilter(job, prefs)  → excluded company/keyword, remote-only
   3. insertIfNew()           → SHA-1 dedupe hash + unique index + `.orIgnore()`
      └─ INSERT job row + 2 outbox_events rows IN ONE TRANSACTION
        │
        ▼  new rows only
   ╔════════════╗                    outbox relay (every 500ms) publishes:
   ║  jobs.new  ║  ──────────────▶   - jobs.new   (score me)
   ╚═════╤══════╝                    - jobs.index (embed me)
        ▼
   ScorerService → LLM (structured output, Zod-validated)
   saveScore(score, reason, highlights, redFlags, scoredAt)
        │
        ▼
   ╔═════════════╗     ╔═══════════╗
   ║ jobs.scored ║     ║  web UI   ║  (polls until matchScore is non-null)
   ╚═════════════╝     ╚═══════════╝
        │
   any failure at any stage ──▶ ╔════════════╗
                                ║  jobs.dlq  ║  (partition keeps moving)
                                ╚════════════╝
```

### Flow B — Resume upload + semantic ranking (RAG)

```
Browser ──POST /profile/resume (multipart)──▶ job-agent API
   - validate: MIME + extension + max 10 MB
   - relay bytes (HMAC-signed) ──▶ rag-service /internal/resumes
        rag: store in S3/local → extract text → return text + objectKey
   - ResumeParserService sends text to the LLM → structured ResumeData
   - prefill profile (skills/locations unioned; roles only if empty)
   - persist resumeText + parsed data on the profile
   - response includes parsed fields → nothing to poll

Job indexing (async, from Flow A):
   jobs.index event ──▶ rag-service Kafka consumer
     build text ("Role: ... Company: ... + description")
     → chunk (900 chars, 150 overlap) → embed → upsert vectors
     vector id: job:<jobId>:<chunk>   (deterministic → re-index = overwrite)
     namespace: user-<profileId>      (per-user isolation)

End of a run:
   rankRunSemantically
     - wait for the run's postings to settle (count stops growing AND all scored)
     - build queries: resume text + skills, then one query per wanted role
     - POST /internal/search (HMAC-signed) with documentIds/queryText/roleQueries
     - rag embeds ALL queries in one batch, queries Pinecone per query
     - RRF (k=60) fuses ranked lists BY jobId (not object identity)
     - only the head (top 10) of each list is evidence
     - score = best similarity (NOT the flat RRF score)
     - API writes semanticScore / semanticSnippet / semanticRank onto each job
```

**Two independent scores, never blended:**
- `matchScore` (0–100) = the LLM's considered verdict on whether you should apply.
- `semanticScore` (0–1) = raw vector similarity to your resume.
They disagree informatively: high semantic + low LLM usually means a keyword match you
wouldn't want. Averaging them would destroy the useful signal.

---

## 6. Data model (the tables that matter)

| Table | Purpose | Key constraints |
| --- | --- | --- |
| `users` | Auth accounts | unique email, `scrypt` password hash |
| `refresh_tokens` | Revocable sessions | SHA-256 of token stored; `revokedAt` |
| `profiles` | Unit of data isolation; owns preferences + resume | 1:1 with user; FK `userId` |
| `jobs` | One posting | **unique `(profileId, dedupeHash)`**; indexes on `(profileId,status,matchScore)` and `(profileId,semanticScore)` |
| `search_runs` | One workflow run | status enum, jsonb per-source stats |
| `outbox_events` | Transactional outbox for Kafka | `publishedAt` null = pending, `attempts`, `lastError` |
| `rag_documents` | Owned by the RAG service | deliberately **not** shared with job-agent |

> **Why not share tables between services?** Two services owning one table means one
> service's `migration:revert` drops the other's data. The RAG service owns its own schema.

---

## 7. The "why" decisions (these are the interview gold)

Memorise the **decision → reason → trade-off** shape for each.

1. **Temporal vs. plain cron + a script**
   A run touches multiple external APIs, some fail, and it can take minutes. Temporal gives
   durable state, automatic retries with backoff, and a fan-out that survives a worker
   restart. The workflow returns only counts, so job payloads never bloat workflow history.

2. **Kafka vs. doing it all in the worker**
   Fetching and scoring have wildly different latencies. Kafka decouples them: a slow LLM
   (or a 429) can't slow down the crawl, and each stage can be retried independently.
   One consumer per group, ordered by `profileId` key.

3. **Transactional outbox**
   Originally: insert the job, then publish two Kafka events inline. A crash between them
   left a row with a null score forever — the broker had already acked the `jobs.raw`
   message, so nothing would ever retry. Fix: **insert the job and its outbox events in one
   transaction**; a relay publishes them every 500ms and only marks them sent after the
   broker accepts. Cost: at-least-once delivery — which both consumers already tolerate.

4. **Idempotency everywhere**
   `jobs.raw` is idempotent via the unique dedupe index + `.orIgnore()`. `jobs.new` returns
   early if `scoredAt` is set. RAG upserts by deterministic vector id. A redelivered message
   is harmless.

5. **DLQ per stage**
   Each consumer catches its own errors and routes them to `jobs.dlq`, so one poison message
   can't block a Kafka partition. `scoreError` is stored on the row so it's diagnosable from
   the list.

6. **Dedupe by content, not by source id**
   `sha1(profileId|company|title|location)`, normalized. The same job posted on two boards
   is stored once even though each board gives a different `externalId`.

7. **Separate RAG process**
   PDF extraction and batched embedding are slow and memory-hungry, and index/search scale on
   different axes. Isolation means an OOM there doesn't kill the job pipeline.

8. **Ports & adapters with real fallbacks**
   Pinecone/memory, S3/local, cloud/offline embeddings. The whole pipeline runs and is
   testable with zero credentials and no network. The service reports `degraded: true` so a
   lexical-only result is never mistaken for a semantic one.

9. **RRF keyed by `jobId`, and only the head counts**
   Each query returns a different object for the same posting, so fusion must key on a stable
   id or it returns duplicates. A vector store always returns k neighbours, so letting the
   tail vote would credit every job to every query — only the top 10 of each list is evidence.

10. **`score` is best similarity, not the fused rank**
    RRF scores are `1/(60+rank)` and nearly flat; reporting them as match strength would show
    ~0.98 for a barely-matching job. Order comes from RRF, strength comes from real similarity.

11. **Chunking (900 chars, 150 overlap)**
    One vector for a whole resume is an average that matches everything weakly. Overlap keeps
    "5+ years of Kubernetes" intact across a split. Chunking is the step that most quietly
    ruins RAG.

12. **Two processes, one codebase**
    `dev:api` and `dev:worker` from the same source — sharing all services, migrations, and
    types, but isolated at runtime for the event loop.

---

## 8. Authentication & security (memorise)

- **Access token**: 15-minute JWT with `sub`, `email`, `pid` (profile id) — stateless, so the
  common path needs no extra profile lookup.
- **Refresh token**: 30-day JWT whose SHA-256 is stored in `refresh_tokens` — that table is
  what makes sessions revocable; a bare JWT could not be withdrawn.
- Both tagged with `typ`, so a refresh token can never be used as a bearer token.
- **Rotation with reuse detection**: refreshing issues a new pair and revokes the presented
  token. Presenting an already-consumed token is treated as theft → revoke **all** sessions
  for that user (OAuth security BCP trade-off).
- **Passwords**: `node:crypto` scrypt, N=16384 r=8 p=1, stored as `scrypt$N$r$p$salt$hash`
  so cost can be raised later. No native dependency. Login returns the same error for unknown
  email and wrong password (no account enumeration).
- **Guard placement**: `@UseGuards(JwtAuthGuard)` per controller, NOT global — because
  `JobPipelineController` is also a Kafka provider where a global guard would run with no
  request and fail every event.
- **Ownership scoping**: HTTP always uses `getOwnedById(id, profileId)` so a guessed id is a
  404, not a read. `getById(id)` is only for the Kafka pipeline, which has no user.
- **Internal RAG auth**: `/internal/*` is service-to-service, protected by
  `x-internal-token` = HMAC-SHA256 of `METHOD:path` keyed by `RAG_INTERNAL_SECRET`, compared in
  constant time. Signing the path means a token for one route can't be replayed on another.
  The service refuses to boot if the secret is missing or under 32 chars.
- **Secrets stay server-side**: the browser never talks to the RAG service, and `VITE_`-prefixed
  vars are the only thing that reaches the bundle (secrets must never be prefixed `VITE_`).

---

## 9. Testing & CI/CD

- **Vitest** unit specs live next to source (`auth.service.spec.ts`, `filters`, `scorer`,
  `chunker`, `fallback`, `outbox-relay`, etc.) plus an e2e suite.
- **CI** (`ci.yml`): format check, typecheck, lint, test, build on every push to `main` and
  every PR. Uses `--frozen-lockfile` and caches `.turbo`.
- **CD** (`cd.yml`): rsync source (not `node_modules`) to one host, run `pnpm install &&
  pnpm build`, then `pm2 startOrReload --update-env`, then poll `/api/runs` to confirm the
  new build is live. The host's `.env` is excluded from the sync so secrets survive.
- **Prod migrations**: `DB_SYNC=false`, so the deploy runs `pnpm --filter job-agent
  migration:run` explicitly.

---

## 10. Likely interview questions & crisp answers

**Q: Walk me through the architecture.**
See section 5. Keep it to Temporal (schedule + fan-out) → Kafka (fan-in: filter → score →
index) → RAG service (semantic rank). Mention Postgres as system of record and the two-process
split.

**Q: Why Temporal *and* Kafka? Isn't that two orchestrators?**
No. They do different jobs. Temporal is the *imperative, stateful* orchestration of one run
(sequence, retries, fan-out). Kafka is the *durable event bus* between decoupled stages and
the hook for future consumers (notifications, websockets). Temporal coordinates; Kafka
transports.

**Q: What happens if a job board API is down?**
`Promise.allSettled` means the other sources still complete. The run ends as `partial` and
stores the per-source error. Retries use exponential backoff (4 attempts, 2× coefficient).
JSearch additionally self-disables for the process life on a 401/403 (a RapidAPI key not
subscribed to that API), so it doesn't fail the workflow on every run.

**Q: How do you avoid duplicate jobs?**
SHA-1 hash of normalized `profileId|company|title|location`, stored as `dedupeHash` with a
unique `(profileId, dedupeHash)` index, and the insert uses `.orIgnore()`. Same job from two
boards → one row.

**Q: What if Kafka is down when a job is inserted?**
The job row and its two outbox event rows commit in the same transaction, so the job is
never "handled but unsent". The relay retries on the next 500ms tick. Delivery is
at-least-once and every consumer is idempotent.

**Q: How do you stop a poison message from blocking everything?**
Every stage wraps its work in try/catch and routes failures to `jobs.dlq`, acknowledging the
original so the partition advances.

**Q: Why is semantic score separate from the LLM score?**
They measure different things and disagree usefully. The LLM is a considered verdict; the
vector score is a cheap similarity to the resume. Blending them would hide the disagreement
the user needs to see. UI shows them as distinct badges.

**Q: Why RRF instead of just picking the highest cosine score?**
Because you query multiple times (one per wanted role) and cosine scores from different queries
aren't on a common scale. RRF merges by *rank*, which is comparable. We then attach the best
real similarity as `score`.

**Q: Why is `jobId` the fusion key?**
Each query returns a different object instance for the same posting; fusing on object identity
would treat them as distinct and return duplicates.

**Q: What does "degraded" mean?**
The RAG service is running on local fallbacks (offline embeddings and/or in-memory vectors).
Results are lexical, not semantic. Surfaced on boot, in every search response, and on
`/health`, so a lexical result is never mistaken for a real semantic one.

**Q: How do you handle LLM rate limits?**
Two layers: a retry loop with backoff inside the HTTP adapter for short 429s, and a
`FallbackChatModel` that fails over to a second provider (OpenRouter → NVIDIA, same model
weights) for provider-specific failures (402 out-of-quota, 429, 5xx). The primary is then
parked for 60s and retried, so a recovered provider returns on its own.

**Q: Why did you choose OpenRouter?**
One key and one OpenAI-compatible base URL covers scoring, resume parsing, and embeddings,
including a `:free` chat tier. The default model is the one free model that reliably honoured
`response_format: json_schema`, which the scorer depends on.

**Q: How is a resume turned into search?**
It's uploaded once (stored in the object store, text extracted and parsed synchronously),
then the extracted text is a **query source** — we never re-parse a PDF on the search path.
Queries are: resume text (+ skills), then one per wanted role, all fused with RRF.

**Q: How do you guarantee ordering?**
Kafka messages are keyed by `profileId`, so all events for one profile land on one partition
and are processed in order. Outbox rows are drained oldest-first.

**Q: How would you scale this?**
Horizontally scale the API (same Kafka consumer group shares partitions), scale RAG
independently, and move the outbox relay / consumers to dedicated workers if throughput
demands. Pinecone scales separately. The two-process split already isolates the heaviest
paths.

**Q: Tell me about a bug you hit and how you fixed it.**
Pick the **outbox story**: inline publishing after insert left a window where a job row
existed but its `jobs.new`/`jobs.index` events were lost — the broker had already acked, so
the job sat with a null score forever. Solved with the transactional outbox + relay. Great
answer because it shows you think about failure windows.

**Q: What's not done / what would you improve?**
- True cloud verification: Fireworks/Pinecone/S3 have only run against their fallbacks in this
  environment, not live credentials.
- Pagination on the jobs list.
- Ledger of `jobs.scored` / `jobs.dlq` consumers (currently emitted but unconsumed — the hook
  for notifications / a websocket feed).
- A `documents.indexed` backfill.

---

## 11. Numbers to memorise

| Thing | Value |
| --- | --- |
| Access token TTL / Refresh token TTL | 15 min / 30 days |
| scrypt params | N=16384, r=8, p=1 |
| Kafka topics | `jobs.raw`, `jobs.new`, `jobs.scored`, `jobs.dlq`, `jobs.index` |
| Consumer group | `job-pipeline` |
| Temporal task queue / schedule | `job-search` / `daily-job-search` |
| Cron / timezone | `0 10 * * *` / `Asia/Kolkata` |
| Outbox relay interval / batch | 500 ms / 50 |
| LLM score range / temperature | 0–100 / 0.3 |
| Provider failover cooldown | 60 s |
| Chunk size / overlap | 900 chars / 150 |
| RRF k / match depth / candidates per query | 60 / 10 / 50 |
| Default search topK | 20 (rank-all uses 200) |
| Vector dimensions | 1024 (openrouter/mistral), 384 (offline) |
| Namespace / vector id | `user-<profileId>` / `<kind>:<id>:<chunk>` |
| Max document size | 10 MB |
| RAG request timeout / drain wait | 15 s / 45 s |
| Job sources | jsearch, adzuna, remotive, greenhouse |

---

## 12. Terms to be able to define on the spot

- **Transactional outbox** — write domain state + events in one DB transaction, publish later.
- **At-least-once delivery** — messages may be redelivered; consumers must be idempotent.
- **Idempotency** — processing the same message twice has the same effect as once.
- **Dead-letter queue (DLQ)** — where failed messages go so the main stream keeps flowing.
- **Reciprocal Rank Fusion (RRF)** — merging ranked lists by rank position, not raw score.
- **Hybrid microservice (Nest)** — one app serving HTTP *and* a message transport.
- **Ports & adapters** — interfaces (ports) with swappable implementations (adapters).
- **Doc chunking / overlap** — splitting text for embedding while keeping context across splits.
- **Degraded mode** — running on local fallbacks, results are not the real semantic model.
- **Optimistic update** — update the UI immediately, roll back if the request fails.
- **Structured output / constrained decoding** — forcing an LLM to emit JSON matching a schema.

---

# 13. Master checklist (your list, with answers)

> Tick each box once you can say the answer out loud without reading it.

## 13.1 Project implementation

### Job-source ingestion and data normalization
- [ ] **Explanation:** Four sources implement one `JobSource` interface — `name`,
      `isEnabled(profile)`, `fetch(profile) => RawJob[]` (`job-source.interface.ts`). The
      registry (`sources.registry.ts`) filters to enabled sources, then the Temporal activity
      calls `fetch` and publishes.
- [ ] **Normalization:** every board's different JSON is mapped to one `RawJob` shape
      (`externalId, title, company, location[], remote, salaryText, description, applyUrl,
      postedAt`). HTML is stripped with `stripHtml()` (removes `<script>/<style>`, tags, entities,
      caps at 6000 chars). Salary is flattened to a display string per source.
- [ ] **Robustness details worth mentioning:** `getJson()` carries the HTTP status in
      `SourceHttpError`; a 401/403 (bad/per-API key) **disables that source for the process life**
      so Temporal doesn't retry a permanently-broken credential. `broadenings()` progressively
      loosens a query (drop `(gloss)`, then drop location) because resume-derived role/location
      strings are too literal for boards. `searchQueries()` caps role × location combos to limit
      API calls. Greenhouse filters titles with `looksRelevant()`.

### PostgreSQL schema and job deduplication/content hash
- [ ] **Hash:** `dedupeHash = sha1(profileId | norm(company) | norm(title) | norm(location))`,
      where `norm` lowercases and strips non-alphanumerics (`filters.ts:dedupeHash`).
- [ ] **Constraint:** unique index `uq_jobs_profile_dedupe` on `(profileId, dedupeHash)`.
- [ ] **Idempotent insert:** `.insert().orIgnore().returning('id')` — a duplicate yields no id,
      so the consumer returns early and no events fire.
- [ ] **Why content, not `externalId`:** the same posting appears on multiple boards with
      different ids; hashing normalized content dedupes across sources. Scoped to `profileId`
      so two users can each have their own copy.
- [ ] **Why SHA-1:** it's a dedupe key, not a security primitive — speed and short length matter,
      collision risk is negligible for this.

### Where Kafka is used and what messages/events it carries
- [ ] **Topics (`packages/shared/src/topics.ts`):**
  - `jobs.raw` — `RawJobEvent { runId, profileId, source, job }`, published by the Temporal
    activity, keyed by `profileId`.
  - `jobs.new` — `NewJobEvent { jobId, profileId }`, a posting stored and awaiting a score.
  - `jobs.scored` — `ScoredJobEvent { jobId, profileId, score }`, emitted after scoring
    (**not consumed yet** — hook for notifications/websockets).
  - `jobs.dlq` — `DlqEvent { stage, error, payload }`, any stage's failure.
  - `jobs.index` — `JobIndexEvent` carrying the text fields to embed, consumed by the RAG
    service so it never touches the jobs table.
- [ ] **Producers:** the Temporal worker/activities and the API (via the outbox relay).
- [ ] **Consumers:** the API process (hybrid microservice, group `job-pipeline`) consumes
      `jobs.raw` + `jobs.new`; the RAG service consumes `jobs.index`.
- [ ] **Ordering:** messages are keyed by `profileId`, so all events for one profile land on
      one partition and stay ordered.
- [ ] **Why Kafka here:** decouples fetch (network, slow) from score (LLM, slower) from index
      (embeddings, slowest); each stage retries independently and a slow stage never blocks the
      crawl.

### What Temporal orchestrates and how retries work
- [ ] **Orchestrates:** `dailyJobSearchWorkflow` (`workflows.ts`). Per profile: `startRun` →
      `listSourcesFor` → `fetchAndPublish` per source in parallel → `finishRun` →
      `rankRunSemantically`.
- [ ] **Schedule:** registered idempotently by the worker on boot — `daily-job-search`, cron
      `0 10 * * *` Asia/Kolkata, overlap `SKIP`, `catchupWindow: 3 minutes`, `pauseOnFailure: false`.
- [ ] **Fan-out:** `Promise.allSettled` — one dead board never fails the run.
- [ ] **Activties are real I/O; workflows are deterministic** — the workflow sandbox can only
      import from `@temporalio/workflow`.
- [ ] **Retry policies (per activity proxy):**
  - `quick` (DB): 1 min timeout, 3 attempts.
  - `fetcher` (external APIs): 5 min timeout, 4 attempts, exponential backoff
    (initial 10s, coefficient 2, max interval 2 min).
  - `ranker`: 3 min timeout, **1 attempt** — repeating would re-run a search that was merely
    late.
- [ ] **History stays small:** activities return only `{ fetched: count }`, so job payloads
      never enter workflow history.
- [ ] **Manual runs:** `POST /runs` → `TemporalClientService.startRun()`, workflow id
      `manual-<profileId>-<timestamp>`.

### Resume text processing
- [ ] **Intake:** `POST /profile/resume` (multipart) → validate MIME (`isAllowedDocumentMime`),
      extension, ≤ 10 MB.
- [ ] **Storage + extraction:** the API relays bytes (HMAC-signed) to the RAG service, which
      stores the file (S3 presigned in prod / local disk in dev) and extracts text
      (`text-extractor.service.ts`): **sniffs magic bytes first** (`%PDF-`, `PK\x03\x04` for
      DOCX), falls back to extension. `pdf-parse` / `mammoth` loaded lazily. Text is normalized
      (NBSP, runs of spaces, blank lines), capped at 2M chars.
- [ ] **Parsing:** `ResumeParserService` sends the text to the LLM with `RESUME_RESPONSE_SCHEMA`
      (constrained decoding), temperature 0.1, max 4096 tokens, Zod-validated into `ResumeData`
      (fullName, email, skills, roles, experience[], education[], yearsOfExperience, links).
- [ ] **Persistence + prefill:** `resumeText` is saved **before** the LLM call, so a parse
      failure costs the fields, not the resume. `prefill()` unions skills/locations (never
      destroys hand-typed values) and seeds roles **only if empty** (roles are intent, which a
      past-CV can't know).
- [ ] **One synchronous request:** store → extract → parse → prefill, then respond — nothing to
      poll.

### Embedding generation and vector search
- [ ] **Embedding port (`ports.ts`):** production = OpenRouter `text-embedding-3-small`
      (1024-d, accepts `dimensions`) or Mistral `mistral-embed` (1024-d); local = `offline`
      deterministic hashed bag-of-words (384-d). Selected by `EMBEDDING_PROVIDER` /
      descriptor / credential presence.
- [ ] **Dimension check at boot:** `PINECONE_DIMENSIONS` must equal the model's width, or the
      service throws loudly (otherwise it's a mysteriously empty index).
- [ ] **Chunking:** `chunkText()` — 900 chars, 150 overlap, paragraph-first then sentence then
      hard-wrap (avoids a tokenizer).
- [ ] **Vector ids:** deterministic `job:<jobId>:<chunk>`, so re-indexing overwrites in place.
- [ ] **Namespaces:** `user-<profileId>` — a missing filter is a hard failure to leak rather
      than a silent cross-user read.
- [ ] **Search:** embed all queries in one batch → query Pinecone per query (top 50 candidates,
      metadata filter `{ kind:'job', profileId, runId? }`) → **RRF (k=60)** fuses the lists by
      `jobId` → top 10 per list are evidence → `score` = best real similarity, `similarity` =
      average. Vector store = Pinecone (prod) / in-memory (dev).

### How the job-match score is calculated
- [ ] **LLM score (`ScorerService`):** prompt = candidate preferences + resume (first 8000
      chars) + job (title/company/location/remote/salary/description first 4000). System prompt
      gives a rubric (85–100 near-perfect, 65–84 good, 40–64 partial, 0–39 poor) and says be
      strict. Returns `{ score, reason, highlights[], redFlags[] }` via a JSON schema
      constraint, temperature 0.3, max 2048 tokens. Zod validates; score rounded, reason ≤ 300,
      highlights/redFlags ≤ 3 each. Saved as `matchScore`, `matchReason`, `highlights`,
      `redFlags`, `scoredAt`.
- [ ] **Semantic score (RAG):** vector similarity of the posting to the resume, 0–1, saved as
      `semanticScore` + `semanticSnippet` + `semanticRank`. **Never blended** with `matchScore`.
- [ ] **Show that you know the difference:** `matchScore` = LLM's verdict; `semanticScore` =
      meaning-similarity. They disagree usefully (keyword match you don't want).

### How matched skills and red flags are displayed
- [ ] **Job detail "AI match" section (`JobDetailPage.tsx`):** big score + qualitative label,
      the `reason` paragraph, then **Highlights** (green check items) and **Red flags** (red
      danger items) as bullet lists.
- [ ] **List/card (`JobCards.tsx`):** `ScoreBadge` (0–100), `SemanticBadge` (percentage + rank
      `#n`), status badge, `matchReason` (2 lines), the `semanticSnippet` as an italic quote, and
      a `scoring failed: …` line when `scoreError` is set.
- [ ] **Important nuance:** "matched skills" are the model's `highlights` (strengths it
      identified), **not** a computed set-intersection between profile skills and the posting.
      `redFlags` are the model's stated concerns (seniority mismatch, missing skill, low pay,
      onsite-only). The semantic snippet is the actual passage of the posting that matched, so
      the percentage has visible evidence behind it.
- [ ] **Pending states are explicit:** "scoring…" / "ranking…" while null, and TanStack Query
      polls every 3s until scores arrive.

## 13.2 AI concepts

### What are embeddings?
- [ ] A model maps text to a fixed-length vector (here 1024 numbers) where **similar meaning =
      nearby points**. They let you compare text mathematically. We embed both job postings and
      the resume **with the same model into the same space**, because comparing them is the whole
      point — two embedding spaces are not comparable.

### Semantic search vs keyword search
- [ ] **Keyword:** matches literal tokens (BM25/`ILIKE`). Fast, exact, but misses synonyms
      ("React" vs "ReactJS", "K8s" vs "Kubernetes") and matches irrelevant mentions.
- [ ] **Semantic:** matches by meaning via vectors, so it understands synonymy.
- [ ] **In this project:** the jobs list has a plain `ILIKE` text search, and the vector path is
      the semantic one. The `offline` fallback is lexical (hashed bag-of-words) and the service
      labels itself `degraded` so a lexical result is never mistaken for semantic.

### Cosine similarity
- [ ] The cosine of the angle between two vectors: `dot(a,b) / (|a||b|)`, in [-1, 1], and
      **independent of magnitude**. Since our vectors are L2-normalized, cosine = dot product.
      Near 1 = very similar, near 0 = unrelated. Pinecone returns this as the match score, which
      we clamp to 0–1 for the contract.

### What is a vector database?
- [ ] A datastore built for **approximate nearest-neighbour** search over high-dimensional
      vectors, with metadata filtering and namespaces. A normal index can't answer "nearest
      vector" efficiently. We use **Pinecone** in prod (managed, no infra) and an in-memory store
      in dev/test. Namespaces give per-user isolation.

### What is RAG? Does your actual implementation retrieve context and pass it to an LLM?
- [ ] **Be precise here — this is a trap question.** Classic RAG = *retrieve* relevant chunks →
      *stuff them into an LLM prompt* → generate an answer.
- [ ] **What this project actually does:** it **retrieves by vector similarity and uses the
      similarity as a ranking signal** (`semanticScore`). It does **not** feed the retrieved
      chunks into an LLM to synthesize an answer. The LLM is used in two *separate* places —
      scoring a job against the resume, and parsing a resume into fields — and in both, the
      retrieved evidence is the resume text provided directly, not vector-search output.
- [ ] **Honest framing:** "It's retrieval-augmented *ranking*, not retrieval-augmented
      *generation*. The vector store answers 'which postings are near this resume'; there is no
      generate step over retrieved context."
- [ ] **Extra credit:** the `SearchRequest` contract accepts `strategy: 'semantic' | 'hybrid'`,
      where `hybrid` is documented as "re-ranks the semantic hits with the LLM" — but the current
      `IngestionService.search()` does not branch on it, so **hybrid re-ranking is declared but
      not implemented.** Voluntarily pointing this out shows you know your own code.

### How do you evaluate matching quality?
- [ ] **Honest answer: there is no formal offline eval harness** (no labelled precision/recall
      set). What exists:
  - **Two independent signals** that cross-check each other (LLM vs vectors), so a bad result
    from one is visible against the other.
  - **Human feedback** in the UI — save / applied / ignored — which is the ground-truth signal
    a future eval could learn from.
  - **Explainability** — `reason`, `highlights`, `redFlags`, and the matched `semanticSnippet`
    let a human judge *why* a score was assigned.
  - **Deterministic tests** — the offline embedding is deterministic, so retrieval assertions in
    the test suite are meaningful.
- [ ] **What I'd add:** a labelled eval set + precision@k / nDCG, and offline replay of past
      runs to compare model or chunk-size changes.

### How do you handle an LLM/API error or rate limit?
- [ ] **Inside the adapter (`http.ts`):** retry on 429 with backoff; retry a truncated reply
      once with a larger token budget.
- [ ] **Across providers (`FallbackChatModel`):** fail over to the second provider only on
      provider-specific statuses `[402, 408, 409, 425, 429, 500, 502, 503, 504]`. A 400/401/403
      does **not** fail over (every provider would reject it identically). After a failover the
      primary is **parked for 60s**, then retried (a cooldown is a suspicion, not a verdict).
      Default chain: OpenRouter → NVIDIA **same model weights**, so failover costs latency only.
- [ ] **At the row level:** a scoring failure is stored as `scoreError` on the job (visible in
      the UI), routed to `jobs.dlq`, and retryable with the **Rescore** button. The job list and
      crawl are unaffected.
- [ ] **At boot:** a missing key does **not** stop the API from booting — it surfaces as a
      `scoreError` on the rows that needed scoring. Retrieval falls back to `offline` + `memory`
      and reports `degraded: true`.

## 13.3 Backend, database and reliability

### Main tables, columns, primary keys, foreign keys and indexes
- [ ] **users** — `id` PK (uuid), `email` unique, `passwordHash`, `createdAt`.
- [ ] **refresh_tokens** — `id` PK (= JWT `jti`), `userId` FK→users, `tokenHash` (SHA-256),
      `expiresAt`, `revokedAt`.
- [ ] **profiles** — `id` PK, `userId` FK→users (1:1), `name`, `preferences` jsonb, `isActive`,
      resume columns (`resumeText`, `resumeFileName`, `resumeMimeType`, `resumeSizeBytes`,
      `resumeObjectKey`, `resumeData` jsonb, `resumeParsedAt`, `resumeError`).
- [ ] **jobs** — `id` PK; `profileId` FK→profiles, `runId` FK→search_runs (nullable);
      `source`, `externalId`, `dedupeHash`; `title`, `company`, `location`, `remote`,
      `salaryText`, `description`, `applyUrl`, `postedAt`; LLM cols `matchScore`,
      `matchReason`, `highlights` jsonb, `redFlags` jsonb, `scoredAt`, `scoreError`; semantic
      cols `semanticScore` (real), `semanticSnippet`, `semanticRank`, `semanticAt`; `status`
      enum; timestamps. Indexes: unique `(profileId,dedupeHash)`,
      `(profileId,status,matchScore)`, `(profileId,semanticScore)`.
- [ ] **search_runs** — `id` PK, `profileId` FK, `workflowId`, `status` enum
      (running/completed/partial/failed), `stats` jsonb, `startedAt`, `finishedAt`.
- [ ] **outbox_events** — `id` PK, `topic`, `partitionKey`, `payload` jsonb, `publishedAt`
      (null = pending), `attempts`, `lastError`, `createdAt`.
- [ ] **rag_documents** — owned by the RAG service, **separate schema on purpose** so one
      service's `migration:revert` can't drop another's data.

### Why PostgreSQL?
- [ ] Strong relational constraints do real work: the unique `(profileId, dedupeHash)` index
      **is** the deduplication mechanism, and FKs keep ownership consistent.
- [ ] `jsonb` for flexible/partial fields (preferences, stats, outbox payload, resume data)
      without a schema migration per field.
- [ ] Transactions for the **outbox** (row + events atomically) — the property that makes the
      pipeline reliable doesn't exist in a plain KV store.
- [ ] Enums, partial/unique indexes, `NULLS LAST` ordering, `ILIKE` text search, and a mature
      migration tool (TypeORM) for prod.
- [ ] Boring, managed, cheap, and already needed for Temporal's own store.

### Kafka vs Temporal: what problem does each solve?
- [ ] **Temporal** = *orchestration*. One durable, resumable, retryable run with ordering and
      fan-out. It answers "do steps 1→5, retry API calls, survive a restart."
- [ ] **Kafka** = *transport / decoupling*. A durable event log so producers don't wait on
      consumers. It answers "hand this posting to whoever can filter/score/index it, without
      blocking the crawl, and let a new consumer subscribe later."
- [ ] **They compose:** Temporal starts the run and fans out fetches; each fetch **publishes** to
      Kafka; the async stages consume from Kafka. Temporal coordinates, Kafka transports.

### Retries, idempotency, dead-letter queues and duplicate processing
- [ ] **Retries:** Temporal activity retries with exponential backoff (per proxy as above); HTTP
      adapter retries 429/truncation; outbox relay retries unpublished rows every 500ms.
- [ ] **Idempotency:** unique dedupe index + `.orIgnore()` (`jobs.raw`); `if (job.scoredAt)
      return` (`jobs.new`); deterministic vector ids → upsert overwrites (RAG). So **every
      consumer tolerates a redelivery**.
- [ ] **DLQ:** each stage catches its own errors and emits to `jobs.dlq` instead of blocking the
      partition. Scoring errors are also persisted on the row.
- [ ] **Duplicate processing:** handled by the idempotency above; delivery is explicitly
      **at-least-once**, chosen because it's simpler and safer than trying to guarantee exactly
      once across a broker and a DB.

### Docker, Nginx, AWS S3 and CI/CD as actually implemented
- [ ] **Docker:** `docker-compose.yml` runs **local infrastructure only** — Postgres 16 (host
      `5433`), Kafka (`apache/kafka` KRaft, no ZooKeeper), Temporal `auto-setup` + Temporal UI.
      There are **no application Dockerfiles** — apps run as host processes (pnpm dev locally,
      pm2 in prod).
- [ ] **Nginx: not in this repository.** The web app is served by **`vite preview`**, whose
      `vite.config.ts` proxy rewrites `/api` → the Nest API, so the browser never deals with CORS
      or a second origin. An Nginx reverse proxy would be the conventional production choice but
      is **not implemented here** — say so plainly.
- [ ] **AWS S3:** implemented as the `S3ObjectStore` adapter (`@aws-sdk/client-s3` +
      `s3-request-presigner`). Uploads go **browser → bucket directly via a presigned PUT**, so
      bytes never transit the API. Stored with **SSE AES256**; downloads via presigned GET with
      `inline` disposition. Standard AWS credential chain; MinIO/LocalStack supported via
      `S3_ENDPOINT` + `S3_FORCE_PATH_STYLE`. **Caveat:** it has only been exercised against the
      `local` fallback in this environment, never live AWS credentials.
- [ ] **CI/CD:** GitHub Actions. `ci.yml` (push to `main`, PRs): install `--frozen-lockfile`,
      restore `.turbo` cache, then format-check → typecheck → lint → test → build. `cd.yml`
      (push to `main` / manual): rsync **source** (not `node_modules`) to one host, run
      `pnpm install && pnpm build` there (native modules must build for the host), then
      `pm2 startOrReload --update-env`, then poll `/api/runs` to confirm the new build is live.
      Prod uses `DB_SYNC=false` and runs `migration:run` explicitly. Secrets are environment
      variables/secrets, never in the repo.

### What is deployed, tested, mocked or still planned?
- [ ] **Deployed (built for prod):** all four pm2 processes (`job-agent-api`, `job-agent-worker`,
      `rag-service`, `job-agent-web`), TypeORM migrations, CI + CD workflows, Docker Compose for
      local infra.
- [ ] **Tested:** Vitest unit suites next to source — auth, password, admin guard, filters,
      scorer, pipeline controller, sources registry, JSearch source, semantic match, RAG client,
      outbox relay, chunker, ingestion, internal guard, memory vector store, the AI fallback
      layer — plus an e2e suite (`test/app.e2e-spec.ts`).
- [ ] **Mocked / fallback-only (never run against live cloud creds):** Fireworks/Pinecone/S3 —
      only their local equivalents (`offline` embeddings, `memory` store, `local` disk) have
      actually executed here. The RAG service reports `degraded: true` while on fallbacks.
- [ ] **Still planned:** true cloud verification with live credentials; pagination on the jobs
      list; consumers for `jobs.scored` / `jobs.dlq` (notifications / websocket feed); a
      `documents.indexed` backfill; the `hybrid` LLM re-rank strategy; a formal matching-quality
      eval harness.

---

## 14. Two-minute mock answer (say this if they open with "tell me about the project")

> "It's a job-search agent built as a TypeScript monorepo. A **Temporal** workflow runs daily
> or on demand, fanning out to four job boards in parallel and publishing each posting to a
> **Kafka** topic. An API process consumes those, filters them by freshness and preferences,
> dedupes with a content hash stored in **Postgres**, and emits a new event. The LLM scores
> each posting against my resume using a schema-constrained call with a provider fallback, and
> a modern **RAG service** embeds the postings and my resume into a **Pinecone** index so they
> can be ranked by semantic similarity with Reciprocal Rank Fusion. A **React** dashboard polls
> and shows both scores, the reason, highlights, red flags, and the matching passage. The
> reliability story is the interesting part: a transactional outbox so events are never lost, a
> dead-letter topic per stage, and idempotent consumers so at-least-once delivery is safe."
