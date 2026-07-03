#!/usr/bin/env bash
# Brokk DEV lane deploy (docker compose). Serves https://brokk.preview.coldcodelabs.com
# (open shell, no Logto; isolated brokk-db-dev on :5435).
# Migrated systemd -> docker compose 2026-06-23 (mirrors prod deploy.sh).
#
# CANONICAL, versioned copy. The executable on surtr lives at
# /home/brokk/deploy-dev.sh and is installed from THIS file — keep them in sync
# (Midgard docs/PORTABILITY.md tracks this). Run as: sudo /home/brokk/deploy-dev.sh
set -euo pipefail
cd /home/brokk/brokk-dev
COMPOSE=(docker compose -f docker-compose.yml -f deploy/docker-compose.dev.yml -p brokk-dev)

echo "[deploy-dev] pull dev + install + drizzle push (as brokk)…"
sudo -u brokk -H bash -lc '
  set -euo pipefail
  cd ~/brokk-dev && git fetch origin -q && git checkout dev -q && git reset --hard origin/dev -q
  # Source env BEFORE install so NODE_AUTH_TOKEN is set — else pnpm hangs fetching
  # the private @cold-code-labs/yggdrasil-* packages (.npmrc uses ${NODE_AUTH_TOKEN}).
  set -a; . /home/brokk/brokk-dev.env; set +a
  pnpm install --silent
  # Non-fatal: a stale dev DB makes drizzle-kit prompt (no TTY) and exit non-zero.
  pnpm --filter @brokk/db exec drizzle-kit push --force < /dev/null || echo "[deploy-dev] drizzle WARN (schema push skipped)"
'

echo "[deploy-dev] build + recreate dev containers…"
# Source brokk-dev.env so compose can interpolate required vars (e.g. BROKK_RUNNER_SECRET
# on the profile-gated forge services). Values are single-quoted -> no && execution.
set -a; . /home/brokk/brokk-dev.env; set +a
# Defensive: drop the legacy blue/green container that would otherwise hold :3011
# and block the current `web` service from binding (old compose used `web-blue`).
docker rm -f brokk-dev-web-blue-1 >/dev/null 2>&1 || true
# Rename-proof: build/recreate exactly the services the merged compose defines,
# instead of hard-coding names that drift (that is what broke on web-blue->web).
mapfile -t SERVICES < <("${COMPOSE[@]}" config --services)
"${COMPOSE[@]}" build "${SERVICES[@]}"
"${COMPOSE[@]}" up -d --force-recreate "${SERVICES[@]}"
sleep 6
"${COMPOSE[@]}" ps
echo "[deploy-dev] done → https://brokk.preview.coldcodelabs.com"
