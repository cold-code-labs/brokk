# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN corepack prepare pnpm@9.15.9 --activate && pnpm install --frozen-lockfile
COPY index.html vite.config.ts tsconfig.json ./
COPY extension ./extension
COPY src ./src
COPY shared ./shared
RUN pnpm build
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
WORKDIR /app
ARG SOURCE_COMMIT
ENV NODE_ENV=production PORT=8080 HOST=:: NODE_NO_WARNINGS=1 BROKK_REVISION=${SOURCE_COMMIT}
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN corepack prepare pnpm@9.15.9 --activate && pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY db ./db
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "server/index.ts"]
