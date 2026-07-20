# syntax=docker/dockerfile:1
# Build context is the repo root:  docker build -f apps/chat/Dockerfile .
#
# Sindri — the interactive chat agent. Shells out to git/gh in session checkouts
# and drives Claude (API/CLI) or Cursor (API/CLI) engines.
#
# ⚠️ DEBIAN, NOT ALPINE — same load-bearing reason as the forge (BROKK-35 / BROKK-27):
# the Cursor Agent CLI ships a glibc-linked Node; on musl it dies with "cannot
# execute: required file not found". gcompat / alpine-pkg-glibc don't rescue it.
# Alpine historically advertised the Cursor CLI chip while `cursorCliAvailable()`
# was always false — that was BROKK-34's "unavailable" marker. This image fixes
# the motor instead.
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
RUN pnpm --filter @brokk/chat-app build
RUN pnpm --filter @brokk/chat-app deploy --prod /out

# brokk-sandbox — the Landlock FS jail for the bash hand (isolation Nível 2). Tiny
# static Go binary (CGO off → runs on alpine musl or debian glibc alike).
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
# git + gh: Sindri reads/writes the session checkout and opens PRs via the CLIs.
# ripgrep + GNU grep/findutils: the system prompt tells Sindri to search with
# "ripgrep/grep/find" — without them the agent's natural search commands error.
# nftables + gosu power the Nível 3 egress jail (root entrypoint installs the nft
# ruleset then drops to the worker uid). See tools/brokk-egress.
#
# Debian package names (vs the old Alpine set): su-exec → gosu; chromium-browser → chromium.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client ripgrep grep findutils coreutils sed \
      nftables gosu tini curl ca-certificates gnupg \
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

# Claude Code CLI — opt-in engine lane (engine=claude-cli). Pinned; auth is
# CLAUDE_CODE_OAUTH_TOKEN at runtime.
RUN npm install -g @anthropic-ai/claude-code@2.1.207

# Cursor Agent CLI — engine=cursor-cli (--model auto). This is what the Debian
# base exists for (BROKK-35). Installed to a shared HOME, symlinked as both
# `cursor-agent` and `agent` (what cursorCliAvailable() probes).
#
# ⚠️ The installer is NOT pinnable and the binary self-updates — standing cost of
# this lane; cursorCliAvailable() returns false if it ever stops running.
RUN curl -fsSL https://cursor.com/install | HOME=/opt/cursor-home bash \
 && ln -sf /opt/cursor-home/.local/bin/cursor-agent /usr/local/bin/cursor-agent \
 && ln -sf /opt/cursor-home/.local/bin/cursor-agent /usr/local/bin/agent \
 && chmod -R a+rX /opt/cursor-home \
 && cursor-agent --version

# Playwright MCP — "QA na conversa" (ADR 0054): a claude-cli Sindri session mounts
# these browser tools (registered at boot) to drive the live preview. Chromium is
# the system one above. Inert on non-cli sessions.
RUN npm install -g @playwright/mcp@0.0.78

# Isolation Nível 3 (egress uid-split). Second unprivileged uid (1002, gid 1001)
# the bash hand drops to; nft firewalls it off RFC1918. HOME shared + group-writable.
# Debian: groupadd/useradd (not busybox addgroup/adduser); `-M` = no home dir.
RUN groupadd -g 1001 brokk 2>/dev/null || true \
 && useradd -M -u 1002 -g brokk -d /home/brokk -s /usr/sbin/nologin brokk-bash 2>/dev/null || true \
 && mkdir -p /home/brokk && chown 1001:1001 /home/brokk && chmod 2775 /home/brokk \
 && git config --system --add safe.directory '*' \
 && git config --system credential."https://github.com".helper '!/usr/bin/gh auth git-credential' \
 && git config --system credential."https://gist.github.com".helper '!/usr/bin/gh auth git-credential'
# gh credential helper (system-wide): Sindri publishes via the model's plain `git push`
# in bash. Post-flip that push routes to THIS worker (creds side of the enclave split);
# without a helper git can't turn GH_TOKEN into HTTPS auth ("could not read Username").
COPY --from=sandbox /brokk-sandbox /usr/local/bin/brokk-sandbox
RUN chown 1002:1001 /usr/local/bin/brokk-sandbox && chmod 4750 /usr/local/bin/brokk-sandbox
COPY tools/brokk-egress/egress.nft /etc/brokk/egress.nft
COPY tools/brokk-egress/entrypoint.sh /usr/local/bin/brokk-entrypoint.sh
RUN chmod 0755 /usr/local/bin/brokk-entrypoint.sh
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/chat/dist ./dist
COPY --from=build /repo/apps/chat/package.json ./package.json
# Instruction skills (skills/*/SKILL.md) — catalogue for invoke_skill + pin chip.
COPY --from=build /repo/skills /app/skills
ENV BROKK_SKILLS_DIR=/app/skills
EXPOSE 8795
# tini as PID 1 reaps zombies — chromium (the QA driver's browser) detaches
# helpers that escape a process-group kill and reparent to PID 1.
# ⚠️ /usr/bin/tini on Debian (Alpine used /sbin/tini) — wrong path = instant exit.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/brokk-entrypoint.sh"]
CMD ["node", "dist/index.js"]
