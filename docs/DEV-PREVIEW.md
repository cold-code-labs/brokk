# Brokk — Dev branch + on-demand preview

> Scope (v1, agreed): make Eitri's PR → merge-into-`dev` frictionless, and bolt a
> **disposable, on-demand preview of the `dev` branch** on top of it — for client
> demos and quick iteration. **Branch + DB level only.**
>
> **Non-goals (deliberately deferred):** no per-app sidecar / standing dev Coolify
> app, no Heimdall involvement, no ephemeral per-feature-branch envs. "We improve
> later." This doc is the whole v1.

## The shape

```
forge → PR (base = dev) → Eitri review
   ├─ REQUEST_CHANGES → revise task (same PR, capped rounds)   [exists]
   └─ gate-passing     → squash-merge into `dev`               [exists]
                              │
                       on demand: "Preview dev"
                              ▼
        runner runs the `dev` branch against the <app>-dev Hauldr DB,
        served at <app>-dev.preview.coldcodelabs.com — idle-reaped.
```

Two ingredients per app, both already primitives:
1. **`dev` branch** — Eitri already merges forge PRs into it.
2. **`<app>-dev` Hauldr project** — one `POST /v1/projects` = `CREATE DATABASE
   db_<app>-dev` + own GoTrue/JWT on the shared core. Internal, cheap, no extra container.

## Part 1 — ease Eitri to PR/merge  (mostly built)

Eitri already does the loop in `packages/eitri/src/index.ts`:
- forge PRs (`brokk/*`) get reviewed; gate-passing verdict + `autoMerge` + mergeable
  → `git.mergePr` squash-merge; `REQUEST_CHANGES` → enqueues a `revise` task (capped
  at `EITRI_MAX_REVISIONS`); **never auto-merges a PR whose base is `main`** (the rail).

**The only finish:** forge PRs must **target `dev`**, so Eitri auto-merges them (it
refuses `main`). That means **project `base_branch = "dev"`** (schema default is
`main`). Action items:
- Default new projects' `baseBranch` to `dev`; backfill existing fleet projects.
- Runner: if `baseBranch` doesn't exist on the repo yet, create `dev` off the default
  branch on first forge (one-time, in `GhProvider.worktree`).
- Board: show the "merged → dev" state on the card (Eitri already records it).

No new review/merge logic.

## Part 2 — on-demand preview  (the new piece)

**One preview slot per app**, of the `dev` branch, started on demand, idle-reaped.
Stable subdomain `<app>-dev.preview.coldcodelabs.com`. Not per-request, not per-branch.

### Ingress — the only shared infra
**One pre-set wildcard `*.preview.coldcodelabs.com` → surtr tunnel → preview gateway**
(set once, exactly like `brokk.coldcodelabs.com` already is). Every preview borrows it
by Host header — *not* a per-app sidecar. The gateway is a tiny reverse proxy on the
runner host that maps `<sub>.preview.coldcodelabs.com` → the local port of that
preview's process. (Caddy/Traefik file-provider or a ~50-line node proxy reading the
`previews` table — implementer's call; node proxy keeps it in-repo and dependency-free.)

### Data model — new table `previews` (`@brokk/db`)
```
previews:
  id            uuid pk
  project_id    uuid → projects
  branch        text   default 'dev'
  subdomain     text   unique           -- "<app>-dev"
  url           text                    -- https://<sub>.preview.coldcodelabs.com
  port          integer                 -- assigned local port on the runner host
  hauldr_project text                   -- "<app>-dev"
  status        enum starting|live|stopped|failed
  pid           integer                 -- runner process handle (best-effort)
  last_seen_at  timestamptz             -- bumped by the gateway on each request
  expires_at    timestamptz             -- idle TTL (default now + 30m, slid on traffic)
  created_at/updated_at
```

### API (`@brokk/api`, same shared-secret pattern as runner endpoints)
- `POST   /previews { projectId, branch?="dev" }` → ensure-and-start; returns the row+url
- `GET    /previews/:id` · `GET /previews?projectId=` → status
- `DELETE /previews/:id` → stop (kill process, free port, status=stopped)

### Runner — preview supervisor (new loop, separate from the forge claim loop)
On `POST /previews`:
1. Ensure the `<app>-dev` **Hauldr project** exists — `GET /v1/projects/<app>-dev`,
   else `POST /v1/projects { name }`. Read back `gotrue_url`, `jwt_secret`,
   `postgrest_url`, internal `dbUrl`.
2. Check out `dev` in a **persistent** worktree (reuse `GhProvider`; one per app, refreshed
   on start — not torn down like a run worktree).
3. Assign a free port; start the preview process with the Hauldr-dev env injected
   (`previewCmd` per project, default for template-light = build + start on `$PORT`).
4. Register `<app>-dev` in the gateway → status `live`, set `expires_at`.
5. **Reaper:** background tick stops processes past `expires_at`; the gateway slides
   `last_seen_at`/`expires_at` on each proxied request, so an active demo never dies
   mid-show and an abandoned one frees RAM. Manual `DELETE` stops immediately.

`previewCmd` is a per-project string (env-overridable, like `BROKK_VERIFY_CMD`).
Template-light default builds then `next start -p $PORT`.

### RAM budget (BROKK-37) — webpack, not Turbopack
Next.js 16+ defaults `next dev` to **Turbopack** (~4GB RSS per preview) — inviável
when the forge densifies many live apps. Sleipnir's `densifyNextPreview` strips
`--turbo`/`--turbopack` and, for Next ≥16, injects `--webpack` so previews stay on
webpack/SWC (~1–1.5GB). Next 15 already defaults to webpack (`--webpack` would be
an unknown option there).

Operational ceiling to plan against: **~1.5GB per Next preview**. The forge
container `mem_limit` (4–6g in `docker-compose.forge.yml`) is the host budget for
the runner **plus** N concurrent previews — keep N such that `1.5GB × N` fits under
that ceiling with headroom for the forge itself. Override `BROKK_PREVIEW_DEV_CMD`
only if you must, and never with Turbopack flags.

### Board (`apps/web`)
- "Preview dev" button on each project (Fleet card + project board) → calls `POST /previews`,
   shows a live URL chip + Stop. Status: starting → live (link) → stopped/failed.

## Promotion (out of v1, noted)
Promote `dev` → prod by a **human** merge `dev` → `main` (Eitri's rail keeps prod
manual). The Hauldr dev→prod migrator is **not** in this scope — promotion stays
manual until we want it.

## Build cards (decomposition for the forge)
1. **db**: `previews` table + store helpers (insert/get/list/byProject/setStatus/touch/stop).
2. **core**: `Preview` type + `Hauldr` port (ensureProject/getProject) in `@brokk/core`.
3. **api**: `/previews` routes (shared-secret) + SDK methods + types.
4. **runner**: Hauldr client (`POST/GET /v1/projects`) + preview supervisor + port alloc
   + `previewCmd` + reaper.
5. **gateway**: `*.preview` reverse proxy (Host → port from `previews`) + `last_seen_at` bump;
   pre-set the surtr tunnel wildcard + CNAME.
6. **web**: "Preview dev" button + status chip + Stop.
7. **config**: default `base_branch=dev` for projects + backfill; one-time `dev`-branch
   creation in the runner.
