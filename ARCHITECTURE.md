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
Dependency direction is one-way: `afl + mimir ← agents ← apps` (NORTH-STAR §10).

| Package | Role |
|---|---|
| `packages/afl` | **Afl** — the agent kernel: native Messages-API streaming tool loop (`runAgentLoop`), gateway client with retry/backoff, the generic hands (`read_file/write_file/edit_file/list_dir/bash`), and the execution enclave (`ExecEnclave`: env allowlist → Landlock jail → egress uid-split → optional gVisor). Zero runtime dependencies. |
| `packages/core` | Shared domain types (tasks, runs, previews, plans) + the runtime spec/allowlist. |
| `packages/db` | Drizzle models + the Store over Postgres. Schema changes ship via **boot-time self-heal DDL** (see below). |
| `packages/mimir` | **Mímir** — the cortex: enhance → triage (`força`) → plan. Pure library, HTTP-only client (Messages API via the gateway, or an OpenAI-compatible endpoint). |
| `packages/sdk` | Typed client for the control-plane API. |
| `packages/mcp` | **MCP bridge** (ADR 0027 §4.1): `BROKK_MCP_SERVERS` → connected servers → namespaced ToolDefs + a PartialExecutor mounted into Sindri turns. Fail-closed gating (read-only by default). |
| `packages/repomap` | **Ranked symbol map** (ADR 0027 §4.2): exported symbols per file + PageRank over the import graph (TS compiler as parser). Feeds the forge's warm index. |
| `packages/agents/forge` | **Brokkr** — autonomous card→worktree→verify→heal→PR engine. |
| `packages/agents/chat` | **Sindri** — conversational coding over a live checkout, domain tools (cards, planning, infra intents). |
| `packages/agents/scout` | **Huginn/Muninn** — read-only discovery: repo brief, card resolution, meeting intake, runtime detection. |
| `packages/agents/reviewer` | **Eitri** — PR review on read-only hands, no gh creds. |

| App | Role |
|---|---|
| `apps/api` | Control plane (Hono): projects/tasks/runs/previews/chat/mimir routes, SSE logs. |
| `apps/web` | Next.js workbench: kanban board + chat + live preview. |
| `apps/chat` | Sindri daemon (detached turns, checkout manager) — also hosts the scout. |
| `apps/forge` | Runner: claims cards, runs the forge engine, supervises live previews. |
| `apps/reviewer` | Eitri daemon: polls PRs, semgrep+trivy scan, LLM review, verdict comment. |
| `apps/gateway` | `*.preview` reverse proxy (subdomain → live preview port). Not the AI gateway. |
| `apps/enclave-manager` | Broker that owns the Docker socket for gVisor enclaves. |

## Convention 1 — one loop, hooks for effects

Every agent rides `runAgentLoop` (afl). Side effects — persisting messages,
emitting events, tracing — are **hooks**, never kernel code. Domain tools are
composed onto the generic hands via `composeExecutors`; mutation is gated
(read-only tool defs, `shellEnv()` env allowlist, gh creds opt-in).

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
