# Build context is the repo root:  docker build -f apps/api/Dockerfile .
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @brokk/api build
# Self-contained prod tree (only @brokk/api's external deps; workspace
# packages are already bundled into dist by tsup).
RUN pnpm --filter @brokk/api deploy --prod /out

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/package.json ./package.json
EXPOSE 8789
CMD ["node", "dist/index.js"]
