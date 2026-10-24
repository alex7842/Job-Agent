# Jobly Deployment Pattern (Phased)

Keep it simple. We learn step by step, don't jump straight to full AKS + ArgoCD complexity. K8s/ArgoCD files stay untouched - we'll use them later in Phase 3.

## Overview of Phases
| Phase | Goal | Status |
|-------|------|--------|
| **Phase 1** | Simple deployment - Containers on a VM (Docker + Docker Compose) or Azure Container Apps + ACR | **Current (Do this first)** |
| **Phase 2** | Automate - GitHub Actions to build/push to ACR and deploy | **Next** |
| **Phase 3** | Orchestrate - Move to AKS + Kubernetes + ArgoCD (reuse images & `k8s/` manifests) | **Later** |

---

## Phase 1 — Deploy Jobly simply (Start here)

Goal: Get Jobly running on the internet with containers, minimal moving parts. Two easy paths.

### Option 1A: Docker on a Linux VM (Recommended to learn)
You control the VM, see logs directly, understand networking. Good foundation before K8s.

**Services to run (as containers):**
| Container | Image | Port | Notes |
|-----------|-------|------|-------|
| `job-agent-api` | Built from `apps/job-agent` (API) | 3000 (internal) | HTTP API |
| `job-agent-worker` | Built from `apps/job-agent` (worker entrypoint) | - | Temporal worker, no public port |
| `rag-service` | Built from `apps/rag-service` | 3001 (internal) | RAG service |
| `job-agent-web` | Built from `apps/web` (nginx) | 80 (internal) | Static frontend |
| `nginx`/`reverse-proxy` | `nginx:alpine` | 80/443 | Reverse proxy for domain + TLS (Let's Encrypt) |

**Infra (can be local compose first, then VM):**
- PostgreSQL (managed or container)
- Kafka (managed or container)
- Temporal (Temporal Cloud recommended, or container)
- Redis (optional)
- Object storage / Pinecone / API keys as needed

### Steps for Option 1A (VM)
1. **Containerize** - Create Dockerfiles (API/worker share same build, rag separate, web with nginx). Reuse patterns from root `Dockerfile` we just added.
2. **Build images locally or on VM** - `docker build`
3. **Write `docker-compose.prod.yml`** - Define all 4 app containers + proxy + env vars
4. **Provision VM** - Azure VM, DigitalOcean, Linode etc. Install Docker + Docker Compose
5. **Copy files/env** - Copy repo or just `docker-compose.prod.yml`, `.env`, nginx config to VM
6. **Run** - `docker compose -f docker-compose.prod.yml up -d --build`
7. **Reverse proxy + TLS** - Nginx on host/ container with Certbot (or Caddy) for HTTPS + domain
8. **Test end to end** - Hit your domain

### Option 1B: Azure Container Apps + ACR (Even simpler, managed)
If you want less VM ops, use Azure Container Apps.

**Steps for Option 1B:**
1. **Create ACR** - Push images there
2. **Create Container Apps Environment** - Shared networking/logs
3. **Deploy each app** - API, worker (separate Container App, no ingress), RAG, Web (or static hosting) as Container Apps
4. **Configure** - Env vars, secrets, ingress (for API/Web), scaling (min/max replicas)
5. **Custom domain + HTTPS** - Managed cert or bring your own
6. **Test** - Public HTTPS URL

**Note:** For Phase 1, **Option 1A (VM + Docker Compose)** is the most educational - you see everything. Option 1B is also fine. Pick one and do it fully.

---

## Phase 2 — Automate deployment (GitHub Actions + ACR)
After Phase 1 is working manually, automate it.

**What to learn/do:**
| Task | Details |
|------|---------"
| CI Pipeline | `.github/workflows/deploy.yml` - checkout, install pnpm/node, build, test (if any), build images |
| Image tagging | Tag with `git sha`, `branch`, and `latest` on main |
| Push to ACR | Login via service principal/OIDC (Azure login + acr login) |
| Deploy | For VM: SSH + pull/run docker compose (rsync/docker compose pull/up). For Container Apps: update image via `az containerapp update |
| Health checks & logs | Check container status, app logs, curl health endpoints |
| Rollback | Revert to previous image tag (easy with tags/rollback actions) |
| Safe config | Use GitHub Secrets for env vars/keys/certs |
 
---

## Phase 3 — Learn Kubernetes (AKS + ArgoCD)
Only move here after Phases 1 and 2 are solid. Reuse everything.

**Target:** Use the `Dockerfile`, `docker/nginx.conf`, and all files in `k8s/` and `argocd/` that are already created in this repo.

**What to learn:**
| Concept | Implementation |
|-------|----------------|
| Deployments/ReplicaSets | API, worker, RAG, web |
| Services (ClusterIP/LoadBalancer) | Internal + external access via Ingress |
| Ingress/Gateway API | Route traffic to web/api/rag with TLS |
| ConfigMaps & Secrets | Separate config from code (K8s native or ExternalSecrets) |
| Jobs/CronJobs | Migration as a PreSync Job (already scaffolded) |
| HPA (HorizontalPodAutoscaler) | Scale API/RAG based on CPU/memory or queue lag (KEDA later) |
| Resource Requests/Limits, Probes | Readiness/liveness for stability |
| GitOps with ArgoCD | Sync `k8s/overlays/prod` from Git to cluster, automated prune/selfHeal |
| Node pools, networking, ACR integration | AKS basics |

---

## Action Plan for Today
1. **Phase 1 first** - Pick Option 1A (VM) or 1B (Container Apps). I suggest 1A to learn most.
2. **Containerize** - Build images locally with the existing root `Dockerfile` or create simple ones; use `docker build --target ...`
3
4. **Deploy manually** - Get it running with HTTPS + domain
5. **Only after it works** - Move to Phase 2 (GitHub Actions), then Phase 3 (AKS/ArgoCD)

**The `k8s/` and `argocd/` folders remain exactly as they are - we don't touch them until Phase 3.**
