# Deployment

How this application actually gets from `git push` to a URL people can use — what
the rest of the industry does, what we do today, and the step-by-step path onto AWS.

There are no secrets here that are not already in `.env.example`; this file is about
**shape and order of operations**.

> Current state: CI/CD runs in GitHub Actions and deploys to **one Linux host over
> SSH with rsync + PM2** (see `.github/workflows/cd.yml` and
> `deploy/ecosystem.config.cjs`). The rest of this file is the upgrade path from
> there to AWS. Nothing on AWS exists yet, and there are **no Dockerfiles in the
> repo** — Phase 1 adds them.

---

## 1. What has to be running

A deploy is not "start the server". This system is five deployable units plus a
data layer:

| Unit                | Entrypoint                                  | Port | Why it is separate              |
| ------------------- | ------------------------------------------- | ---- | ------------------------------- |
| `job-agent-api`     | `apps/job-agent` → `dist/main.js`           | 3000 | HTTP API + Kafka consumers      |
| `job-agent-worker`  | `apps/job-agent` → `dist/temporal/worker.js` | —    | Temporal activity worker        |
| `rag-service`       | `apps/rag-service` → `dist/main.js`         | 3001 | PDF parsing/OOM must not kill the pipeline |
| `job-agent-web`     | `apps/web/dist` (static)                    | —    | SPA, no server code             |
| `job-agent-migrate` | one-shot `migration:run`                    | —    | Never runs as a long-lived process |

Plus the data layer:

| Dependency            | Local (`docker-compose.yml`)   | Job it does                              |
| --------------------- | ------------------------------ | ---------------------------------------- |
| PostgreSQL 16         | `postgres`                     | jobs, profiles, runs                     |
| Kafka                 | `apache/kafka`                 | job events, document indexing            |
| Temporal + its PG     | `temporal`, `temporal-postgres`| the job pipeline's durable workflows     |
| Object storage        | (none — uses S3-compatible)    | uploaded resumes/documents               |
| Vector index          | Pinecone                       | resume/job matching                      |
| LLM APIs              | OpenRouter / Mistral / OpenAI  | scoring and classification               |
| Job boards            | RapidAPI (JSearch), Adzuna     | the source postings                      |

The single most important thing to internalise: **the web container talks to the API
through `/api`, and only `/api`.** In dev and on the PM2 host, `vite preview` proxies
`/api` to the API process. Whatever you deploy in front must preserve that contract.

---

## 2. How real-world applications get deployed

There are genuinely only a few patterns in use. Teams move left to right as the
product and team grow.

### L0 — Run it locally
`pnpm dev` + `docker compose up`. Good for development, not a deploy.

### L1 — Single VM + a process manager
Build on the box, run four processes under PM2/systemd, put nginx in front.
**This is what we ship today.**

- ✅ Cheap, simple, every log is one `ssh` away.
- ❌ Deploys are best-effort, one host is one failure domain, scaling means
  "buy a bigger box", and a bad deploy can leave you staring at a restart loop.

### L2 — Containers on a VM
Build a Docker image, run it with Docker Compose on the same VM.
- ✅ Build environment == run environment. The `@temporalio/core-bridge` /
  `@swc/core` native-module problem disappears — the image already contains the
  right binaries.
- ❌ You still own patching, TLS renewal, backups, and the host itself.

### L3 — Managed orchestrator (what most teams land on)
Push images to a registry; a managed service runs N copies behind a load balancer.
On AWS that is **ECS Fargate** (most common for a team this size), **App Runner**
(even simpler, fewer knobs), or **EKS** (only if you already run Kubernetes).

- ✅ No host management, health-check replacement, rolling deploys, easy rollback,
  scale on CPU/queue depth.
- ❌ More moving parts to define as code; you must build real images first.

### L4 — Split the deploy by the thing being deployed
Different tiers deploy differently:

- **Static frontend** → S3 + CloudFront. It is just files. There is no "restart",
  only cache invalidation. Rollback = repoint to the previous build.
- **Backend** → ECS Fargate or Lambda.
- **Data layer** → managed (RDS, MSK, Temporal Cloud) and deployed by migration,
  never by container rollout.

**This is the target architecture for this project.** The frontend and the backend
have completely different failure modes and release cadences; treating them the same
is what makes deploys scary.

### What the industry actually chooses

| Team / stage                        | Typical setup                                              |
| ----------------------------------- | ---------------------------------------------------------- |
| Solo, early                         | One VPS + PM2, or a PaaS (Railway, Render, Fly)            |
| Small product team                  | **S3/CloudFront + ECS Fargate + RDS + GitHub Actions**     |
| Needs queue/async guarantees        | + MSK/SQS + Temporal Cloud                                 |
| Large / multi-team                  | EKS + ArgoCD, infra in Terraform                           |

We are aiming squarely at row 2.

---

## 3. Target AWS architecture

| This repo                         | AWS service                                         |
| --------------------------------- | --------------------------------------------------- |
| `apps/web/dist`                   | **S3** + **CloudFront** (origin access control)     |
| `job-agent-api`                   | **ECS Fargate** service behind an **ALB**           |
| `job-agent-worker`                | **ECS Fargate** service, **no load balancer**       |
| `rag-service`                     | **ECS Fargate** service behind the same ALB on a path or its own listener |
| `migration:run`                   | **ECS one-shot task** run before the new service serves traffic |
| PostgreSQL 16                     | **RDS PostgreSQL** (Multi-AZ when you can afford it) |
| Kafka                             | **MSK Serverless**, or keep Kafka on EC2 until you need it |
| Temporal                          | **Temporal Cloud** (recommended)                    |
| Object storage                    | **S3** — the adapter already supports it            |
| Vector store                      | Keep **Pinecone** (moving it is a project of its own) |
| Secrets / config                  | **Parameter Store** (free, structured) or **Secrets Manager** |
| Images                            | **ECR**                                             |
| DNS + TLS                         | **Route 53** + **ACM**                              |
| CI/CD                             | **GitHub Actions** → ECR → ECS                      |

### The three decisions worth making early

**1. Temporal: self-host or Temporal Cloud.**
Self-hosting means running `temporalio/auto-setup` + its own Postgres + the Temporal
UI, which is a production-grade distributed system you now operate. Temporal Cloud
is a hosted serverless namespace with a gRPC endpoint; you set `TEMPORAL_ADDRESS` to
it and delete ~40 lines from `docker-compose.yml`. For a small team, use Temporal
Cloud. If budget forbids it, run the compose Temporal stack on EC2 and treat it as
stateful infrastructure with a snapshot policy.

**2. Kafka: MSK now, or later.**
Kafka is only carrying job/document events between processes here. **Amazon MSK
Serverless** gives you the same protocol without brokers to run. If you are staying
on a single box in Phase 0–1, keep the compose Kafka — but do not let an ad-hoc
EC2 Kafka become production; the migration to MSK is much easier before real data
exists. A cheaper interim: run Kafka in ECS with EBS-backed volumes.

**3. `vite preview` is not a production server.**
Today `job-agent-web` runs `vite preview`, which serves `apps/web/dist` and proxies
`/api`. On AWS the SPA goes to S3/CloudFront instead, and the `/api` proxy becomes a
CloudFront Function (or an ALB rule if the API is on the same domain). Plan for that
now: it changes how the app resolves its API base URL.

---

## 4. Phase 1 — Containerise

Everything later depends on this. Build **one image per deployable unit**, from a
root multi-stage `Dockerfile` (or one per app).

```dockerfile
# ---- build -------------------------------------------------------------
# The full image (not -slim): pnpm needs build-essential for the native modules
# @temporalio/core-bridge and @swc/core referenced in .github/workflows/cd.yml.
FROM node:24-bookworm AS build
WORKDIR /app
RUN corepack enable

# Copy manifests first so `pnpm install` caches independently of source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/job-agent/package.json  apps/job-agent/
COPY apps/rag-service/package.json apps/rag-service/
COPY apps/web/package.json        apps/web/
COPY packages/ai/package.json     packages/ai/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm turbo run build --filter=job-agent --filter=rag-service --filter=web
RUN pnpm deploy --filter job-agent --prod /out/api \
 && pnpm deploy --filter rag-service --prod /out/rag

# ---- runtime -----------------------------------------------------------
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Copy only the pruned production trees — no devDependencies, no source.
COPY --from=build /out/api  ./api
COPY --from=build /out/rag  ./rag
CMD ["node", "api/dist/main.js"]
```

Then vary the `CMD` per service:

| Service       | `CMD`                                        | Health check                     |
| ------------- | -------------------------------------------- | -------------------------------- |
| `api`         | `node api/dist/main.js`                      | `GET /` or `/api/runs?limit=1`   |
| `worker`      | `node api/dist/temporal/worker.js`           | none (Temporal has its own)      |
| `rag`         | `node rag/dist/main.js`                      | its listen port on `:3001`       |
| `web`         | `nginx:alpine` serving `/usr/share/nginx/html` | `GET /`                        |
| `migrate`     | `node api/dist/main.js` equivalent, or the package script | `exit 0`        |

**Add a real `/health` endpoint.** The API currently only has `GET /` returning
`"Hello World!"`. An ALB target group wants a cheap, unauthenticated, dependency-aware
endpoint — `SELECT 1` on Postgres plus a Temporal client ping. Without it the load
balancer cannot tell "deployed but broken" from "still starting", which is exactly the
moment a bad release should roll back.

Three gotchas this repo is prone to:

1. **Native modules.** Build and runtime images must share a libc family
   (`bookworm` → `bookworm-slim` is fine). Mixing Alpine build with Debian runtime
   produces `Error: Cannot find module ... .node`. This is why `cd.yml` ships source
   rather than `node_modules`.
2. **`.env` must not be baked in.** `docker build` copies the build context; `.dockerignore`
   it. Config comes from the task definition at runtime.
3. **Never prefix a secret with `VITE_`.** Vite inlines those into `apps/web/dist`,
   so the file on S3 would contain your secrets.

Push to ECR:

```bash
aws ecr create-repository --repository-name job-agent-api
aws ecr get-login-password | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
docker build -t job-agent-api --target api .
docker tag job-agent-api:latest "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/job-agent-api:git-$GIT_SHA"
docker push "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/job-agent-api:git-$GIT_SHA"
```

Tag with the git SHA, never only `latest`. An image you can name is an image you can
roll back to.

---

## 5. Phase 2 — Managed data layer

Do this **before** containers leave a single box. Data migrations are the one part of
a deploy that cannot be rolled back by restarting a container.

### RDS PostgreSQL

```bash
aws rds create-db-instance \
  --engine postgres --engine-version 16 \
  --db-instance-identifier job-agent-db \
  --db-instance-class db.t4g.micro \
  --master-username jobly \
  --manage-master-user-password \
  --allocated-storage 20 --storage-type gp3 \
  --vpc-security-group-ids "$APP_SG"
```

`--manage-master-user-password` puts the generated password in Secrets Manager so it
never appears in a shell history. Then set in your config:

```bash
DB_HOST=job-agent-db.xxxxxxxxxx.$REGION.rds.amazonaws.com
DB_PORT=5432
DB_NAME=postgres
DB_USERNAME=jobly
DB_PASSWORD=<from Secrets Manager>
DB_SSL=true
DB_SYNC=false        # never true in production
```

`DB_SYNC=false` is already required in production, which is why `cd.yml` runs
`pnpm --filter job-agent run migration:run` as its own step. Keep that: **migrations
run as an explicit, ordered, logged step before new code takes traffic** — not as a
boot side effect where two containers racing would corrupt the schema.

Set a maintenance window and automated backups from day one. Restore-into-a-new-DB is
the only reliable answer to a bad migration.

### S3

The object store already reads `S3_ENDPOINT`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`,
`AWS_REGION`. For real AWS:

```bash
aws s3api create-bucket --bucket job-agent-documents --region "$REGION"
```

Set `S3_ENDPOINT=https://s3.$REGION.amazonaws.com` and
`S3_FORCE_PATH_STYLE=false`. Put the bucket on a **VPC gateway endpoint** (free) so
uploads never traverse the public internet, and block public access.

**Prefer IAM roles over static keys.** On EC2 use an instance profile; on ECS use a
task role. `AWS_SDK` picks the role up with no credentials in the environment, which
removes a whole class of leaked-secret incident.

### What to do with the local compose services

Until you move off the single VM, `docker compose up -d postgres kafka temporal`
is fine and is the cheapest correct option. When you move to AWS, lift them in this
order — easiest first:

1. **Postgres → RDS** (low risk, boring, do it first)
2. **Temporal → Temporal Cloud** (delete the service from compose, update one env var)
3. **Kafka → MSK Serverless** (last; the client config is `KAFKA_BROKERS`, so the
   swap is a string change)

---

## 6. Phase 3 — Run it on AWS (ECS Fargate)

### Network

One VPC, three private subnets for tasks, three public for the ALB + NAT:

- **ALB** in public subnets, internet-facing, ACM cert from Route 53.
- **ECS tasks** in **private** subnets with `awsvpc` networking. They reach the
  internet only through NAT (for the job-board APIs, OpenRouter, Pinecone).
- **Security groups**: ALB SG → api/rag SG on 3000/3001; api/rag/worker SG → RDS SG
  on 5432; api/rag/worker SG → MSK SG on 9092; nothing inbound to tasks from 0.0.0.0/0.

### Task definitions

One task definition per unit, revisioned. The critical fields:

| Field          | Value                                                        |
| -------------- | ------------------------------------------------------------ |
| CPU / memory   | api `512/1024`, rag `1024/2048` (PDF spikes — `ecosystem.config.cjs` caps it at 768M), worker `512/1024`, web `256/512` |
| Task role      | IAM role with S3 + SSM access                                |
| Execution role | IAM role that pulls from ECR and reads secrets               |
| Health check   | `/health`, `healthy-threshold 2`, `unhealthy-threshold 3`, `30s` |
| Logging        | awslogs driver → CloudWatch Logs, one log group per service  |

`rag-service` gets the biggest memory allotment on purpose: extraction and batched
embeddings are the memory spikes, and letting it OOM-kill the host is how the whole
pipeline goes down instead of just the retrieval path.

### Services

- **`api`** — desired count 2+ behind the ALB, target group on `:3000`. One replica
  today because the Kafka consumer group is shared and a second instance doubles
  Temporal clients; with `KAFKA_CLIENT_ID`/consumer group made explicit, 2 is fine.
- **`worker`** — desired count 2, **no target group**. Temporal tasks go to whichever
  worker is free, so horizontal scaling is safe and needs no load balancer.
- **`rag`** — desired count 1–2, target group on `:3001`, autoscaled on CPU or
  pending-document depth.
- **`web`** — **no ECS service at all.** It is a static folder.

### Routing `/api`

Two correct options; pick one and make it explicit:

**Option A (recommended):** SPA on CloudFront, API on the ALB. Attach a CloudFront
Function on the viewer-request event that rewrites `URL.pathname.startsWith('/api')`
to the ALB origin. One domain, no CORS, cookies work as-is.

**Option B:** everything on the ALB with nginx in front of the SPA path routing
`/api` to the API target group. Simpler mental model, worse caching for the SPA.

Whichever you choose, confirm the SPA's production API base is relative (`/api`), not
`http://localhost:3000`.

---

## 7. Phase 4 — CI/CD on AWS

The existing `.github/workflows/cd.yml` must be **replaced**, not run alongside an
AWS deploy. It SSHes into a host, rsyncs source, installs, and restarts PM2 — none of
which applies once images run in ECS. `ci.yml` stays exactly as it is; it is the gate.

### The pipeline

```
push to main
   └─ CI: format → typecheck → lint → test → build        (unchanged, blocks merge)
        └─ deploy job, gated by the `production` environment
             1. build + tag images with git SHA
             2. push to ECR
             3. run migration task to completion        ← must succeed first
             4. update ECS services to the new images
             5. wait for stability
             6. smoke test the real URL
             7. on failure: roll back to the previous task-definition revision
```

Two ordering rules that matter more than anything else in this section:

- **Migrate before rollout, never after.** If new code starts first it will query a
  schema it does not understand. Rolling migration and code out together is fine
  only when migrations are backward-compatible (additive first, destructive later).
- **Do not gate the deploy on a human by default.** The `production` environment is
  already set up so you *can* add required reviewers; add them only when the team is
  big enough that a queue is cheaper than an incident.

### GitHub Actions skeleton

```yaml
name: CD (AWS)
on:
  push: { branches: [main] }
  workflow_dispatch:

concurrency:
  group: cd-production          # never cancel mid-deploy; a half-rolled-out
  cancel-in-progress: false     # stack is worse than a slow queue

permissions:
  contents: read
  id-token: write               # OIDC — no long-lived AWS keys in GitHub

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    environment: production
    env:
      ACCOUNT_ID: ${{ vars.AWS_ACCOUNT_ID }}
      REGION: ${{ vars.AWS_REGION }}
      ECR: ${{ vars.AWS_ACCOUNT_ID }}.dkr.ecr.${{ vars.AWS_REGION }}.amazonaws.com

    steps:
      - uses: actions/checkout@v4

      # OIDC federation: create the IAM role with
      # "accounts allowed to assume this role" => repo:owner/job-agent:ref:refs/heads/main
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::${{ vars.AWS_ACCOUNT_ID }}:role/gha-deploy-job-agent
          aws-region: ${{ vars.AWS_REGION }}

      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile

      - uses: aws-actions/amazon-ecr-login@v2
        id: ecr

      - name: Build and push images
        run: |
          tag="git-${GITHUB_SHA::12}"
          for svc in api rag; do
            image="${{ steps.ecr.outputs.registry }}/job-agent-${svc}:${tag}"
            docker build --build-arg SERVICE=${svc} -t "${image}" -t "${image%%:*}:latest" .
            docker push "${image}"
          done

      # Gate: migration runs to completion or the deploy stops right here.
      - name: Run migrations
        run: |
          aws ecs run-task --cluster job-agent \
            --task-definition job-agent-migrate \
            --launch-type FARGATE \
            --network-configuration "awsvpcConfiguration={subnets=[${{ vars.PRIVATE_SUBNETS }}],securityGroups=[${{ vars.PRIVATE_SG }}],assignPublicIp=DISABLED}" \
            --overrides '{"containerOverrides":[{"name":"migrate","environment":[{"name":"IMAGE_TAG","value":"git-'${GITHUB_SHA::12}'"}]}]}'
          # poll describe-tasks until lastStatus == RUNNING && desiredStatus == STOPPED
          # and containers[].exitCode == 0; non-zero fails the step.

      - name: Update services
        run: |
          for svc in api rag worker; do
            aws ecs update-service --cluster job-agent --service "$svc" \
              --force-new-deployment >/dev/null
          done

      - name: Wait for stability
        run: |
          for svc in api rag worker; do
            aws ecs wait services-stable --cluster job-agent --services "$svc"
          done

      - name: Smoke test
        run: |
          base="https://${{ vars.APP_HOSTNAME }}"
          for i in $(seq 1 20); do
            curl -fsS "${base}/health" && exit 0
            echo "attempt ${i}/20"; sleep 15
          done
          echo "::error::deploy did not become healthy"; exit 1
```

Use **OIDC, not static AWS keys.** GitHub's OIDC federation means no
`AWS_ACCESS_KEY_ID` secret exists to leak, and every workflow run can assume a
different, narrowly scoped role. This is the default for real-world AWS CI/CD.

### Configuration and secrets

Keep the "one config source" convention (`.env` resolved by `apps/job-agent/src/env.ts`)
but back it with Parameter Store:

```bash
for k in JWT_SECRET OPENROUTER_API_KEY PINECONE_API_KEY ADZUNA_APP_ID ADZUNA_APP_KEY \
         RAPIDAPI_KEY MISTRAL_API_KEY RAG_INTERNAL_SECRET; do
  aws ssm put-parameter --name "/job-agent/prod/${k}" \
    --type SecureString --value "$k" --overwrite
done
```

Then in the task definition, reference them as `secrets` rather than `environment`:

```json
"secrets": [
  { "name": "JWT_SECRET",        "valueFrom": "/job-agent/prod/JWT_SECRET" },
  { "name": "PINECONE_API_KEY",  "valueFrom": "/job-agent/prod/PINECONE_API_KEY" }
]
```

ECS injects the value at container start, so **the secret never lands in the image,
the repo, or CloudWatch logs.** Non-secret config (`DB_HOST`, `DB_PORT`, `PORT`,
`AWS_REGION`, `ADMIN_EMAILS`) goes in plain `environment` blocks.

Rule: **adding an env var must never require a code change to deploy** — it is a
Parameter Store value plus a task-definition update.

---

## 8. Observability and rollback

A deploy system you cannot watch is a deploy system that fails silently.

- **Logs** — CloudWatch Logs, one log group per service, `awslogs` driver. Never
  `console.log` a secret; the log group is the most-read place in your stack.
- **Health** — ALB target group health plus a real `/health` endpoint. Unhealthy
  targets are removed automatically, which is your first rollback mechanism.
- **Alarms** — target 5xx > 1% over 5 min, healthy host count < desired, CPU > 80%,
  and RDS `FreeStorageSpace < 20%`. Wire them to an SNS topic you actually read.
- **Trace** — request IDs through API → Kafka → Temporal, so one bad job can be
  followed across four services.
- **Rollback** — always know the previous image tag and task-definition revision:

```bash
# previous revision, no rebuild needed
aws ecs update-service --cluster job-agent --service api \
  --task-definition job-agent-api:<previous-revision> --force-new-deployment
```

Because images are SHA-tagged, "roll back" never means "rebuild an old commit and
hope the dependencies still resolve".

---

## 9. What the smallest sane AWS setup costs

Fine for a personal or early-stage project:

| Service                  | Shape                            | Rough monthly |
| ------------------------ | -------------------------------- | ------------- |
| ECS Fargate              | 4 tasks, 0.25 vCPU/0.5 GB        | $30–60        |
| ALB                      | 1                                | ~$20          |
| RDS PostgreSQL           | `db.t4g.micro`, single-AZ        | ~$20          |
| NAT Gateway              | 1                                | ~$30 + data   |
| S3 + CloudFront          | small                            | < $5          |
| ECR, CloudWatch, SSM     | —                                | ~$5           |
| MSK Serverless           | minimal                          | starts ~$30   |
| Temporal Cloud           | starter namespace                | starts ~$50   |
| Pinecone / job-board APIs| usage                            | varies        |

**Ways to cut this in half:** skip NAT by putting tasks in public subnets with
security groups locked down; run `db.t4g.micro` single-AZ while non-critical; keep
Kafka/Temporal in Docker Compose on one small EC2 instance during Phases 1–2 (that
alone removes $80+/month). MSK and Temporal Cloud are the two items to adopt *last*,
when their operational cost actually hurts.

---

## 10. Migration checklist

Work top-down; each phase is independently shippable and independently worth doing.

- [ ] **Phase 0** — CI green on every push (already done), `pnpm turbo run test`,
      `typecheck`, `lint`, `build` all pass locally.
- [ ] **Phase 1** — `.dockerignore` added; one multi-stage `Dockerfile`; images build
      locally; `docker run` boots each service against compose; `/health` endpoint
      added; ECR repositories created; images pushed with a SHA tag.
- [ ] **Phase 2** — RDS provisioned; app DB migrated and its connection configured
      with `DB_SSL=true`, `DB_SYNC=false`; S3 bucket created with a VPC endpoint and
      public access blocked; job's source of secrets moved to SSM/Secrets Manager;
      backups + restore rehearsed once.
- [ ] **Phase 3** — VPC, subnets, security groups; ALB with ACM cert; task
      definitions with task/execution roles and awslogs; `api`, `rag`, `worker`
      services running; `/api` routing verified from the public domain; SPA moved to
      S3 + CloudFront and confirmed to be calling a relative `/api`.
- [ ] **Phase 4** — `cd.yml` replaced with the AWS pipeline; GitHub OIDC role created
      and scoped to this repo only; migrations run as a pre-rollout task; smoke test
      gating the deploy; a rehearsed rollback; alarms and log retention configured.
- [ ] **After** — decommission the PM2 host, remove `DEPLOY_*` GitHub config, and
      delete the old `cd.yml` so nobody SSHes into a box that no longer exists.

### Order of operations on the day you cut over

1. Put the database in `DB_SYNC=false` (already required in production).
2. Run `pnpm --filter job-agent run migration:run` against RDS.
3. Stand up ECS with the current release, pointing at RDS.
4. Verify `/health` and a full job run end-to-end **while the old host is still up**.
5. Switch DNS (Route 53, low TTL first, then raise it back).
6. Watch logs and alarms for one full cycle.
7. Only then stop the PM2 host.

Never delete the old environment in the same change that introduces the new one.

---

## Related

- `README.md` → **CI/CD** for the current SSH + PM2 pipeline and its `DEPLOY_*` config
- `README.md` → **Environment** and `.env.example` for the full variable list
- `docker-compose.yml` → the local data layer you are replacing
- `deploy/ecosystem.config.cjs` → the four processes, and why `rag-service` is separate
- `.github/workflows/ci.yml` → the gate; it does not change in any phase
