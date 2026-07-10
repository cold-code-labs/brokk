# ADR 0027 — Brokk core-engineering tuning: one kernel, fewer packages, market-gap capabilities

- **Status:** **Accepted** (2026-07-10)
- **Date:** 2026-07-10
- **Deciders:** Vitor
- **Resolutions (2026-07-10):** eval suite lands before the loop unification (E1 order stands); MCP stays in E2; the apikey seam is implemented Brokk-side in Afl config; the runtime→core fold happens now in E0. Implementation note: the four "empty legacy stub" dirs (1.1) turned out to be untracked local build litter, not repo content — removed locally, nothing to commit.
- **Scope note:** this ADR covers **core engineering only**. Everything required to *open the repo to outsiders* (private-package deps, auth modes for self-hosters, PAT onboarding, one-command compose storefront, README/docs polish, English-first UI surface) is intentionally **out of scope** and deferred to a future ADR. Nothing here blocks that work; several seams here enable it.

## Context

Brokk works — card→forge→verify→heal→PR, Sindri chat+preview, Eitri review, and the enclave stack are live and validated E2E. A July 2026 gap analysis against Devin, Codex cloud, Jules, Cursor agents, Factory, and the v0/Lovable class concluded:

1. **The no-framework bet is validated.** mini-SWE-agent (~100-line scaffold) scores >74% SWE-bench Verified; Cognition/Cursor/Factory hand-roll their loops. Devin's moat items (wiki indexing, knowledge lifecycle, computer-use QA, manager-of-agents) are what OSS frameworks cover *worst* — skipping LangChain/LangGraph/Agent SDK cost us none of them.
2. **The real gaps are not framework gaps.** They are: context compaction, an eval harness, a knowledge write-loop, a symbol-level repo map, and MCP interop. Each is small.
3. **The real redundancy is not Afl.** Afl (1.4k LOC, zero runtime deps) is the best-evidenced part of the codebase. The duplication sits *around* it: a second tool-loop, a package that outlived its extraction, empty stubs, and stale docs.

## Decision drivers

- **D-lean:** no agent frameworks in the loop, ever. Adopt OSS only below the loop (sandboxing, parsing, protocol SDKs) or beside it (scanners). Build in-house where the feature is <500 LOC.
- **D-one-kernel:** one loop, one execution substrate, N personas. Anything that duplicates the kernel is debt.
- **D-market-capability:** close the measured gaps vs Devin-class products (compaction, evals, memory loop, repo map, MCP) — the parts that are engineering, not go-to-market.
- **D-seams-not-rewrites:** where CCL infra (seat gateway, Hauldr, Heimdall) is load-bearing, cut a seam and keep CCL as the default consumer. No behavior change for our fleet.

## Decisions

### 1. CUT — delete, no replacement

| # | Cut | Why |
|---|-----|-----|
| 1.1 | `packages/{runner,eitri,chat}` (empty 0-LOC legacy stubs) + `apps/sindri` (empty) | Dead weight from the Afl extraction; confuses every new reader and inflates the package graph. |
| 1.2 | `ARCHITECTURE.md` as it stands | Still describes the retired Agent SDK design. Rewrite as a short current map that defers to NORTH-STAR (or fold into it). |
| 1.3 | Mímir's `claude -p` CLI path | Mímir becomes HTTP-only (gateway or any OpenAI-compatible endpoint). Kills the CLI binary from images and one whole auth mode. |
| 1.4 | Dead schema/config residue: `previews.ready_at/expires_at` writes, `previewEphemeral/previewPinned/previewTtlMs` config, `plannedPath` | Inventoried as orphans in ADR 0017 F5; finish the job. |
| 1.5 | Stale root docs (`HANDOFF-analysis-pillar.md` if superseded) | Hygiene. |

### 2. SIMPLIFY — one kernel, fewer packages, honest names

| # | Change | Detail |
|---|--------|--------|
| 2.1 | **One tool-loop.** | Verdict from study: Afl is not complex, redundant, or nonsense — keep it untouched as the kernel. What is redundant: **two loops** — `afl/loop.ts runAgentLoop` (generic, hook-based) and `agents/chat/loop.ts runTurn` (Sindri's db-coupled sibling, whose migration was deferred at extraction time). Unify: Sindri's persistence/streaming/SSE-replay become hooks on `runAgentLoop`; delete the sibling. One loop, four personas — the extraction finally finishes. |
| 2.2 | **Fold `packages/runtime` into `packages/core`.** | RuntimeSpec + allowlist + validation is 662 LOC of types and pure functions — core's job. Package count 10 → 6 (`afl, core, db, mimir, sdk, agents/*`). The allowlist test suite moves with it. |
| 2.3 | **Rename `apps/gateway` → `apps/preview-proxy`.** | Kills the recurring confusion with the AI gateway (LiteLLM/Ratatoskr). Compose service key follows (coordinated with deploy.sh, same de-risk pattern as the 2026-06-25 cosmetic rename). |
| 2.4 | **Declare self-heal DDL the canonical migration path.** | The self-heal vs `drizzle-kit push` split is tribal knowledge (push hangs on db_brokk). Document self-heal as THE path; drizzle-kit demoted to type generation only. |
| 2.5 | **Sandbox posture by tier, documented.** | Default: N1 env-allowlist + N2 Landlock (best-effort, zero setup). N3 egress uid-split and the gVisor enclave = documented opt-in tiers for fleet/multi-tenant contexts. Stack survives intact; it stops being mandatory reading to understand `bash`. |

### 3. SEAMS — decouple CCL infra behind interfaces (CCL stays the default consumer)

| # | Seam | Detail |
|---|------|--------|
| 3.1 | **Credential seam: implement `mode=apikey` in Afl config.** | Afl accepts `ANTHROPIC_API_KEY` (direct to api.anthropic.com) *or* `BASE_URL+token` (today's seat via LiteLLM/Ratatoskr). This is the dormant NORTH-STAR #6 item, implemented in Brokk itself rather than only in the relay. **CCL default unchanged (seat mode)** — flipping defaults is a go-to-market decision, not this ADR's. Gateway.ts already speaks raw Messages; only header injection differs. |
| 3.2 | **`DataProvider` interface for preview backends.** | Preview supervisor consumes an interface: `ensureEnv(project) → env vars`. Default implementation = passthrough (project-supplied env). Hauldr provisioning becomes the first real provider (today's behavior, still the CCL default). Forge's `apply_migration` tool mounts only when the provider supports migrations — doctrine unchanged. |
| 3.3 | **Heimdall bridge behind env.** | ✔ Already satisfied in the codebase: the bridge mounts only when `HEIMDALL_AGENT_URL`+`HEIMDALL_AGENT_TOKEN` are set (apps/chat/src/app.ts); absent env = infra tools report unavailable. No work needed. |

### 4. ADOPT — OSS where it's commodity (and keep rejecting where it isn't)

| # | Adopt | Why |
|---|-------|-----|
| 4.1 | **MCP client in the tool loop** (`@modelcontextprotocol/sdk`, official, light). | The interop standard every Devin-class product speaks. User/operator-configured MCP servers surface as tools in Afl's loop — allowlisted, read-only by default, mutation opt-in (same `shellEnv` spirit). Instantly extensible Sindri without hand-writing domain tools. |
| 4.2 | **tree-sitter repo map** (port Aider's technique: symbol extraction + PageRank-style ranking; grammars as deps, algorithm ours). | Replaces the `git ls-files` repomap. Feeds Huginn briefs and the forge prompt. The cheapest credible answer to Devin Wiki/Search. |
| 4.3 | **Nixpacks as runtime-detection fallback** (Sleipnir v3 as already planned). | **DEFERRED at E2 (2026-07-10):** the closed command-allowlist is the runtime layer's security model, and trusting `nixpacks plan` output means widening it — a real design decision with zero current value (the fleet is 100% preset-covered, and Huginn detection backstops). Revisit when a non-preset stack actually lands. |
| 4.4 | **Keep the existing OSS spine.** | hono/zod/drizzle/langfuse/streamdown/semgrep/trivy/go-landlock/gVisor — the buy-vs-build line is already right. |
| 4.5 | **Keep rejecting:** agent frameworks (the loop is ours), E2B (needs KVM we don't have), Daytona/stagewise (AGPL vs Apache-2.0), Sourcegraph (no longer OSS). | Documented so it stops being re-litigated. |

### 5. BUILD-SMALL — the measured capability gaps, each <500 LOC

| # | Build | Why |
|---|-------|-----|
| 5.1 | **Context compaction + token budgets in `runAgentLoop`.** | The one true framework-parity gap: Afl has no compaction — only 60KB tool-output clips and `maxRounds`; a long Sindri session or deep heal loop silently degrades at the window. On threshold: summarize older rounds into one message, keep recent rounds verbatim. Plus a per-run token budget enforced in the loop (usage sums already exist; add the ceiling) — required the day `mode=apikey` carries real billing. |
| 5.2 | **Golden-task eval suite.** | Fixture repos + ~10–15 fixed cards with assertions, runnable on demand and gating deploy. Today every prompt/model/força change is vibes. Also the safety net that 2.1's loop unification lands behind. |
| 5.3 | **RepoMemory auto-write loop.** | Distill lessons from heal failures and Eitri verdicts into `repoMemories` automatically. Devin's "knowledge suggestions," nearly free — the substrate (table + prompt injection + pgvector recall) already exists; only the writer is missing. |
| 5.4 | **Regin — mission coordinator** (implemented 2026-07-10). | MultiDevin-lite over the existing plan/DAG + lease infra: `missions`/`mission_events` (self-heal DDL) + a reconciler in apps/api (plan via Mímir → dispatch → retry ≤2 / replan ≤1 / escalate → synthesize), Sindri `start_mission`/`list_missions` tools, and a second claim-only runner (`forge-b`, `BROKK_SUPERVISOR=0`) for fan-out. |

## Non-goals

- **Opening the repo** (yggdrasil vendoring/publishing, auth modes, PAT onboarding, compose front door, storefront docs, English-first UI labels) — deferred to a dedicated ADR; the seams in §3 are its prerequisites.
- Multi-provider LLM matrix. Anthropic-first; anything OpenAI-shaped goes through an operator's own gateway via 3.1's `BASE_URL` mode.
- Enterprise controls, IDE/desktop surface, rewriting the enclave stack or preview supervisor.

## Rollout (three engineering phases, each shippable alone)

- **E0 — cuts & folds (pure hygiene, zero behavior change):** 1.1–1.5, 2.2 runtime→core, 2.3 preview-proxy rename, 2.4/2.5 docs. Bisectable small deploys, same pattern as the 2026-06-25 structure landing.
- **E1 — safety net, then the kernel:** 5.2 eval suite first; then 2.1 loop unification and 5.1 compaction+budgets land behind it.
- **E2 — seams & capabilities:** 3.1 apikey seam, 3.2 DataProvider, 3.3 Heimdall-optional; 4.1 MCP client, 4.2 repo map, 4.3 Nixpacks fallback, 5.3 memory loop.

**Execution log:** E0 shipped 2026-07-10 (`71c5ce6`, `0548fce`, `938e818`). E1 shipped 2026-07-10 (`815a18c` evals, `341fdc5` one loop, `9fdc462` compaction+budgets) — suite 17/17, unified loop proven E2E in prod (gVisor bash turn). E2 shipped 2026-07-10 (`32a99b3` apikey seam, `b4cc06c` DataProvider, `6d7310e` memory loop, `73e2833` repomap, `0b5786e` MCP); 3.3 was already satisfied; 4.3 deferred (see table). ADR 0027 is **fully executed** except the deferred 4.3; §5.4 (Regin) landed 2026-07-10 (`fa91346` + fix `c68c229`) and was **validated E2E in prod** the same day: mission on svalinn → plan → forge-b claim → infra failure (orphan worktree) → retry ×2 cross-runner → the replan decision correctly diagnosed infra-not-code and escalated with the exact cure → human fix + resume → card landed on dev (`90d3655`) → synthesis → done. Two review lessons recorded: `@brokk/core` must stay a single index.ts (a VALUE submodule breaks Next's webpack — `runtime.js` survived only because its exports are type-only), and resume-after-fix requires manually re-queueing the failed card.

## Consequences

- CCL's deploy keeps working throughout: every seam defaults CCL-ward (seat mode, Hauldr provider, Heimdall bridge ON in our Coolify env). We are the first consumer of every interface we cut.
- NORTH-STAR amendments: §9 gains "(8) adopt OSS below the loop, never for the loop"; §10's package table shrinks by four; the dormant #6 credential seam is marked done by 3.1.
- Risk concentration: 2.1 (loop unification) touches Sindri's hot path — hence E1's ordering (evals first). Everything else is either deletion, an interface extraction with a default that preserves today's behavior, or an additive capability.

## Open questions — RESOLVED 2026-07-10

1. **E1 ordering:** eval suite (5.2) lands before the loop unification (2.1). ✔
2. **MCP priority:** stays in E2. ✔
3. **apikey seam placement:** Brokk-side, in Afl config (Brokk self-contained; the relay keeps working unchanged as the `BASE_URL` mode). ✔
4. **runtime→core fold (2.2):** now, in E0. ✔
