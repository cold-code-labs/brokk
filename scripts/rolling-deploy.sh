#!/usr/bin/env bash
# Zero-downtime rolling deploy for a Brokk compose service (default: web).
#
# The "docker-rollout" pattern: build the new image, bring up a second replica
# next to the running one, wait until it passes its healthcheck, then drain and
# remove the old replica. Traefik load-balances across both during the swap and
# only routes to healthy containers — so no in-flight request is dropped.
#
# Usage:  scripts/rolling-deploy.sh [service]      # service defaults to "web"
#         HEALTH_TIMEOUT=240 scripts/rolling-deploy.sh web
set -euo pipefail
cd "$(dirname "$0")/.."

SVC="${1:-web}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
dc() { docker compose "$@"; }
log() { printf '\033[36m[rollout]\033[0m %s\n' "$*"; }

old_ids="$(dc ps -q "$SVC" || true)"
n="$(printf '%s\n' "$old_ids" | grep -c . || true)"
[ "$n" -eq 0 ] && { log "no running '$SVC' — doing a plain up"; dc up -d --build "$SVC"; exit 0; }
log "service=$SVC  current replicas=$n"

log "building new image…"
dc build "$SVC"

log "starting new replica(s) alongside the old…"
dc up -d --no-deps --no-recreate --scale "$SVC=$((n * 2))" "$SVC"

all_ids="$(dc ps -q "$SVC")"
new_ids="$(comm -23 <(printf '%s\n' "$all_ids" | sort) <(printf '%s\n' "$old_ids" | sort))"
[ -z "$new_ids" ] && { log "no new replica appeared — aborting (old kept serving)"; exit 1; }

abort() { log "$1 — aborting, old replicas kept serving"; docker rm -f $new_ids >/dev/null 2>&1 || true; dc up -d --no-deps --no-recreate --scale "$SVC=$n" "$SVC" >/dev/null 2>&1 || true; exit 1; }

log "waiting for new replica(s) to become healthy (timeout ${HEALTH_TIMEOUT}s)…"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
for id in $new_ids; do
  while :; do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo missing)"
    case "$status" in
      healthy|running) break ;;
      unhealthy|exited|dead|missing) abort "replica $id is $status" ;;
    esac
    [ "$(date +%s)" -ge "$deadline" ] && abort "timeout waiting for health"
    sleep 2
  done
done
log "new replica(s) healthy ✓"

log "draining + removing old replica(s)…"
for id in $old_ids; do docker stop -t 30 "$id" >/dev/null && docker rm "$id" >/dev/null; done

log "settling back to $n replica(s)…"
dc up -d --no-deps --no-recreate --scale "$SVC=$n" "$SVC"
log "done — '$SVC' rolled with zero downtime."
