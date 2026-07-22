# syntax=docker/dockerfile:1
# Build context is the repo root:  docker build -f apps/web/Dockerfile .
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
# The old layout put `COPY . .` above install, so ANY edit (even a CSS one-liner
# or docs) busted the install layer on every image. Now: copy just what pnpm
# needs to resolve the closure and `pnpm fetch` fills the store — this layer's
# cache key is the lockfile, so the common source-only push skips it wholesale.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    NODE_AUTH_TOKEN="$NODE_AUTH_TOKEN" pnpm fetch
# Source, then an offline install that hard-links from the fetched store (no
# registry round-trip); --prefer-offline degrades to network only on a miss.
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    NODE_AUTH_TOKEN="$NODE_AUTH_TOKEN" pnpm install --prefer-offline --no-frozen-lockfile
# Next.js persistent build cache (compiler + minifier output) survives deploys
# via a BuildKit cache mount → incremental rebuilds instead of from-zero.
RUN --mount=type=cache,id=next-web,target=/repo/apps/web/.next/cache \
    pnpm --filter @brokk/web build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
# Static assets (the brokk.svg logo, etc.) — served by the standalone server.
COPY --from=build /repo/apps/web/public ./apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# sindri-ai-sdk web image
