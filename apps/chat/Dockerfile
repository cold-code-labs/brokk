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

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
# git + gh: Sindri reads/writes the session checkout and opens PRs via the CLIs.
RUN apk add --no-cache git github-cli openssh-client
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/chat/dist ./dist
COPY --from=build /repo/apps/chat/package.json ./package.json
EXPOSE 8795
CMD ["node", "dist/index.js"]
