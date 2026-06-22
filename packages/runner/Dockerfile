# Build context is the repo root:  docker build -f packages/runner/Dockerfile .
#
# The forge worker. Pulls cards off the control plane, spins an isolated git
# worktree, and drives the Claude Agent SDK to write the change + open a PR.
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @brokk/runner build
# Self-contained prod tree (only @brokk/runner's external deps).
RUN pnpm --filter @brokk/runner deploy --prod /out

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Host tools the forge shells out to: git + gh, and the Claude Code CLI that the
# Agent SDK drives. To let the agent *build/run* target repos, add `docker-cli`
# here and mount the host Docker socket in compose (DoD — see docker-compose.yml).
RUN apk add --no-cache git github-cli openssh-client \
 && npm install -g @anthropic-ai/claude-code
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/packages/runner/dist ./dist
COPY --from=build /repo/packages/runner/package.json ./package.json
CMD ["node", "dist/index.js"]
