# Brokk — North Star

> The single document every small decision should trace back to.
> If a change doesn't serve something written here, question it.

---

## TL;DR

We are open-sourcing the **first global vibe-code-factory**: a self-hostable platform
that turns a conversation into **real, deployed software** — built against a live preview.
Each instance runs on **one upstream credential** the operator plugs in — a Claude
subscription seat today (`mode=seat`), an API key later (`mode=apikey`) — and that single
credential commands the whole fleet.

> **Afl is the hands. Mímir is the cortex. The Session is the atom. The chat is the only
> door. Asgard is the factory. The seat is the fuel.**

---

## 1. The product

A **vibe-code-factory** in the lineage of v0 / Lovable / Bolt — but:

- **Open source** and **self-hostable** end to end.
- **One credential per instance:** the operator plugs in a single upstream credential — a
  Claude subscription seat today (`mode=seat`), an API key later (`mode=apikey`) — and it
  commands the whole fleet. No per-user seat multiplexing.
- **It deploys.** Not a toy that emits a zip — it ships running apps with real data and
  real domains.
- **Cost = one credential's resources.** A single seat (or, later, key) fuels the instance.

The competitive edge is **economic**: lean agents waste none of that one credential's
headroom. The cheapest factory to run wins, and leanness is how we win it (see §9).

---

## 2. The factory: Asgard over the triad

**Brokk is not the product.** Brokk is the *build engine* inside the product. The product
is **Asgard** — the control plane of our self-hosted mini-cloud — orchestrating three
pillars that each mirror a known incumbent:

```
                ┌──────────────  ASGARD  ──────────────┐
                │   the vibe-code-factory control plane   │
                │   one chat, reaching across:            │
                └────┬───────────────┬───────────────┬───┘
                     │               │               │
                 ┌───▼───┐       ┌───▼────┐      ┌───▼────┐
                 │ BROKK │       │HEIMDALL│      │ HAULDR │
                 │ build │       │ deploy │      │  data  │
                 │ (v0)  │       │(Vercel)│      │(Supa.) │
                 └───────┘       └────────┘      └────────┘
```

| Pillar   | Role   | Incumbent it replaces |
|----------|--------|-----------------------|
| Brokk    | build  | v0 / Lovable / Bolt   |
| Heimdall | deploy | Vercel                |
| Hauldr   | data   | Supabase              |

The chat says "build it" → Brokk; "ship it" → Heimdall; "give it a database" → Hauldr.
**Consequence for us:** Brokk must expose its capability through a clean API surface
("session + forge + preview"), so Asgard can compose it with the other two pillars. We
design Brokk's `apps/api` as that seam — not as Brokk-internal CRUD.

---

## 3. The atom: the Session

v0/Lovable/Bolt are not chat apps — they are **session apps**. The unit of the product is:

```
SESSION = { chat  +  worktree  +  live preview  +  seat }
              │         │            │             │
           Sindri    Afl/forge    preview lane    the user's
           (talk)    (build)      (see it live)   OWN seat
```

Everything must be addressable as **one tenant-scoped Session object** from day one —
because that is what Asgard hands a user, what the preview lane renders, and what runtime
isolation (bubblewrap → microVM, see ARCHITECTURE/isolation) wraps. Build session-centric
even when building small.

---

## 4. The only surface: chat beside live preview

There is **exactly one user-facing destination**: the **chat on the left, the running app
on the right.** Everything else is invisible — a capability the chat invokes, or a process
that runs in the background.

```
┌───────────────────────────┬───────────────────────────┐
│                           │                            │
│         CHAT              │       LIVE PREVIEW          │
│   (talk, iterate)        │   (the running app, now)    │
│                           │                            │
│   "make the header blue" →│   ← updates in place        │
│                           │                            │
└───────────────────────────┴───────────────────────────┘
```

**Design rule:** no feature earns its own page in the consumer product unless it cannot
live inside the chat/preview loop. Planner, triage, scout, review — none are destinations.
The prompt-bank and other operator tools stay **internal-only**.

---

## 5. The two substrates

Below the surface, the foundation is two peers — one for *acting*, one for *deciding*:

```
┌─────────────────────────────────────────────────────────────┐
│  AFL   — the hands    tool-loop runtime: HOW agents act        │  execution
│  MÍMIR — the cortex   enhance / triage / plan: HOW intent      │  cognition
│                        becomes right-sized work                 │
└─────────────────────────────────────────────────────────────┘
                ▲ both consumed by every agent
        forge · chat · scout · reviewer
```

- **Afl** = execution substrate. The tool-loop, the gateway client, the shared "hands"
  (generic fs + bash tools), context injection. Knows nothing about cards, PRs, chat
  sessions, or GitHub. Stays dependency-light forever. (Package `@brokk/afl`.)
- **Mímir** = cognition substrate. Turns fuzzy human intent into structured, right-sized
  work. A **library, never a process.** (Package `@brokk/mimir`.)

An agent uses **both**: Mímir to decide *what*, Afl to actually *do it*.

---

## 6. Mímir is one cortex with three lobes

Mímir is not a set of overlapping tools and it is **not** two things ("Mímir" + "Planejador").
It is one brain, three lobes, in a pipeline:

```
fuzzy human intent
      │
   ┌──▼──────────┐  enhance   sharpen the prompt      (polish | structure | engineer)
   │   MÍMIR     │  triage    size it: refino + força  (→ which model, how hard)
   │ the cortex  │  plan      decompose: 1 card | DAG  (→ executable units)
   └──┬──────────┘
      │ structured, right-sized work
      ▼
   execution (Afl / forge)
```

- **enhance** — refine a vague prompt (3 modes).
- **triage** — two independent axes: **refino** (how much to restructure) and **força**
  (complexity/risk → model + effort downstream).
- **plan** — decompose into executable units: one card (atomic) or a 2–8 card DAG (feature).

**"Planejador" is just the `plan` lobe that was given its own webpage.** It is a redundant
*surface*, not a redundant capability. In the product it disappears: the **chat** decides
when to plan and shows the proposed steps inline (Sindri's `plan_work` already calls the
same planner). The standalone `/plan` page is retired; the `/mimir` prompt-bank stays an
internal operator tool.

**força is the per-seat cost governor.** Because every user runs on their *own* seat,
triage (low→haiku, medium/high→sonnet, extra→opus) is what keeps a user's subscription
from burning out. This is where the lean doctrine (§9) meets the product economics (§1).

---

## 7. The agent anatomy

Four personas, one execution substrate (Afl), one cognition substrate (Mímir). Package
names describe the **role**; the Norse name is the **persona** (product/UI identity).

| Package (role)     | Persona | Job                                    | Trigger |
|--------------------|---------|----------------------------------------|---------|
| `@brokk/forge`     | Brokkr  | worktree → build → verify → PR         | queue   |
| `@brokk/chat`      | Sindri  | conversational build, sessions, stream | HTTP    |
| `@brokk/scout`     | Huginn  | read-only repo → structured brief      | HTTP    |
| `@brokk/reviewer`  | Eitri   | review a diff → verdict + repo-memory  | gh poll |
| *(apps/api tick)*  | Regin   | mission foreman: plan → dispatch → react → synthesize (ADR 0027 §5.4) | 30s reconciler |

Regin is deliberately NOT a tool-loop agent: the mission control flow is a
deterministic reconciler, and the LLM appears only at one-shot decision points
(plan, replan-or-escalate, synthesis) — §9 #5 applied to orchestration.

The flow:

> **Mímir** advises/plans → **Huginn** scouts → **Brokkr** forges → **Eitri** reviews →
> (**Sindri** is the human-driven side that ties it together) — all riding **Ratatoskr**
> to the seat.

Each agent package is the same tiny shape: a **persona** (system prompt) + its **extra
tools** (injected into Afl's protocol) + its **model/effort policy** + its **glue**. That
uniformity is the payoff of one kernel.

---

## 8. Ratatoskr — the fuel line (the keystone)

Ratatoskr holds the upstream credential and injects it into every request (today: the
OAuth seat token + the "You are Claude Code" marker that unlocks Sonnet/Opus), so agents
reach the model through LiteLLM.

**Today, and through the entire factory-validation phase:** one shared CCL seat
(`mode=seat`) commands the whole fleet. This is deliberate and stays.

**The keystone is a credential-mode seam — not a per-user seat pool.** Ratatoskr must
isolate credential injection behind a single switch:
- `mode=seat` (today, default) — `Authorization: Bearer <oauth>` + the Claude Code system
  marker + the `oauth` beta flag.
- `mode=apikey` (future, once the factory is validated) — `x-api-key: <key>`, no marker,
  no oauth beta. Usage-based billing, already measured by LiteLLM + Lago.

One credential commands the instance; there is **no** hosted multiplexing of many users'
individual OAuth seats.

---

## 9. The Lean Agent doctrine

Leanness is not hygiene — it is the **moat** (§1). The whole fleet rides one shared
credential, so every token saved is concurrency headroom preserved on that one seat. Seven
principles:

1. **Native kernel, never the SDK.** Own the tool loop (Afl). The Agent SDK's gift
   (auto-sends the Claude Code system) is its tax (you can't trim what you can't see).
2. **The system prompt is a per-agent-per-turn budget line.** In a fleet you pay it
   × agents × turns. Keep it role-specific and tiny; cache the stable prefix.
3. **Right-size model to leverage, not to task.** Default haiku; spend Sonnet only where
   the decision compounds (plan, review); Opus rarely. (This is Mímir's `força`.)
4. **Just-in-time context, pull don't push.** Feed brief / repo-map / grep hits — never a
   checkout dump. The agent requests more via read-only bash if needed.
5. **One-shot structured > multi-turn wander.** Force the terminal tool (`submit_brief`,
   `submit_review`) so agents converge instead of exploring forever.
6. **Minimal tool surface, read-only by default.** Fewer tool defs = fewer tokens + tighter
   behavior. Mutation behind an explicit grant (the `shellEnv()` allowlist instinct).
7. **Concurrency is the only real cost.** Subscription tokens are ~free; the seat's limit is
   parallel pressure. Lean agents are small → fan out wider per seat.
8. **Adopt OSS below the loop, never for the loop.** Sandboxing (Landlock/gVisor), parsing
   (tree-sitter), scanners (semgrep/trivy), protocol SDKs (MCP) — buy. The tool loop,
   streaming, retry, and prompts — own. (ADR 0027.)

**Origin:** a reachability test (5 linear + 5 parallel Sonnet agents through Ratatoskr) where
every subagent spent an identical ~33.3k tokens — fixed *context* overhead of the spawn, not
the work. The SDK carries that same fat preamble by construction. Native + lean removes it.

---

## 10. Package structure & the dependency law

**The rule that keeps it ordered forever:**

> **Packages = capabilities (libraries). Apps = processes (trigger-adapters). Never mix.**

**Dependency direction (one way, no cycles):**

```
afl + mimir   ◄──   agents   ◄──   apps
(substrates)        (personas)     (processes)
```

- `afl` depends on **nothing agent-specific** (no git/gh/db/cards). Non-negotiable.
- `mimir` is a pure library (no process).
- agents depend on `afl` + `core` (+ their own infra: forge→git/gh, reviewer→gh).
- apps depend on the agent packages they host.

**Target tree:**

```
packages/
  afl/                  @brokk/afl       the hands (loop · gateway · fs+bash tools · enclave · compaction)
  mimir/                @brokk/mimir     the cortex (enhance · triage · plan)
  mcp/                  @brokk/mcp       MCP servers → loop tools (ADR 0027 §4.1)
  repomap/              @brokk/repomap   ranked symbol map (ADR 0027 §4.2)
  agents/
    forge/              @brokk/forge     Brokkr
    chat/               @brokk/chat      Sindri (hooks on the ONE loop)
    scout/              @brokk/scout     Huginn
    reviewer/           @brokk/reviewer  Eitri
  core/ db/ sdk/        (runtime folded into core — ADR 0027 §2.2)

apps/
  api/            control plane: session · forge · preview · routes   (the Asgard seam)
  web/            UI (chat + live preview)
  forge/          queue worker      → hosts @brokk/forge
  chat/           HTTP + detached   → hosts @brokk/chat + @brokk/scout
  reviewer/       gh poll/webhook   → hosts @brokk/reviewer
  preview-proxy/  *.preview reverse proxy → routes preview subdomains to live ports
  enclave-manager/ docker.sock broker for the gVisor enclaves
```

`apps/preview-proxy` is the **preview-lane router** — the live-preview half of the Session (§3/§4).
It is unrelated to Ratatoskr (the AI fuel line, §8); the two only share the word "gateway".

**Only generic, dependency-free tools live in Afl** (fs + bash). Domain tools
(`create_card`, `plan_work`, `submit_brief`, `submit_review`) are **injected by each agent**
through Afl's tool protocol — so the kernel never pulls in db/mimir.

`chat` + `scout` are **two packages, one process** (they share the checkout manager and both
fire on demand). Separate library, shared daemon — the Huginn-inside-Sindri pattern, made
deliberate.

---

## 11. Migration map (current → target)

| Today                       | Becomes                                                        |
|-----------------------------|---------------------------------------------------------------|
| `packages/chat`             | split → `packages/afl` (kernel) + `packages/agents/chat` (slim Sindri) |
| `packages/chat/discovery.ts`| `packages/agents/scout`                                        |
| `packages/runner`           | engine → `packages/agents/forge`; claim-loop → `apps/forge`    |
| `packages/eitri`            | agent → `packages/agents/reviewer`; daemon → `apps/reviewer`   |
| Agent SDK (`query()`)       | **deleted**                                                    |
| `/plan` page (Planejador)   | **deleted** — planning becomes a chat behavior via Mímir       |
| `/mimir` prompt-bank        | kept, **internal/operator-only**                               |

---

## 12. Invariants that flow from single-seat + OSS

Design even the small bits so these never need a retrofit:

1. **One credential per instance, swappable source.** Anything touching the upstream
   credential assumes a single instance-wide seat, with the source flippable to an API key
   later (`mode=seat|apikey`) — never a per-user seat pool.
2. **Session-centric.** worktree + preview + seat + chat are one tenant-scoped object.
3. **Clean pillar APIs.** Brokk/Heimdall/Hauldr each independently runnable, composable by
   Asgard, self-hostable.
4. **Lean by default.** Every agent on Afl, native, minimal prompt, model sized by `força`.
5. **One door.** New capability goes *into the chat*, not onto a new page.

---

## 13. Status (updated 2026-06-25)

- **Shipped:** `@brokk/afl` kernel extraction — **LIVE in prod** (`main`). The heart =
  gateway + types + config + the shared hands (`FS_TOOL_DEFS`/`makeFsExecutor`/`shellEnv`/
  `composeExecutors`), dependency-pure. `@brokk/scout` (Huginn) extracted; `@brokk/chat`
  (Sindri) slimmed, domain tools compose on afl. Verified in prod: scout briefs + a real
  Sindri `runTurn` driving `list_dir` through the new composition; zero-downtime deploy.
  - **NOTE:** `loop.ts` (Sindri `runTurn`) + `context.ts` stayed in `@brokk/chat` on
    purpose (Sindri-specific, legally db-coupled). The **generic agent-loop primitive is
    deferred to the `@brokk/forge` build** — that's its first second-consumer.
- **The Agent SDK is RETIRED (codebase-wide).** Both Brokkr (`@brokk/forge`) and Eitri
  (`@brokk/reviewer`) run native on the afl loop; `runAgentLoop` is the shared primitive.
  Other live pillars: Mímir (enhance/triage/plan lib), Ratatoskr (single shared seat +
  shape-gate fixed), preview lane, multi-repo Fleet.
- **Structure landed (#3 + #5):** agent libs grouped under `packages/agents/{forge,chat,
  scout,reviewer}`; the daemons live in `apps/{forge,reviewer,chat}` (the eitri brain split
  into `@brokk/reviewer` + the `apps/reviewer` daemon). Persona-neutral kernel names
  (`AflConfig`, `AgentEvent`). **Cosmetic rename done (`5cb4a4c`):** app packages are
  `@brokk/{forge,reviewer,chat}-app`, compose service keys `forge/reviewer/chat`, images
  `brokk-{forge,reviewer,chat}:local` — labels now match the `apps/` dirs.
- **#4 done (`674c62a`):** Planejador retired — the `/plan` page + `Planner.tsx` + the
  `/mimir/plan*` routes + SDK plan methods deleted; Sindri's `plan_work` builds a real Plan
  (cards linked by `planId/planKey`) in the chat, the forge composes one shared-branch PR.

### The numbered roadmap — #1–#5 landed, #6 is the last (and deferred)

#1 (`@brokk/forge`, kill the SDK in the forge), #2 (Eitri off-SDK), #3 + #5 (regroup +
persona-neutral names), and #4 (retire the Planejador) are all **landed and proven in
prod.** One item remains, and it is intentionally on hold:

- **#6 — Ratatoskr credential-mode seam:** isolate credential injection behind
  `mode=seat|apikey`. A single CCL seat commands the fleet today (`mode=seat`); the
  `apikey` path stays written but **dormant until the factory is validated** (Vitor's call,
  2026-06-25). ~30 lines, no change to today's hot path. *Not a per-user seat pool.*

**Loose ends (non-blocking):** ~~`deploy-dev.sh` must export `NODE_AUTH_TOKEN` before
`pnpm install`~~ **FIXED 2026-06-25** (surtr `/home/brokk/deploy-dev.sh` now sources
`brokk-dev.env` — which carries the token — before install; token verified against the
yggdrasil registry). ~~Huginn smoke is flaky on big repos (haiku submits sparse)~~ **FIXED 2026-06-25**:
root cause was haiku **leaking the tool-call XML into `summary`** under a forced
`toolChoice` (so `built/missing/stack` never landed as JSON → empty). Fix in
`packages/agents/scout/src/discovery.ts` = auto-tool-choice enrich retry (×2) when a
brief comes back empty + 4k maxTokens headroom; smoke 3/3 green on the brokk monorepo.
Working rhythm: isolated
git worktree → push to `dev` (preview) → smoke → cutover to `main` (pre-push hook
auto-deploys prod via `/home/brokk/deploy.sh` on surtr).

> This is the destination. We build small bits — but every bit points here.
