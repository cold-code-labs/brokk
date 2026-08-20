# Brokk — Architecture (current map)

> CCL's open-source AI **coding-agent** platform. The **code** pillar of the triad:
> **Hauldr** (data) · **Heimdall** (deploy) · **Brokk** (code).
> Named after the dwarf smith who forged the gods' tools (Mjölnir, Gungnir, Draupnir).
>
> The **doctrine and product vision** live in [docs/NORTH-STAR.md](docs/NORTH-STAR.md).
> This file is the short orientation map: what runs where, and the three
> load-bearing conventions. History note: an earlier version of this document
> described a design built on the Claude Agent SDK — that design was **retired
> codebase-wide in 2026-06** (NORTH-STAR §9); the kernel is native.

## Layout

**Packages = capabilities (libraries). Apps = processes (trigger-adapters).**
Dependency direction is one-way: `afl ← agents ← apps` (NORTH-STAR §10).

| Package | Role |
|---|---|
| `packages/afl` | **Afl** — agent kernel + CLI turn drivers (OpenCode · Claude · Cursor · OpenHands). |
| `packages/core` | Shared domain types (tasks, runs, previews, plans) + the runtime spec/allowlist. |
| `packages/db` | Drizzle models + the Store over Postgres. Schema changes ship via **boot-time self-heal DDL** (see below). |
| `packages/sdk` | Typed client for the control-plane API. |
| `packages/mcp` | **MCP bridge** (ADR 0027 §4.1): `BROKK_MCP_SERVERS` → connected servers → namespaced ToolDefs + a PartialExecutor mounted into Sindri turns. Fail-closed gating (read-only by default). |
| `packages/repomap` | **Ranked symbol map** (ADR 0027 §4.2): exported symbols per file + PageRank over the import graph (TS compiler as parser). Feeds the forge's warm index. |
| `packages/coder` | **A porta do runtime** — cliente do Coder + a receita da bancada. |
| `packages/agents/scout` | **Huginn/Muninn** — read-only discovery: repo brief, card resolution, meeting intake, runtime detection. |
| `packages/agents/reviewer` | **Eitri** — PR review on read-only hands, no gh creds. |

| App | Role |
|---|---|
| `apps/api` | Control plane (Hono): projects/tasks/runs/**bancadas**/ingress routes, SSE logs. Hospeda o driver de cards e o reaper de bancadas. |
| `apps/web` | Next.js workbench: board + bancada (agente + preview ao vivo). |
| `apps/reviewer` | Eitri daemon: polls PRs, semgrep+trivy scan, LLM review, verdict comment. |

> **O runtime saiu daqui (ADR 0100).** `apps/forge`, `apps/chat`,
> `apps/preview-proxy` e `apps/enclave-manager` foram removidos: quem mantém
> checkout, roda dev server, isola execução e expõe preview é o **Coder**, num
> workspace por projeto (a *bancada*). O template vive em `deploy/coder/bancada`
> e o cliente tipado em `packages/coder`.

## Convention 1 — one loop, hooks for effects

Every agent rides `runAgentLoop` (afl) or a CLI turn driver. Side effects — persisting messages,
emitting events, tracing — are **hooks**, never kernel code. Domain tools are
composed onto the generic hands via `composeExecutors`; mutation is gated
(read-only tool defs, `shellEnv()` env allowlist, gh creds opt-in).

### Missions (Regin)

**Regin** is the mission coordinator (ADR 0027 §5.4) — a *reconciler*, not an app.
**Planning via Mímir is terminated** (2026-07-24): use Brokk Chat **OpenCode Plan → Forge**.
Regin still watches in-flight missions (retry → escalate → synthesize); new goals that need
decomposition go through Chat. State lives in `missions` + `mission_events`; the tick loop
rides `apps/api` (`src/missions.ts`, every 30s).

Operational note: after a human resolves an escalation, `POST
/missions/:id/resume` unblocks the mission but does NOT re-dispatch — re-queue
the failed card yourself (Board "queue →" / `PATCH /tasks/:id`), then resume.

## Convention 2 — schema via self-heal DDL

The canonical migration path is **idempotent self-heal DDL at boot**
(`ensureSchema`/`ensureChatSchema`): `CREATE TABLE/ALTER ... IF NOT EXISTS` on
every start. `drizzle-kit push` is **not** part of deploy (it hangs on new
tables in db_brokk) — Drizzle is used for models/queries and type generation
only. Removing a column = drop it from the model **and** the self-heal, then
`ALTER TABLE ... DROP COLUMN` once.

## Convention 3 — sandbox tiers

All agent `bash` funnels through one chokepoint (`ExecEnclave.exec`):

- **Default (zero setup):** N1 env allowlist + N2 Landlock FS jail (best-effort
  — degrades gracefully where the kernel/binary is absent).
- **Fleet tier (opt-in):** N3 egress uid-split (nftables per-uid) and the
  **gVisor enclave** per project (`BROKK_ENCLAVE_BACKEND=runsc`), with
  credentialed git/gh commands split back to the worker (`SplitEnclave`).

## Deploy

Single compose app (`docker-compose.coolify.yml`) — push to `main` deploys via
the fleet webhook pipeline. Verification: `pnpm -r typecheck` + the golden-task
eval suite (`pnpm eval`, see [evals/README.md](evals/README.md)) — run the
`mock`+`build` lanes before touching the kernel or adding deps to bundled
`@brokk/*` packages — plus smoke scripts in `scripts/`.

One packaging gotcha worth knowing: the worker bundles use tsup `noExternal:
[/^@brokk\//]`, so a CJS dependency added to any bundled workspace package gets
inlined into an ESM bundle — the tsup banner shims `require`/`__filename`, and
`pnpm eval --lane build` catches a bundle that no longer boots.
