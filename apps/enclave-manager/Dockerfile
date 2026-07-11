# syntax=docker/dockerfile:1
# Build context is the repo root:  docker build -f apps/enclave-manager/Dockerfile .
#
# brokk-enclave-manager — the privileged sidecar that holds the Docker socket and
# drives per-project gVisor enclaves for the workers (ADR 0010 Fase 1). It shells the
# docker CLI (present here) against the host daemon via the mounted socket. It is the
# ONLY Brokk component with docker access; the workers reach it over a token-gated
# HTTP API and never touch the socket themselves.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Read-only GitHub Packages token for the private @cold-code-labs/* deps (Coolify
# is_buildtime). Same posture as the other Brokk apps.
COPY . .
ARG NODE_AUTH_TOKEN
# BuildKit cache mount for pnpm's content-addressable store (PNPM_HOME=/pnpm →
# store at /pnpm/store). Persists across deploys: this stage does `COPY . .`
# before install, so every source change busts the install layer — the store
# mount makes that reinstall hard-link packages instead of refetching them.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store NODE_AUTH_TOKEN="$NODE_AUTH_TOKEN" pnpm install --no-frozen-lockfile
RUN pnpm --filter @brokk/enclave-manager-app build
RUN pnpm --filter @brokk/enclave-manager-app deploy --prod /out

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The docker CLI only (the daemon is the host's, reached via the mounted socket).
# From Docker's official apt repo, matching the host install.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/enclave-manager/dist ./dist
COPY --from=build /repo/apps/enclave-manager/package.json ./package.json
# The default enclave runtime image's Dockerfile — the manager builds it on the host
# (via the socket) if absent, so the base image is reproducible + self-healing.
COPY --from=build /repo/apps/enclave-manager/enclave-base ./enclave-base
# Runs as root: it needs the Docker socket (root:docker). It is the trusted,
# privileged broker by design — the untrusted code lives in the enclaves it spawns.
CMD ["node", "dist/index.js"]
