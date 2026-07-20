# syntax=docker/dockerfile:1
# Build context is the repo root:  docker build -f apps/forge/Dockerfile .
#
# The forge worker. Pulls cards off the control plane, spins an isolated git
# worktree, and drives the native @brokk/afl agent loop to write the change + open
# a PR.
# ⚠️ DEBIAN, NOT ALPINE — and the reason is load-bearing. The Cursor Agent CLI
# (BROKK_FORGE_ENGINE=cursor-cli) ships a glibc-linked Node inside its installer;
# on musl it dies with "cannot execute: required file not found". Measured: neither
# `gcompat` (fcntl64: symbol not found) nor a hand-assembled alpine-pkg-glibc
# rescues it — the latter only walks the dependency chase forward one library at a
# time (ld-linux → libstdc++ → libgcc_s …) and would leave a franken-image
# supporting a CLI that self-updates. A glibc base costs once; that would cost
# every time Cursor ships a version.
FROM node:22-slim AS base
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
# Debian package names, translated from the alpine set. Two swaps carry meaning:
#   su-exec → gosu   (the entrypoint's drop() already probes for both)
#   chromium-browser → chromium   (Debian's binary path differs; PLAYWRIGHT_… below)
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client nftables gosu tini curl ca-certificates gnupg \
      chromium libnss3 libfreetype6 libharfbuzz0b fonts-freefont-ttf fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

# gh has no Debian-main package — pull it from GitHub's own apt repo, keyed.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Claude Code CLI — the second engine (BROKK_FORGE_ENGINE=cli). Pinned; auth is
# CLAUDE_CODE_OAUTH_TOKEN at runtime.
RUN npm install -g @anthropic-ai/claude-code@2.1.207

# Cursor Agent CLI — the DEFAULT engine (BROKK_FORGE_ENGINE=cursor-cli, --model
# auto). This is what the Debian base exists for. Installed to a shared HOME so
# every uid in the container resolves it, then symlinked onto PATH under both
# names the code probes (`cursor-agent` and `agent`).
#
# ⚠️ The installer is NOT pinnable and the binary self-updates — a future version
# can change its runtime deps under us. That is the standing cost of this lane;
# `cursorCliAvailable()` degrades to the native engine if it ever stops running,
# and the forge logs that loudly at boot.
RUN curl -fsSL https://cursor.com/install | HOME=/opt/cursor-home bash \
 && ln -sf /opt/cursor-home/.local/bin/cursor-agent /usr/local/bin/cursor-agent \
 && ln -sf /opt/cursor-home/.local/bin/cursor-agent /usr/local/bin/agent \
 && chmod -R a+rX /opt/cursor-home \
 && cursor-agent --version

# Playwright MCP — the browser hands for driver sessions (ADR 0054), opt-in via
# BROKK_PLAYWRIGHT_MCP. Bin `mcp-server-playwright`; drives the system chromium
# baked above (PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH). Inert unless enabled.
RUN npm install -g @playwright/mcp@0.0.78

# Native Next SWC (glibc) — Turbopack's hard requirement on this Debian forge.
# Preview worktrees often only ship the musl optional dep (wrong libc). The
# supervisor symlinks from here before `next dev` (see next-swc.ts / BROKK-31).
# Warm a few fleet Next versions so the first boot of each doesn't hit npm cold.
# Missing versions are skipped (next releases prune old optionals occasionally).
RUN mkdir -p /opt/brokk/next-swc \
 && cd /tmp \
 && for v in 15.5.7 16.0.7 16.2.6 16.2.10; do \
      npm pack "@next/swc-linux-x64-gnu@${v}" \
      && mkdir -p "/opt/brokk/next-swc/${v}" \
      && tar -xzf next-swc-linux-x64-gnu-*.tgz -C "/opt/brokk/next-swc/${v}" --strip-components=1 \
      && rm -f next-swc-linux-x64-gnu-*.tgz \
      && echo "cached swc-gnu ${v}" \
      || echo "skip swc-gnu ${v} (not on registry)"; \
    done \
 && chmod -R a+rX /opt/brokk/next-swc \
 && ls /opt/brokk/next-swc

# Isolation Nível 3 (egress uid-split). A second unprivileged uid (1002, same gid as
# the worker's 1001) that the bash hand drops to; the nft ruleset firewalls it off
# RFC1918. HOME is shared + group-writable (setgid dir) so both uids write the
# caches; git safe.directory='*' so the shell, as 1002, can operate 1001-owned repos.
# Debian's adduser/addgroup take different flags than busybox's — groupadd/useradd
# are the portable spelling. `-M` is Debian's "no home dir" (busybox `-H`).
RUN groupadd -g 1001 brokk 2>/dev/null || true \
 && useradd -M -u 1002 -g brokk -d /home/brokk -s /usr/sbin/nologin brokk-bash 2>/dev/null || true \
 && mkdir -p /home/brokk && chown 1001:1001 /home/brokk && chmod 2775 /home/brokk \
 && git config --system --add safe.directory '*' \
 && git config --system credential."https://github.com".helper '!/usr/bin/gh auth git-credential' \
 && git config --system credential."https://gist.github.com".helper '!/usr/bin/gh auth git-credential'
# gh credential helper (system-wide) so a bare `git push`/`gh` authenticates via
# GH_TOKEN — codified in the image instead of relying on a `gh auth setup-git` in the
# volume-mounted ~/.gitconfig (which a volume reset would silently drop).
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
# tini as PID 1 reaps zombies. The agent's browser (chromium) detaches helper
# processes that escape a process-group kill and reparent to PID 1; with `node`
# as PID 1 they became <defunct> zombies (node doesn't reap arbitrary orphans)
# and accreted across driver runs (ADR 0054). tini wraps the egress-jail
# entrypoint (still runs as root, still su-execs to 1001) and reaps them.
# ⚠️ /usr/bin/tini, not /sbin/tini — Debian's package installs it there. The old
# alpine path would make the container exit immediately with "no such file", i.e.
# a total outage from a one-word difference.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/brokk-entrypoint.sh"]
CMD ["node", "dist/index.js"]
