# Build context is the repo root:  docker build -f packages/eitri/Dockerfile .
#
# Eitri — the PR reviewer. Watches open Brokk PRs and drives the Claude Agent SDK
# to review (and optionally revise) them. Debian-based (not alpine): the security
# ward's semgrep ships glibc-only wheels, so musl/alpine can't run it.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @brokk/eitri build
RUN pnpm --filter @brokk/eitri deploy --prod /out

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Tooling Eitri shells out to: git/gh (PR ops), trivy + semgrep (the security
# ward), claude-code (the reviewer brain). gh via its official apt repo.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates curl gnupg python3 python3-venv pipx \
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
RUN npm install -g @anthropic-ai/claude-code
# Eitri runs as uid 1001 with HOME=/home/brokk; make it real + writable so the
# scanners' caches (~/.cache/trivy, ~/.semgrep) don't EACCES at scan time.
RUN mkdir -p /home/brokk && chown -R 1001:1001 /home/brokk
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/packages/eitri/dist ./dist
COPY --from=build /repo/packages/eitri/package.json ./package.json
CMD ["node", "dist/index.js"]
