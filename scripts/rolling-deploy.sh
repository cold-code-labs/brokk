#!/usr/bin/env bash
# Zero-downtime rolling deploy for Brokk's web tier.
#
# `web` runs as two always-on replicas behind Traefik (web-blue, web-green), both
# on the shared image brokk-web:local. This rebuilds the image, then recreates the
# replicas ONE AT A TIME: while one is recreating, the other serves; Traefik's
# healthcheck drops the recreating replica and its retry middleware re-sends any
# request that raced the swap. No request is dropped.
#
# Usage:  scripts/rolling-deploy.sh                 # roll the web tier
#         COMPOSE_FILES="-f docker-compose.yml -f docker-compose.surtr.yml" scripts/rolling-deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

REPLICAS=(web-blue web-green)
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
# shellcheck disable=SC2086
dc() { docker compose ${COMPOSE_FILES:-} "$@"; }
log() { printf '\033[36m[rollout]\033[0m %s\n' "$*"; }

wait_healthy() {
  local name="$1" deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while :; do
    local id status
    id="$(dc ps -q "$name")"
    [ -n "$id" ] && status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo missing)" || status=missing
    case "$status" in
      healthy|running) return 0 ;;
      unhealthy|exited|dead) log "$name went $status"; return 1 ;;
    esac
    [ "$(date +%s)" -ge "$deadline" ] && { log "$name: timeout waiting for health"; return 1; }
    sleep 2
  done
}

log "building new web image (brokk-web:local)…"
dc build web-blue

for r in "${REPLICAS[@]}"; do
  log "recreating $r (the other replica keeps serving)…"
  dc up -d --no-deps --force-recreate "$r"
  if ! wait_healthy "$r"; then
    log "ABORT: $r unhealthy after recreate. The other replica is still up on the OLD image."
    log "Investigate, then re-run. (No traffic was shifted to the bad replica — Traefik gates on health.)"
    exit 1
  fi
  log "$r healthy ✓"
done

log "done — web rolled with zero downtime (both replicas on the new image)."
