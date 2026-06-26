# syntax=docker/dockerfile:1
# Build context is the repo root:  docker build -f apps/forge/Dockerfile .
#
# The forge worker. Pulls cards off the control plane, spins an isolated git
# worktree, and drives the native @brokk/afl agent loop to write the change + open
# a PR.
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Read-only GitHub Packages token for the private @cold-code-labs/* deps, passed
# as a build ARG (NODE_AUTH_TOKEN; Coolify is_buildtime). Visible in image
# history — acceptable for this internal tool (same posture as Heimdall OSS).
COPY . .
ARG NODE_AUTH_TOKEN
RUN NODE_AUTH_TOKEN="$NODE_AUTH_TOKEN" pnpm install --no-frozen-lockfile
RUN pnpm --filter @brokk/forge-app build
# Self-contained prod tree (only @brokk/forge-app's external deps).
RUN pnpm --filter @brokk/forge-app deploy --prod /out

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Host tools the forge shells out to via the bash hand: git + gh. The agent brain
# is the native @brokk/afl loop (bundled in dist) — no claude CLI. To let the agent
# *build/run* target repos, add `docker-cli` here and mount the host Docker socket
# in compose (DoD — see docker-compose.yml).
#
# Chromium powers the browser verify-lane (BROKK_BROWSER / forge-authored e2e
# specs), which the agent now drives from the bash hand (Playwright/chrome-headless
# scripts), not an MCP server. On Alpine/musl, Playwright's own browser download
# won't run, so install the system chromium and point Playwright at it via
# PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH. Inert unless the browser lane is enabled.
RUN apk add --no-cache git github-cli openssh-client \
      chromium nss freetype harfbuzz ca-certificates ttf-freefont font-noto-emoji
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/forge/dist ./dist
COPY --from=build /repo/apps/forge/package.json ./package.json
CMD ["node", "dist/index.js"]
