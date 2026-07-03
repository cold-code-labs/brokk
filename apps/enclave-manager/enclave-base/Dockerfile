# The default execution-enclave runtime image (ADR 0010 Fase 1). The manager builds
# this on the host (via the Docker socket) if `brokk-enclave-base:latest` is absent,
# so it's reproducible from the repo and self-heals on a fresh host — no manual step.
#
# node:22 (NOT 20) — pnpm 11 uses a builtin that node 20 lacks (ERR_UNKNOWN_BUILTIN_
# MODULE). git + openssh for repo ops; corepack provides pnpm/yarn on first use.
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
