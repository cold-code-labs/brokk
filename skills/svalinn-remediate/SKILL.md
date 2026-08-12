---
name: svalinn-remediate
description: >-
  House playbook: scan a project's security debt (Svalinn + other sources),
  triage each open finding as fix or wontfix with a written reason, smoke one
  finding end-to-end, then run the full remediation belt until the Svalinn
  board is clean. Use for "scanear status", "corrigir Svalinn", "remediar
  findings", "limpar o board do Svalinn", or when House Atenção points at
  open sec debt.
---

# Svalinn remediate (House playbook)

High-level belt for **one Brokk House project**. The human locks a House
objective; this skill is the operating manual the Chat/agent follows until the
Svalinn board for that target is clean (`open` → `fixed` | `wontfix`).

## Button metaphor — Scan status

When the operator says **scanear status** / **scan** / pins this skill and asks
for a status pass, run **Phase 0** only and stop with a placard. Do not forge
until they say **ativar esteira** / **seguir** / **smoke** / **remediar**.

## Non-negotiables

1. Findings live in Svalinn. Brokk **never** opens `db_svalinn`. Talk HTTP:
   - House/Chat: `GET /api/svalinn/board` and `GET /api/svalinn/targets/:slug/findings` (Brokk proxies, Bearer already injected).
   - Direct (ops): `GET https://svalinn.coldcodelabs.com/api/machine/board` with `Authorization: Bearer $SVALINN_MACHINE_TOKEN`.
2. Class is `finding.class` (`code_bug` | `noise` | `process_policy` | `systemic_infra`).
3. Every status change needs a **note** (≥10 chars) via `POST /api/svalinn/findings/:id/status` or bulk `POST /api/svalinn/findings/status`. A dismissal without a reason is not a decision.
4. Card `done` in Brokk ≠ `fixed` in Svalinn. Promote to `fixed` only after the sink is closed. Exploit-class stays `awaiting_verification` until negative control (`docs/LOOP.md`).
5. Prefer **clusters** (`clusterKey`) over one PR per finding. Optional: `POST /api/machine/dispatch` on Svalinn to hand the cluster to Forge.

Do **not** SSH → psql. If the machine API 503s, stop and fix the token — do not fall back to SQL.

## Phase 0 — Scan status (the "button")

Collect one placard. Sources, in order:

| # | Source | How |
|---|--------|-----|
| 1 | **Svalinn** | `GET /api/svalinn/board` + `GET /api/svalinn/targets/<slug>/findings?status=open` |
| 2 | **Brokk House** | project card: queue / review / failed; locked `houseObjective`; open sec-related cards |
| 3 | **GitHub** | open Dependabot / CodeQL / failing checks on default branch |
| 4 | **Coolify / health** | `GET /api/health` on prod host when the project has one |
| 5 | **Ingress** | any `brokk_dispatches` still non-terminal for this target |

SQL access pattern (quoting breaks if nested inline):

```text
ssh ymir → write .sql file → scp surtr-docker → docker cp hauldr-db-v17 →
psql -U supabase_admin -d db_svalinn -f …
```

**Placard shape (always):**

```text
Target: <slug> (<uuid>)
Report: <title> · <iso>
Open: N  (critical/high/med/low/bug)
By class: code_bug=… noise=… process_policy=… systemic_infra=…
Clusters (proposed): …
Smoke candidate: <id> — <title>  (smallest high code_bug with clear sink)
Other sources: GH … · House … · health …
```

Stop here on a pure scan request.

## Phase 1 — Triage parse (fix | wontfix)

For every **open** finding, assign a destination **before** coding the whole
board:

| Class | Default |
|-------|---------|
| `code_bug` | **fix** (cluster by root cause) |
| `noise` | **wontfix** with reason (dedup Trivy↔OSV, scanner FP, HEALTHCHECK, formatstring) — unless a real bump is cheap and correct |
| `process_policy` | **wontfix** only with product justification (e.g. workspace-shared RLS `using (true)` by design) — else fix |
| `systemic_infra` | fleet playbook / Coolify secret hygiene — note + escalate; do not fake a code fix |

Write the triage table in the project `docs/seguranca/0N-svalinn-*.md` as you go.

## Phase 2 — Smoke (exactly one finding, end-to-end)

Pick the placard's **smoke candidate** (prefer a high `code_bug` with a local
helper already in-tree — e.g. missing `sanitizeUrl` call).

1. Branch `fix/svalinn-<slug>` from the product default branch.
2. Apply the minimal fix; add/adjust a unit test when the sink is pure function.
3. Verify locally (`pnpm` test/typecheck scoped to the change; product build
   command from the runbook — Bragi: `pnpm build:vite`, never rely on broken
   `next build`).
4. Commit on the fix branch.
5. Close the finding via Brokk (or Svalinn machine API):

```http
POST /api/svalinn/findings/<id>/status
{ "status": "fixed", "note": "fixed on fix/svalinn-<slug> — <why>", "ref": "<commit>" }
```

Do not UPDATE findings over SQL.

6. Re-query: that id must not be `open`. Report smoke **PASS** with id + ref.
7. Only then unlock Phase 3.

## Phase 3 — Full belt

Process clusters worst-first (`critical` → `high` → `bug` → `medium` → `low`):

1. Implement the cluster on the same `fix/svalinn-<slug>` branch (or stacked
   PRs if the diff is huge — still one root cause per PR).
2. After each cluster lands, `POST /api/svalinn/findings/status` with the ids + note.
3. Keep the placard fresh (`Scan status` again) after every cluster.
4. Exit when `open` count for the target is **0** (or only documented
   `awaiting_verification` waiting on human negative control).

## House wiring

- Lock a House objective on the project card, e.g.
  `Limpar Svalinn <slug> (scan → smoke → belt)`.
- Micro-steps: Scan status → Smoke 1 → Cluster highs → Deps/noise triage →
  Close board → Doc `docs/seguranca/…`.
- Round outcome: `assurance` + `pr_merged` (or direct main when the repo
  policy says so).
- Pin this skill in Chat (`/svalinn-remediate`) for the whole round.

### Start + watch through Brokk (preferred)

```http
POST /api/ops/start
{ "kind": "svalinn-smoke", "targetSlug": "<slug>" }
```

Returns `job` / `pulse` / `events`. Poll `GET /api/ops/jobs/:taskId` until
`terminal`. House card border: amber (`queued`) → ember (`forging`) → idle/review.
See `docs/OPS.md`. Do **not** SSH/psql; do **not** close findings until the PR
lands — then `POST /api/svalinn/findings/:id/status`.

## Bragi-specific anchors (when target = bragi)

- Prod is **Vite + Hono**; Next routes are not served — fix `server/*` and
  shared `lib/*`, not only `app/api/*`.
- Dominant report themes: XSS href, SSRF logo→Satori, intake leads
  fail-open, `LOGTO_COOKIE_SECRET` fallback, IG publish races, `ip-address` /
  hono bumps.
- RLS `using (true)` hits are usually **workspace-shared by design** →
  `wontfix` with that reason after confirming `pg_class.relrowsecurity`.
- `NODE_AUTH_TOKEN` as Docker build-arg → `systemic_infra` / fleet Coolify
  playbook, not a Bragi-only patch.

## Anti-patterns

- Marking `fixed` because Brokk verify was green.
- Bulk `wontfix` without per-finding (or per-cluster) notes.
- Fixing only the Next path while the Hono path stays open.
- Starting the full belt before smoke closes **one** finding in the DB.
- Inventing findings from memory — always re-read the machine API.
- SSH into Postgres because "the API isn't up yet".
