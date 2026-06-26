# syntax=docker/dockerfile:1
# Build context is the repo root:  docker build -f apps/web/Dockerfile .
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
RUN pnpm --filter @brokk/web build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
# Static assets (the brokk.svg logo, etc.) — served by the standalone server.
COPY --from=build /repo/apps/web/public ./apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
