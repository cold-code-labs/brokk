# Brokk — North Star

> The single document every small decision should trace back to.
> If a change doesn't serve something written here, question it.

---

## TL;DR

We are open-sourcing the **first global vibe-code-factory**: a self-hostable platform
where anyone plugs in **their own AI subscription seat** and gets not just code, but
**real, deployed software** — built conversationally against a live preview. The only
cost is your own resources. No API-key burn. No reliance on multiple subscriptions.

> **Afl is the hands. Mímir is the cortex. The Session is the atom. The chat is the only
> door. Asgard is the factory. The user's own seat is the fuel.**

---

## 1. The product

A **vibe-code-factory** in the lineage of v0 / Lovable / Bolt — but:

- **Open source** and **self-hostable** end to end.
- **Bring Your Own Seat (BYOS):** each user authenticates their own Claude subscription;
  the platform runs on *their* seat, not ours.
- **It deploys.** Not a toy that emits a zip — it ships running apps with real data and
  real domains.
- **Cost = your resources only.** No per-seat reselling, no API-key middleman.

The competitive edge is **economic**: BYOS + lean agents means we waste none of the
user's own seat. The cheapest factory to run wins, and leanness is how we win it (see §9).

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

The flow:

> **Mímir** advises/plans → **Huginn** scouts → **Brokkr** forges → **Eitri** reviews →
> (**Sindri** is the human-driven side that ties it together) — all riding **Ratatoskr**
> to the seat.

Each agent package is the same tiny shape: a **persona** (system prompt) + its **extra
tools** (injected into Afl's protocol) + its **model/effort policy** + its **glue**. That
uniformity is the payoff of one kernel.

---

## 8. Ratatoskr — the fuel line (the keystone)

Ratatoskr holds the seat credential and injects it (plus the "You are Claude Code" marker
that unlocks Sonnet/Opus) into every request, so agents reach a subscription seat through
LiteLLM.

**Today:** one shared CCL seat.
**The product requires multi-seat.** "Bring your own seat" means Ratatoskr must become a
**per-user seat registry / pool**, routing each user's requests through *their* OAuth
token. This is not a "future P7" — it is the **keystone of the entire product.** Without
it there is no BYOS; with it, the cost truly is "your resources only."

---

## 9. The Lean Agent doctrine

Leanness is not hygiene — under BYOS it is the **moat** (§1). Every token saved is the
user's own seat preserved. Seven principles:

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
  afl/                  @brokk/afl       the hands (loop · gateway · fs+bash tools · context)
  mimir/                @brokk/mimir     the cortex (enhance · triage · plan)
  agents/
    forge/              @brokk/forge     Brokkr
    chat/               @brokk/chat      Sindri (slimmed)
    scout/              @brokk/scout     Huginn
    reviewer/           @brokk/reviewer  Eitri
  core/ db/ secrets/ sdk/

apps/
  api/        control plane: session · forge · preview · routes   (the Asgard seam)
  web/        UI (chat + live preview)
  forge/      queue worker      → hosts @brokk/forge       [was brokk-runner]
  chat/       HTTP + detached   → hosts @brokk/chat + @brokk/scout  [was apps/sindri]
  reviewer/   gh poll/webhook   → hosts @brokk/reviewer    [was brokk-eitri]
  gateway/    *.preview reverse proxy → routes preview subdomains to live ports
```

`apps/gateway` is the **preview-lane router** — the live-preview half of the Session (§3/§4).
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

## 12. Invariants that flow from BYOS + OSS

Design even the small bits so these never need a retrofit:

1. **Multi-seat from the start.** Anything touching the seat assumes *per-user*, not shared.
2. **Session-centric.** worktree + preview + seat + chat are one tenant-scoped object.
3. **Clean pillar APIs.** Brokk/Heimdall/Hauldr each independently runnable, composable by
   Asgard, self-hostable.
4. **Lean by default.** Every agent on Afl, native, minimal prompt, model sized by `força`.
5. **One door.** New capability goes *into the chat*, not onto a new page.

---

## 13. Status

- **Built today:** Brokkr (forge, on Agent SDK), Sindri (chat, native), Huginn (scout,
  native, inside Sindri), Eitri (reviewer, Agent SDK daemon), Mímir (enhance/triage/plan
  lib), Ratatoskr (single shared seat + shape-gate fixed), preview lane, multi-repo Fleet.
- **Decided, not yet built:** the `@brokk/afl` extraction, `@brokk/forge` (de-SDK), the
  agents/ regrouping, Planejador retirement.
- **Keystone ahead:** Ratatoskr multi-seat (BYOS).

> This is the destination. We build small bits — but every bit points here.
