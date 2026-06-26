# syntax=docker/dockerfile:1
# Build context is the repo root:  docker build -f apps/api/Dockerfile .
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Read-only GitHub Packages token for the private @cold-code-labs/* deps, passed
# as a BuildKit secret — never an ARG, so it stays out of image layers and logs.
COPY . .
RUN --mount=type=secret,id=node_auth,env=NODE_AUTH_TOKEN pnpm install --no-frozen-lockfile
RUN pnpm --filter @brokk/api build
# Self-contained prod tree (only @brokk/api's external deps; workspace
# packages are already bundled into dist by tsup).
RUN pnpm --filter @brokk/api deploy --prod /out

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
# `gh` — the /repositories/import/candidates route shells out to `gh repo list`
# to offer connectable org repos (auth via the GITHUB_TOKEN env).
RUN apk add --no-cache github-cli
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/package.json ./package.json
EXPOSE 8789
CMD ["node", "dist/index.js"]
