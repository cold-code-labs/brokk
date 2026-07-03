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

# brokk-sandbox — the Landlock FS jail for the bash hand (isolation Nível 2). A
# tiny static Go binary (CGO off → runs on alpine musl or debian glibc alike),
# dropped on PATH so packages/afl picks it up automatically.
FROM golang:1.24-alpine AS sandbox
ENV GOTOOLCHAIN=local CGO_ENABLED=0
WORKDIR /src
COPY tools/brokk-sandbox/go.mod tools/brokk-sandbox/go.sum ./
RUN go mod download
COPY tools/brokk-sandbox/ ./
RUN go build -ldflags="-s -w" -o /brokk-sandbox .

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
#
# nftables + su-exec power the Nível 3 egress jail: the root entrypoint installs the
# ruleset (CAP_NET_ADMIN) then su-execs down to the worker uid. See tools/brokk-egress.
RUN apk add --no-cache git github-cli openssh-client nftables su-exec \
      chromium nss freetype harfbuzz ca-certificates ttf-freefont font-noto-emoji
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Isolation Nível 3 (egress uid-split). A second unprivileged uid (1002, same gid as
# the worker's 1001) that the bash hand drops to; the nft ruleset firewalls it off
# RFC1918. HOME is shared + group-writable (setgid dir) so both uids write the
# caches; git safe.directory='*' so the shell, as 1002, can operate 1001-owned repos.
RUN addgroup -g 1001 brokk 2>/dev/null || true \
 && adduser -D -H -u 1002 -G brokk -h /home/brokk brokk-bash 2>/dev/null || true \
 && mkdir -p /home/brokk && chown 1001:1001 /home/brokk && chmod 2775 /home/brokk \
 && git config --system --add safe.directory '*'
# brokk-sandbox ships SETUID to uid 1002 (owner-exec setuid; no root needed at run):
# node (1001, in group 1001) execs it → euid 1002 → it drops fully, then Landlock+exec.
COPY --from=sandbox /brokk-sandbox /usr/local/bin/brokk-sandbox
RUN chown 1002:1001 /usr/local/bin/brokk-sandbox && chmod 4750 /usr/local/bin/brokk-sandbox
COPY tools/brokk-egress/egress.nft /etc/brokk/egress.nft
COPY tools/brokk-egress/entrypoint.sh /usr/local/bin/brokk-entrypoint.sh
RUN chmod 0755 /usr/local/bin/brokk-entrypoint.sh
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/forge/dist ./dist
COPY --from=build /repo/apps/forge/package.json ./package.json
ENTRYPOINT ["/usr/local/bin/brokk-entrypoint.sh"]
CMD ["node", "dist/index.js"]
