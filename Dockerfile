# syntax=docker/dockerfile:1

# ---- build -------------------------------------------------------------
FROM node:24-bookworm AS build
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.8.0 --activate

# Copy manifests first for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/job-agent/package.json apps/job-agent/
COPY apps/rag-service/package.json apps/rag-service/
COPY apps/web/package.json apps/web/
COPY packages/ai/package.json packages/ai/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile

COPY . .

# Build apps
RUN pnpm turbo run build --filter=job-agent --filter=rag-service --filter=web

# Prune prod deps
RUN pnpm deploy --filter job-agent --prod /out/api \
 && pnpm deploy --filter rag-service --prod /out/rag

# ---- runtime for api/worker --------------------------------------------
FROM node:24-bookworm-slim AS api-runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/api ./app
WORKDIR /app
EXPOSE 3000
CMD ["node", "app/dist/main.js"]

# ---- runtime for rag ----------------------------------------------------
FROM node:24-bookworm-slim AS rag-runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/rag ./app
WORKDIR /app
EXPOSE 3001
CMD ["node", "app/dist/main.js"]

# ---- web nginx ----------------------------------------------------------
FROM nginx:1.27-alpine AS web-runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
