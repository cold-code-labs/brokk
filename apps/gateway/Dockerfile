# Build context is the repo root:  docker build -f apps/gateway/Dockerfile .
#
# Preview reverse proxy — routes *.preview hostnames to the per-preview ports the
# runner allocates (HTTP + WebSocket).
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @brokk/gateway build
RUN pnpm --filter @brokk/gateway deploy --prod /out

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/gateway/dist ./dist
COPY --from=build /repo/apps/gateway/package.json ./package.json
EXPOSE 3020
CMD ["node", "dist/index.js"]
