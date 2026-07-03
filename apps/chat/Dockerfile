# syntax=docker/dockerfile:1
# Build context is the repo root:  docker build -f apps/chat/Dockerfile .
#
# Sindri — the interactive chat agent. Like the forge runner it shells out to git
# and gh in the session checkouts, but it drives the model over the native
# Messages API (through the CCL gateway), so it carries NO claude CLI.
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
RUN pnpm --filter @brokk/chat-app build
RUN pnpm --filter @brokk/chat-app deploy --prod /out

# brokk-sandbox — the Landlock FS jail for the bash hand (isolation Nível 2). Tiny
# static Go binary (CGO off), dropped on PATH so packages/afl picks it up.
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
# "ripgrep/grep/find" — Alpine ships only BusyBox grep/find (no GNU flags) and no
# rg, so the agent's natural search commands (`rg …`, `grep -rn …`) errored. Install
# the real tools so the prompt's promise holds. (coreutils/sed for good measure.)
# nftables + su-exec power the Nível 3 egress jail (root entrypoint installs the nft
# ruleset then drops to the worker uid). See tools/brokk-egress.
RUN apk add --no-cache git github-cli openssh-client ripgrep grep findutils coreutils sed nftables su-exec

# Isolation Nível 3 (egress uid-split). Second unprivileged uid (1002, gid 1001) the
# bash hand drops to; nft firewalls it off RFC1918. HOME shared + group-writable so
# both uids write caches; git safe.directory='*' so the shell (1002) works 1001 repos.
RUN addgroup -g 1001 brokk 2>/dev/null || true \
 && adduser -D -H -u 1002 -G brokk -h /home/brokk brokk-bash 2>/dev/null || true \
 && mkdir -p /home/brokk && chown 1001:1001 /home/brokk && chmod 2775 /home/brokk \
 && git config --system --add safe.directory '*' \
 && git config --system credential."https://github.com".helper '!/usr/bin/gh auth git-credential' \
 && git config --system credential."https://gist.github.com".helper '!/usr/bin/gh auth git-credential'
# gh credential helper (system-wide): Sindri publishes via the model's plain `git push`
# in bash. Post-flip that push routes to THIS worker (creds side of the enclave split);
# without a helper git can't turn GH_TOKEN into HTTPS auth ("could not read Username").
# `gh auth git-credential` reads GH_TOKEN/GITHUB_TOKEN — the same mechanism the forge's
# ~/.gitconfig uses — so a bare `git push`/`gh` authenticates on the worker.
COPY --from=sandbox /brokk-sandbox /usr/local/bin/brokk-sandbox
RUN chown 1002:1001 /usr/local/bin/brokk-sandbox && chmod 4750 /usr/local/bin/brokk-sandbox
COPY tools/brokk-egress/egress.nft /etc/brokk/egress.nft
COPY tools/brokk-egress/entrypoint.sh /usr/local/bin/brokk-entrypoint.sh
RUN chmod 0755 /usr/local/bin/brokk-entrypoint.sh
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/chat/dist ./dist
COPY --from=build /repo/apps/chat/package.json ./package.json
EXPOSE 8795
ENTRYPOINT ["/usr/local/bin/brokk-entrypoint.sh"]
CMD ["node", "dist/index.js"]
