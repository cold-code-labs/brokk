# 🔨 Brokk

**CCL's open-source AI coding-agent platform — the forge.**

Brokk is the **code** pillar of the CCL triad:

| | Pillar | Does |
|---|---|---|
| **Hauldr** | data | multi-tenant BaaS / Postgres |
| **Heimdall** | deploy | control plane over Coolify |
| **Brokk** | **code** | **card → agent forges code → Pull Request** |

> Private first; **Apache-2.0** once hardened.

## How it works
A card (issue) goes on the board → a **runner** picks it up → spins an isolated git
worktree → runs the **Claude Agent SDK** (headless) to forge the change → commits,
pushes, and opens a **PR**. Many runners pull from one queue, in parallel.

Brokk is the **shell** (board, queue, runner orchestration, GitHub/PR) — the **brain
is the Claude Agent SDK**. It composes with **headroom** (context compression) by
routing the agent through a proxy (`ANTHROPIC_BASE_URL`).

## Stack
pnpm monorepo · **Hono** API · **Next 15** web · **Drizzle + Postgres**. (Same mold as Heimdall OSS.)

```
apps/api      @brokk/api      Hono control plane (tasks, queue, runs, webhooks)
apps/web      @brokk/web      Next 15 kanban board
packages/core @brokk/core     domain types + ports (AgentEngine, GitProvider)
packages/db   @brokk/db       Drizzle schema + Postgres store
packages/runner @brokk/runner Claude Agent SDK runner (worktrees, gh) — runs on a worker host
packages/sdk  @brokk/sdk      typed API client
```

## Quickstart (dev)
```bash
pnpm install
cp .env.example .env          # set BROKK_DATABASE_URL, BROKK_RUNNER_SECRET, GITHUB_TOKEN, ...
pnpm --filter @brokk/db db:push   # create schema
pnpm dev                      # api + web
# in a worker host (with git, gh, claude, headroom):
pnpm --filter @brokk/runner start
```

## Auth & billing
The agent authenticates as either:
- **`api_key`** (default) — `ANTHROPIC_API_KEY`, routed through the CCL AI gateway → headroom saves real $ + central spend.
- **`subscription`** — `claude setup-token` (Claude Max). ⚠️ Server-side automation on a consumer subscription is ToS-gray and shares your interactive rate-limit window. Use for light/personal only.

## Deploy (Coolify)
Production stack: `docker-compose.prod.yml` (Postgres + API + Web), same pattern as
Heimdall OSS / Saga. On Coolify create a **Docker Compose** resource pointing at
`cold-code-labs/brokk`, branch `main`, compose file `docker-compose.prod.yml`.
Route the `web` service at `brokk.coldcodelabs.com` via `docker_compose_domains`.

Coolify resource: project `Brokk`, application uuid `p3yhl41ww6sw00wqnezpppnu` (surtr).
Install the deploy hook: `cp scripts/coolify-pre-push .git/hooks/pre-push && chmod +x .git/hooks/pre-push`

Once deployed, Brokk appears in **Heimdall OSS → Fleet** (Coolify `/services` mirror).

```bash
# local smoke (needs external coolify network or drop that block):
docker compose -f docker-compose.prod.yml up --build
```

## Status
**P0 — scaffold.** Structure, schema, and API/runner contracts are in place; the runner
is an unverified skeleton. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design and the
phased roadmap (P1 = first real card→PR spike).
