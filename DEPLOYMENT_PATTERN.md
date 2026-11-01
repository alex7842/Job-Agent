# Jobly Deployment Pattern (Phased)

Keep it simple. We learn step by step, don't jump straight to full AKS + ArgoCD complexity. K8s/ArgoCD files stay untouched - we'll use them later in Phase 3.

## Overview of Phases
| Phase | Goal | Status |
|-------|------|--------|
| **Phase 1** | Simple deployment - Containers on a VM (Docker + Docker Compose) or Azure Container Apps + ACR | ✅ Done |
| **Phase 2** | Automate - GitHub Actions to build/push to ACR and deploy | **Current** |
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

The CD workflow (`.github/workflows/cd.yml`) is now updated for Phase 2.  
It builds all four images, pushes them to ACR, SSHs into the VM, and does a rolling restart.

### What the workflow does
| Step | Details |
|------|---------|
| Image tag | Short git SHA (e.g. `a3f9b1c`) + `latest` alias |
| Azure login | OIDC federated credential — no passwords stored |
| Build & push | `docker/build-push-action` with ACR layer cache |
| Deploy | rsync compose file → SSH → `docker compose pull` → `docker compose up -d` |
| Smoke test | `curl` the health endpoint up to 12 times |

### Azure things you must set up manually (see steps below)
See **"Phase 2 Azure Setup Steps"** section below.

---

### Phase 2 Azure Setup Steps

#### Step 1 — Create an Azure Container Registry (ACR)

```bash
# Replace values as needed
ACR_NAME=joblyacr          # must be globally unique, lowercase, 5-50 chars
RG=jobly-rg                # your existing resource group
LOCATION=eastus

az acr create \
  --resource-group $RG \
  --name $ACR_NAME \
  --sku Basic \
  --admin-enabled false
```

Note your ACR login server: `joblyacr.azurecr.io`

---

#### Step 2 — Create a Service Principal for GitHub Actions (OIDC)

OIDC is the modern approach — no passwords, tokens rotate automatically.

```bash
# Get your subscription ID
SUBSCRIPTION_ID=$(az account show --query id -o tsv)

# Create the service principal
az ad sp create-for-rbac \
  --name "github-jobly-deploy" \
  --role Contributor \
  --scopes /subscriptions/$SUBSCRIPTION_ID \
  --sdk-auth   # only needed if you want the JSON output for reference
```

Save the output — you need `clientId`, `tenantId`, `subscriptionId`.

Then grant the SP permission to push to ACR:

```bash
SP_CLIENT_ID=<paste clientId here>
ACR_ID=$(az acr show --name $ACR_NAME --query id -o tsv)

az role assignment create \
  --assignee $SP_CLIENT_ID \
  --role AcrPush \
  --scope $ACR_ID
```

---

#### Step 3 — Add a Federated Credential (OIDC trust from GitHub)

In the Azure Portal:
1. Go to **Microsoft Entra ID** → **App registrations** → find `github-jobly-deploy`
2. Click **Certificates & secrets** → **Federated credentials** → **Add credential**
3. Choose scenario: **GitHub Actions deploying Azure resources**
4. Fill in:
   - Organization: your GitHub username / org
   - Repository: `Job-Agent`
   - Entity: **Branch**, value: `main`
   - Name: `github-main-branch`
5. Click **Add**

Or via CLI:
```bash
APP_OBJECT_ID=$(az ad sp show --id $SP_CLIENT_ID --query appId -o tsv)

az ad app federated-credential create \
  --id $APP_OBJECT_ID \
  --parameters '{
    "name": "github-main-branch",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:<YOUR_GITHUB_ORG>/Job-Agent:ref:refs/heads/main",
    "audiences": ["api://AzureADTokenExchange"]
  }'
```

---

#### Step 4 — Grant VM access to ACR (pull images on the VM)

The VM's system-assigned managed identity (or the same SP) needs `AcrPull`:

```bash
VM_PRINCIPAL_ID=$(az vm show \
  --resource-group $RG \
  --name <your-vm-name> \
  --query identity.principalId -o tsv)

az role assignment create \
  --assignee $VM_PRINCIPAL_ID \
  --role AcrPull \
  --scope $ACR_ID
```

Then on the VM, log Docker in once (or use managed identity automatically):
```bash
az login --identity
az acr login --name $ACR_NAME
```

---

#### Step 5 — Add GitHub Secrets & Variables

Go to your repo → **Settings** → **Secrets and variables** → **Actions**

**Secrets** (sensitive values):
| Name | Value |
|------|-------|
| `AZURE_CLIENT_ID` | Service principal client ID |
| `AZURE_TENANT_ID` | Your Azure tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Your Azure subscription ID |
| `DEPLOY_SSH_KEY` | Private SSH key for your VM (the matching public key must be in `~/.ssh/authorized_keys` on the VM) |

**Variables** (non-sensitive, visible in logs):
| Name | Example Value |
|------|---------------|
| `ACR_NAME` | `joblyacr` |
| `DEPLOY_HOST` | `20.x.x.x` (VM public IP or DNS) |
| `DEPLOY_USER` | `azureuser` |
| `DEPLOY_PATH` | `/home/azureuser/jobly` |
| `DEPLOY_URL` | `https://yourdomain.com` |

---

#### Step 6 — Install Azure CLI on the VM

The deploy SSH step runs `az acr login` on the VM to authenticate Docker.

```bash
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
az login --identity   # uses the VM's managed identity
az acr login --name joblyacr
```

---

#### Step 7 — Push to main and watch it run

Once secrets/variables are set:
```bash
git push origin main
```

Watch it at: `https://github.com/<you>/Job-Agent/actions`

---

### Rollback

To roll back to any previous deploy:
```bash
# SSH into the VM
IMAGE_TAG=<previous-sha>   # find it in the Actions run history
ACR_NAME=joblyacr

export JOBLY_API_IMAGE="${ACR_NAME}.azurecr.io/jobly-api:${IMAGE_TAG}"
export JOBLY_WORKER_IMAGE="${ACR_NAME}.azurecr.io/jobly-worker:${IMAGE_TAG}"
export JOBLY_RAG_IMAGE="${ACR_NAME}.azurecr.io/jobly-rag:${IMAGE_TAG}"
export JOBLY_WEB_IMAGE="${ACR_NAME}.azurecr.io/jobly-web:${IMAGE_TAG}"

docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d --no-build
```
 
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
