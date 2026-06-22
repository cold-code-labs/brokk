# Build context is the repo root:  docker build -f packages/eitri/Dockerfile .
#
# Eitri — the PR reviewer. Watches open Brokk PRs and drives the Claude Agent SDK
# to review (and optionally revise) them.
FROM node:22-alpine AS base
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
RUN apk add --no-cache git github-cli openssh-client \
 && npm install -g @anthropic-ai/claude-code
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/packages/eitri/dist ./dist
COPY --from=build /repo/packages/eitri/package.json ./package.json
CMD ["node", "dist/index.js"]
