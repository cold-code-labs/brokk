# syntax=docker/dockerfile:1
# Build context is the repo root:  docker build -f apps/reviewer/Dockerfile .
#
# Eitri — the PR reviewer. Watches open Brokk PRs and reviews (and optionally
# revises) them with the native @brokk/afl agent loop. Debian-based (not alpine):
# the security ward's semgrep ships glibc-only wheels, so musl/alpine can't run it.
FROM node:22-slim AS base
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
RUN pnpm --filter @brokk/reviewer-app build
RUN pnpm --filter @brokk/reviewer-app deploy --prod /out

# brokk-sandbox — the Landlock FS jail for the bash hand (isolation Nível 2). Static
# CGO-off Go binary runs on this debian (glibc) runtime just as on the alpine ones.
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
# Tooling Eitri shells out to: git/gh (PR ops), trivy + semgrep (the security
# ward). The reviewer brain is the native @brokk/afl loop (bundled in dist), so no
# claude CLI is needed. gh via its official apt repo.
# nftables + gosu power the Nível 3 egress jail (root entrypoint installs the nft
# ruleset then drops to the worker uid). See tools/brokk-egress.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates curl gnupg python3 python3-venv pipx nftables gosu \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*
# trivy — static binary onto PATH (dependency CVEs + filesystem secrets).
RUN curl -fsSL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh \
      | sh -s -- -b /usr/local/bin
# semgrep — isolated venv, its entrypoint symlinked onto PATH.
ENV PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin
RUN pipx install semgrep
# Eitri runs as uid 1001 with HOME=/home/brokk; make it real + writable so the
# scanners' caches (~/.cache/trivy, ~/.semgrep) don't EACCES at scan time.
# Isolation Nível 3 (egress uid-split): a second uid (1002, gid 1001) the bash hand
# drops to; nft firewalls it off RFC1918. HOME is group-writable (setgid) so both
# uids write caches; git safe.directory='*' so the shell (1002) works 1001-owned repos.
RUN groupadd -g 1001 brokk 2>/dev/null || true \
 && useradd -M -u 1002 -g 1001 -d /home/brokk brokk-bash 2>/dev/null || true \
 && mkdir -p /home/brokk && chown -R 1001:1001 /home/brokk && chmod 2775 /home/brokk \
 && git config --system --add safe.directory '*'
# brokk-sandbox ships SETUID to uid 1002 (owner-exec setuid; no root at run):
# node (1001, in group 1001) execs it → euid 1002 → it drops fully, then Landlock+exec.
COPY --from=sandbox /brokk-sandbox /usr/local/bin/brokk-sandbox
RUN chown 1002:1001 /usr/local/bin/brokk-sandbox && chmod 4750 /usr/local/bin/brokk-sandbox
COPY tools/brokk-egress/egress.nft /etc/brokk/egress.nft
COPY tools/brokk-egress/entrypoint.sh /usr/local/bin/brokk-entrypoint.sh
RUN chmod 0755 /usr/local/bin/brokk-entrypoint.sh
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/reviewer/dist ./dist
COPY --from=build /repo/apps/reviewer/package.json ./package.json
ENTRYPOINT ["/usr/local/bin/brokk-entrypoint.sh"]
CMD ["node", "dist/index.js"]
