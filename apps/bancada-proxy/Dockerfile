# syntax=docker/dockerfile:1
# Build context is the repo root:  docker build -f apps/bancada-proxy/Dockerfile .
#
# Proxy da bancada (ADR 0100) — serve o ambiente QUENTE num host que o Brokk
# controla: `<workspace>.preview.<domínio>` → container da bancada (HTTP + WS).
# Existe porque o Coder publica por CAMINHO, e o caminho quebra o dev server:
# asset absoluto (`/@vite/client`) cai na raiz do Coder, não no app.
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Read-only GitHub Packages token for the private @cold-code-labs/* deps, passed
# as a build ARG (NODE_AUTH_TOKEN; Coolify is_buildtime). Visible in image
# history — acceptable for this internal tool (same posture as Heimdall OSS).
ARG NODE_AUTH_TOKEN
# ── Deps fetched from the lockfile alone, cached across source-only commits ──
# (rationale in apps/web/Dockerfile): copy only what pnpm needs to resolve the
# closure, `pnpm fetch` fills the store keyed on the lockfile, then an offline
# install links from it. A source-only commit reuses the fetch layer wholesale.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    NODE_AUTH_TOKEN="$NODE_AUTH_TOKEN" pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    NODE_AUTH_TOKEN="$NODE_AUTH_TOKEN" pnpm install --prefer-offline --no-frozen-lockfile
RUN pnpm --filter @brokk/bancada-proxy build
RUN pnpm --filter @brokk/bancada-proxy deploy --prod /out

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/bancada-proxy/dist ./dist
COPY --from=build /repo/apps/bancada-proxy/package.json ./package.json
EXPOSE 3020
CMD ["node", "dist/index.js"]
