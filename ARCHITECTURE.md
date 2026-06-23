# Brokk — Architecture

> CCL's open-source AI **coding-agent** platform. The **code** pillar of the triad:
> **Hauldr** (data) · **Heimdall** (deploy) · **Brokk** (code).
> Named after the dwarf smith who forged the gods' tools (Mjölnir, Gungnir, Draupnir).
> **Open-source, Apache-2.0** (`cold-code-labs/brokk`) — public alongside Hauldr and Heimdall.

## 1. What it is
Card/issue → an AI agent **forges** the code in an isolated git worktree → opens a Pull Request.
Brokk is the **shell** around the agent (board, queue, runner orchestration, GitHub/PR), **not** a
new agent — the **brain is the Claude Agent SDK** (headless). Same idea as Vibe Kanban/Conductor,
but CCL-native, self-hosted, and composable with our context-compression proxy (headroom).

## 2. Principles
- **Engine = Claude Agent SDK** (headless `query()` / `claude -p`). We don't build an agent.
- **Stack mirrors Heimdall OSS**: pnpm monorepo · Hono API · Next 15 web · Drizzle + Postgres. **No PocketBase** (legacy/clients only).
- **Control plane ↔ Runner split**: the API/board is light; the runner does the heavy, isolated work.
- **Internal-only, Max-first**: Brokk runs on the **Max subscription** via the Agent SDK (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`). **API-key mode is deferred** — not designed for yet (revisit if/when Brokk goes multi-tenant or OSS). The engine stays auth-agnostic so the API-key path is a later config flip, not a rewrite.
- **Headroom in the runner's path** (`ANTHROPIC_BASE_URL` → proxy): relevant mode is **`Subscription`** (lossless) — stretches the Max rate-limit window. ($-saving compression only matters in the deferred API-key mode.)
- **Worktree isolation**: one git worktree per run; many runs in parallel; no cross-contamination.

## 3. Topology
```
┌─────────────────────────── Control plane (Coolify app) ───────────────────────────┐
│  apps/web (Next 15)  ── kanban board, cards, run logs, PR view                      │
│  apps/api (Hono)     ── tasks/queue/runs CRUD, runner endpoints, GitHub webhooks    │
│  Postgres (Drizzle)  ── projects, repos, tasks, runs, run_events, agents, PRs       │
└───────────────▲───────────────────────────────────────────────▲────────────────────┘
                │ claim / events / complete (HTTP)                │ webhooks (GitHub)
┌───────────────┴──────────── Runner(s)  (surtr) ────────────────┴────────────────────┐
│  packages/runner ── claim loop → git worktree → Claude Agent SDK (headless) →        │
│                     stream events → commit/push → `gh pr create` → report            │
│  deps on host: git, gh, claude, headroom proxy (ANTHROPIC_BASE_URL=:8787)            │
└──────────────────────────────────────────────────────────────────────────────────────┘
```
Control plane runs anywhere (Coolify). Runner runs on **surtr** (RAM, git, gh, claude, headroom).
Runners are **horizontally scalable** — register N, they pull from the same queue.

## 4. Monorepo layout (mirrors heimdall-oss)
```
brokk/
├── pnpm-workspace.yaml        # apps/*  packages/*
├── package.json               # name "brokk", pnpm@9.15, node>=22, ESM, Apache-2.0
├── tsconfig.base.json         # same compiler opts as heimdall-oss
├── .env.example  .gitignore  README.md  LICENSE  ARCHITECTURE.md
├── apps/
│   ├── api/                   # @brokk/api  — Hono + @hono/node-server + zod
│   │   └── src/{index,app,config}.ts  routes/{tasks,runs,runner,webhooks}.ts
│   └── web/                   # @brokk/web  — Next 15 (board)
├── packages/
│   ├── core/                  # @brokk/core   — domain types + interfaces (no deps)
│   ├── db/                    # @brokk/db     — Drizzle schema + store + drizzle.config
│   ├── runner/                # @brokk/runner — Agent SDK runner, worktrees, gh
│   └── sdk/                   # @brokk/sdk    — typed API client (web + external)
```

## 5. Domain model (`@brokk/core`)
- **Project** — a unit of work scoped to one repo + agent config (model, auth mode, allowed tools, base branch).
- **Repository** — `{ owner/name, defaultBranch, cloneUrl, installation }`.
- **Task** (the card) — `{ id, projectId, title, body, status, priority, labels[], baseBranch, createdBy, prUrl? }`.
- **Run** — one execution attempt of a task: `{ id, taskId, status, runnerId, worktree, branch, model, authMode, startedAt, endedAt, tokensIn/Out, headroomSaved, prUrl, error? }`.
- **RunEvent** — append-only stream: `{ runId, seq, type (status|message|tool_use|tool_result|log|usage), payload, at }`.
- **Agent/Runner** — `{ id, host, capabilities[], lastSeenAt, status }`.

### Card lifecycle (board columns)
`backlog → queued → running → review (PR open) → done(merged)` · side states: `failed`, `cancelled`.
Moving a card to **queued** enqueues a run. PR merge (webhook) → **done**.

### 5.1 Mímir — the counselor (prompt intake)  `@brokk/mimir`
The forge takes **qualified prompts**, not just tasks — and Mímir is the front door that
gets a card there. Migrated from Heimdall (PocketBase → Postgres; Heimdall's `/mimir`
retires). Two axes, decided by one cheap structured call (the **triador**, `gpt-4.1-mini`):
- **refino** (`none|polish|structure|engineer`) — the *specification gap*: how much the
  **enhancer** restructures the prompt. `engineer` = the full archetype. `none` = already clear.
- **forca** (`low|medium|high|extra`) — the *task* complexity/risk → a concrete model +
  reasoning effort downstream (via the CCL AI gateway).

The axes are **independent**: a clear prompt can describe a brutal task. Auto by default,
human **override** allowed; the budget ceiling is trusted to the router — **Eitri** reviews
after, and its verdict + the chosen levels feed the calibration loop.
Trio: **Mímir advises → Brokkr forges → Eitri reviews.**

**Eitri's security ward.** Before the LLM review, Eitri runs OSS vulnerability
scanners over the PR's worktree — **semgrep** (SAST) and **trivy** (dependency
CVEs + secrets) — and scopes the findings to the files the PR *changed*, so a
pre-existing CVE in an untouched dependency never blocks an unrelated change. A
HIGH/CRITICAL finding (threshold via `EITRI_SCAN_BLOCK_SEVERITY`) **deterministically
forces `REQUEST_CHANGES`**, independent of the LLM's judgment — which feeds the same
revise loop the reviewer uses, so Brokk patches the vulnerability on the next round.
The scan summary is injected into the reviewer prompt and recorded per head-sha in
`reviews` (`scan_blocking`, `scan_total`). Scanners are optional: a missing binary is
skipped gracefully, and `EITRI_SECURITY_SCAN=false` turns the ward off entirely.
Tables: `mimir_prompts` (the bank), `mimir_revisions` (immutable history),
`mimir_triage` (the two-axis decision, linked to a revision). History + triage are
INSERT/SELECT-only at the DB role level.

## 6. Database (Postgres / Drizzle)  `@brokk/db`
Tables: `projects`, `repositories`, `tasks`, `runs`, `run_events`, `agents`, `pull_requests`.
- UUID PKs, `created_at/updated_at`, FKs with cascade.
- `runs.status` + `tasks.status` are enums.
- `run_events` is append-only (`runId, seq`) → powers the live log (SSE).
- Env: `BROKK_DATABASE_URL`. `drizzle.config.ts` + `db:generate`/`db:push` (same as heimdall-oss).

## 7. API surface (`@brokk/api`, Hono)
**Human/board:**
- `GET/POST /projects` · `GET/PATCH /projects/:id`
- `GET/POST /tasks` · `PATCH /tasks/:id` (edit / move column) · `POST /tasks/:id/enqueue`
- `GET /runs/:id` · `GET /runs/:id/events` (**SSE** live log)

**Runner (machine):** (shared-secret auth header)
- `POST /runner/register` · `POST /runner/heartbeat`
- `POST /runner/claim` → returns next queued task + a fresh run, or 204
- `POST /runs/:id/events` (batch) · `POST /runs/:id/complete` `{ status, prUrl, usage }`

**GitHub:** `POST /webhooks/github` — PR merged → task `done`; review comment → optional follow-up run.

All bodies validated with `zod`. CORS for the web app. Errors as JSON problem objects.

## 8. Agent engine (the brain)
`@brokk/runner` wraps the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, headless).
Per run it:
1. Clones/updates the repo (cached bare clone) and creates a **worktree** off `baseBranch` → `brokk/<task-slug>-<run>`.
2. Assembles the prompt: task title/body + repo conventions (CLAUDE.md/AGENTS.md) + guardrails.
3. Runs the SDK with `permission-mode`, `allowedTools`, `cwd=worktree`, streaming events → `POST /runs/:id/events`.
4. On success: commit, push branch, `gh pr create` → store `prUrl`, move task → **review**.
5. Cleans up the worktree (kept on failure for debugging).

**Auth modes** (per project): `subscription` (**default/only for now**; `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` on the Max plan) or `api_key` (**deferred**; `ANTHROPIC_API_KEY` via the gateway — wired but not the supported path yet).

## 9. Headroom integration
The runner exports `ANTHROPIC_BASE_URL=http://<headroom>:8787` before invoking the SDK.
- `subscription` mode (current) → headroom's lossless `Subscription` policy stretches the Max rate-limit window.
- `api_key` mode (deferred) → headroom compresses + the **gateway** tracks spend (real $ saved).
Per-run we record `headroomSaved` (from the proxy's stats) on the `runs` row.

## 10. GitHub
`gh` CLI on the runner (token = fine-grained, least-priv: contents+PR write on target repos).
Branch-per-run; PR body links back to the Brokk card. Webhooks close the loop (merge → done, review comment → follow-up).

## 11. Security
- Secrets via env (Ice Vault canonical): `BROKK_DATABASE_URL`, GitHub token, Anthropic key/OAuth, runner shared secret, headroom URL.
- Runner isolation: worktrees today; optional per-run container later.
- Control-plane behind auth (CF Access / Heimdall SSO) — never expose the runner endpoints publicly without the shared secret.

## 12. Billing
- **Max subscription = the model (internal-only)**: Brokk runs on the CCL Max plan via `claude setup-token`. Acceptable because it's internal tooling on our own seat; it shares the interactive rate-limit window (mitigated by headroom's `Subscription` mode).
- **API key via the CCL AI gateway = deferred**: the path that gives clean ToS + central per-project spend + real $-saving compression. Revisit when Brokk goes multi-tenant/OSS or the Max window becomes the bottleneck.

## 13. Deployment
- Control plane: Coolify app (monorepo; `apps/api` + `apps/web`), Postgres (Coolify-managed or via Hauldr).
- Runner: on **surtr** (systemd service or container) with git/gh/claude/headroom.
- Naming: `brokk.coldcodelabs.com` (board) when we expose it (behind CF Access).

## 14. Relationship to the CCL ecosystem
- **Heimdall** can embed the board / trigger tasks (Ice Breaker → "scaffold + open first PRs via Brokk").
- **Asgard** (the IA conductor) can create/queue Brokk tasks from chat/WhatsApp.
- **Hauldr** can provide Brokk's Postgres (and dogfoods Brokk for its own dev).

## 15. Roadmap
- **P0 — scaffold + docs** (this): monorepo skeleton, schema, API/runner contracts, this doc. *No tests yet.*
- **P1 — runner spike**: 1 card → claude headless in a worktree → real PR on a test repo (+ headroom wired).
- **P2 — board UI** (Next): columns, card detail, live run log (SSE).
- **P3 — GitHub webhooks**: merge→done, review-comment→follow-up run.
- **P4 — multi-runner + gateway billing**; per-project budgets/spend.
- **P5 — OSS release**: harden, docs, Apache-2.0, go public alongside Heimdall/Hauldr.
