# Phase 1: Jobly on Docker (Local -> Azure VM)

Goal: Run `api`, `worker`, `rag-service`, `web` as containers behind `nginx`. Test locally first on HTTP, then move to Azure VM with same setup.

## Folder structure we're using
```text
job-agent/
├── docker/
│   ├── Dockerfile.api
│   ├── Dockerfile.worker
│   ├── Dockerfile.rag
│   ├── Dockerfile.web
│   └── nginx.web.conf
├── nginx/
│   ├── local.conf
│   └── prod.conf
├── docker-compose.local.yml  (LOCAL TESTING)
└── docker-compose.prod.yml   (AZURE VM)
```

## Step 1: Test Locally (Do this FIRST)
We want to be sure images build and all containers talk fine.

### 1a) Check .env
Make sure your root `.env` has correct values. The app will read it.

### 1b) Build & run locally
From repo root on your Mac:

```bash
cd /Users/a/Projects/Practice\ Projects/NestJs/job-agent

# Build and start all
docker compose -f docker-compose.local.yml up --build -d

# Watch logs to catch errors early
docker compose -f docker-compose.local.yml logs -f
```

### 1c) Check status
Open a new terminal:

```bash
docker compose -f docker-compose.local.yml ps
```

All should be `Up`. `jobly-worker-local` might restart once if deps aren't ready, but should settle.

### 1d) Test in browser
Go to: [http://localhost:8080](http://localhost:8080)

Check API through nginx:
```bash
curl http://localhost:8080/api/
```

### 1e) Debug if something fails
```bash
# Logs
docker compose -f docker-compose.local.yml logs -f job-agent-api
docker compose -f docker-compose.local.yml logs -f job-agent-worker
docker compose -f docker-compose.local.yml logs -f rag-service
docker compose -f docker-compose.local.yml logs -f nginx
docker compose -f docker-compose.local.yml logs -f job-agent-web

# Rebuild single service
docker compose -f docker-compose.local.yml up -d --build job-agent-api

# Stop everything
docker compose -f docker-compose.local.yml down
```

**Only move to VM once `http://localhost:8080` loads the UI and API is reachable.**

## Step 2: Move to Azure VM

We'll copy this working setup to your Azure Ubuntu VM. No domain needed now, just test via VM public IP on HTTP.

### 2a) Create Azure VM
In Azure Portal:
- Create Ubuntu 22.04 LTS VM
- Size: `Standard_B2s` minimum, `Standard_D2s_v3` safer if build is slow
- Authentication: SSH key or password
- Networking: Allow SSH (22), HTTP (80). Add HTTPS (443) now if you plan later.

Note down `VM_PUBLIC_IP`.

### 2b) Open ports in NSG
Go to VM -> Networking -> Network Security Group
Add inbound rules:
- `22` TCP (SSH)
- `80` TCP (HTTP)
- `443` TCP (HTTPS) - optional but good to have

### 2c) Install Docker on Azure VM
SSH in:

```bash
ssh azureuser@VM_PUBLIC_IP  # or your username
```

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
docker --version
docker compose version
```

### 2d) Copy files from Mac to VM
On your Mac (from repo root):

```bash
cd /Users/a/Projects/Practice\ Projects/NestJs/job-agent

# Copy everything except node_modules/.git/.turbo
rsync -avz --exclude node_modules --exclude .git --exclude .turbo --exclude dist ./ azureuser@VM_PUBLIC_IP:~/jobly/

# Copy .env explicitly
scp .env azureuser@VM_PUBLIC_IP:~/jobly/.env
```

SSH back into VM and verify:

```bash
ssh azureuser@VM_PUBLIC_IP
cd ~/jobly
ls -la
ls docker/ nginx/
```

### 2e) Update nginx/prod.conf for VM IP (HTTP only)
Since no domain yet, just listen on port 80 for the VM IP.

Edit `nginx/prod.conf` on VM:

```bash
nano ~/jobly/nginx/prod.conf
```

Replace contents with this minimal HTTP-only config:

```nginx
server {
    listen 80;
    server_name _;

    client_max_body_size 50M;

    location /api/ {
        proxy_pass http://job-agent-api:3000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location /api {
        proxy_pass http://job-agent-api:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /rag/ {
        proxy_pass http://rag-service:3001/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://job-agent-web:80;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Save and exit.

### 2f) Run on Azure VM
```bash
cd ~/jobly
docker compose -f docker-compose.prod.yml up --build -d
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f
```

### 2g) Test from browser
Open `http://VM_PUBLIC_IP` in your browser. You should see the web app.

Test API: `http://VM_PUBLIC_IP/api/`

## Step 3: When you get a domain (Later)
Once you have a domain and DNS pointing to `VM_PUBLIC_IP`:

1. Edit `nginx/prod.conf` to use `server_name yourdomain.com www.yourdomain.com`
2. Get certs with certbot
3. Uncomment `443:443` and certbot volumes in `docker-compose.prod.yml`
4. Restart: `docker compose -f docker-compose.prod.yml up -d`

## Quick Commands Cheat Sheet
```bash
# Local
docker compose -f docker-compose.local.yml up --build -d
docker compose -f docker-compose.local.yml logs -f
docker compose -f docker-compose.local.yml down

# VM
docker compose -f docker-compose.prod.yml up --build -d
docker compose -f docker-compose.prod.yml logs -f
docker compose -f docker-compose.prod.yml restart
docker compose -f docker-compose.prod.yml ps
```

## Notes
- `k8s/` and `argocd/` are untouched. We'll use them in Phase 3.
- API and Worker use separate Dockerfiles but share same codebase.
- Keep all secrets in `.env`. Never commit `.env`.
