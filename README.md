<p align="center">
  <img src="apps/web/public/brokk.svg" alt="Brokk" height="160" />
</p>

<h1 align="center">Brokk</h1>

<p align="center"><strong>CCL's open-source AI coding-agent platform — the forge.</strong></p>

Brokk is the **code** pillar of the CCL triad:

| | Pillar | Does |
|---|---|---|
| **Hauldr** | data | multi-tenant BaaS / Postgres |
| **Heimdall** | deploy | control plane over Coolify |
| **Brokk** | **code** | **card → agent forges code → Pull Request** |

> **Open-source — Apache-2.0.**

## How it works

A card (issue) goes on the board → a **runner** claims it → spins an isolated git
worktree → runs an **agent loop** to forge the change → commits, pushes, and opens a
**PR**. Many runners pull from one queue, in parallel. Every PR gets reviewed by a
second agent before it can merge.

The loop is ours. Brokk runs on **`@brokk/afl`**, a ~1.4k-LOC native kernel with zero
runtime dependencies — no agent framework, by [deliberate
decision](docs/adr/0027-simplify-for-oss-adoption.md). Three engine lanes plug into it
via `BROKK_FORGE_ENGINE`:

| Lane | What drives the turn |
|---|---|
| `cursor-cli` *(default)* | Cursor Agent CLI — needs the `cursor-agent` binary + `CURSOR_API_KEY` |
| `cli` | the genuine Claude Code CLI |
| `afl` | the native in-process loop, straight to the Messages API |

The forge is a trio: **Mímir advises** (qualifies the prompt, fans it into a DAG of
cards) → **Brokkr forges** (one worktree per card) → **Eitri reviews** (semgrep + trivy
+ LLM, on every PR). **Sindri** is the conversational face — chat that builds, with a
live preview it can drive itself through a Playwright MCP.

## Stack

pnpm monorepo · **Hono** API · **Next 15** web · **Drizzle + Postgres** · Node ≥22.
(Same mold as Heimdall OSS.)

```
# apps = processes (trigger-adapters)
apps/api              @brokk/api               Hono control plane — projects, tasks, runs,
                                               previews, chat, mimir routes, SSE logs
apps/web              @brokk/web               Next 15 workbench — kanban + chat + live preview
apps/forge            @brokk/forge-app         the runner — claim loop, worktrees, gh,
                                               preview supervisor
apps/reviewer         @brokk/reviewer-app      Eitri daemon — polls PRs, scans, reviews, verdict
apps/chat             @brokk/chat-app          Sindri daemon — detached turns, checkout manager
apps/preview-proxy    @brokk/preview-proxy     *.preview reverse proxy (subdomain → live port).
                                               NOT the AI gateway — that's LiteLLM/Ratatoskr
apps/enclave-manager  @brokk/enclave-manager-app  the one privileged process that holds the
                                               Docker socket, so workers never do

# packages = capabilities (libraries)
packages/afl              @brokk/afl       the kernel — native agent loop + shared hands
packages/mimir            @brokk/mimir     the counselor — triage + enhancer + planner (card → DAG)
packages/mcp              @brokk/mcp       MCP bridge — operator-configured servers surface as
                                           tools, namespaced and read-only by default
packages/repomap          @brokk/repomap   ranked repo map (tree-sitter symbols + PageRank)
packages/agents/forge     @brokk/forge     Brokkr — worktree → build → verify → PR
packages/agents/chat      @brokk/chat      Sindri — conversational build persona
packages/agents/scout     @brokk/scout     Huginn — read-only repo → structured brief
packages/agents/reviewer  @brokk/reviewer  Eitri — diff → verdict + markdown review
packages/core             @brokk/core      domain types + ports (AgentEngine, GitProvider) — no deps
packages/db               @brokk/db        Drizzle schema + Postgres store
packages/sdk              @brokk/sdk       typed API client
```

## Quickstart (dev)

```bash
pnpm install
cp .env.example .env               # BROKK_DATABASE_URL, BROKK_RUNNER_SECRET, GITHUB_TOKEN, …
pnpm --filter @brokk/db db:push    # create schema
pnpm dev                           # every app in apps/, in parallel
```

Run a worker on a host that has `git`, `gh`, and your chosen engine's CLI:

```bash
pnpm --filter @brokk/forge-app start
```

## Auth & billing

The agent reaches a model one of two ways, set in Afl's config:

- **`apikey`** — `ANTHROPIC_API_KEY` straight to the API, or any OpenAI-compatible
  gateway via `ANTHROPIC_BASE_URL`. **The path for self-hosting.** Prompt caching works
  here, which matters a lot for long agent runs.
- **`subscription`** — a lent Claude seat (`claude setup-token` →
  `CLAUDE_CODE_OAUTH_TOKEN`). CCL's internal mode.
  ⚠️ Server-side automation on a consumer subscription is ToS-gray, shares that seat's
  interactive rate-limit window, and **does not read prompt cache** — cache writes are
  billed, cache reads never land. Many-turn agents get expensive fast on this path.

The `cursor-cli` lane authenticates separately, with `CURSOR_API_KEY`.

## Isolation

Workers forge each change in an isolated git **worktree** — for most repos that is the
whole isolation story, and it's how CCL runs it.

When the agent needs to *build and run* a target repo, that work goes to an **enclave**:
`apps/enclave-manager` is the only component holding the Docker socket, and it brokers
containers on the workers' behalf (optionally on the **gVisor** `runsc` runtime). The
workers stay unprivileged. Mounting the host socket into a worker directly is still
possible for single-tenant self-host — see the commented block in `docker-compose.yml` —
but it is root-equivalent on the host, so multi-tenant wants the enclave path.

## Deploy (self-host)

The whole platform is containers — `docker compose up` and you have the board; add
`--profile forge` and you have the workers.

```bash
cp .env.example .env               # POSTGRES_PASSWORD, BROKK_RUNNER_SECRET, ANTHROPIC_API_KEY, …
docker compose up -d                     # board: Postgres + API + Next web, behind Traefik (:80)
docker compose --profile forge up -d     # + forge, reviewer, chat, preview-proxy
```

Only `web` is public, fronted by **Traefik**; the browser reaches the API through
same-origin Next rewrites. Override the entrypoint port with `BROKK_HTTP_PORT` and the
host match with `BROKK_TRAEFIK_RULE='Host(\`brokk.example.com\`)'`.

Every service declares a **healthcheck**, and `api` gates `web` (`depends_on:
service_healthy`), so a compose deploy only routes traffic once the stack is actually up.
Rolling behaviour is left to the orchestrator — the blue/green replica dance that used to
live here was collapsed to a single replica for portability.

> CCL runs this on Coolify (a Docker Compose resource → `web` routed at
> `brokk.coldcodelabs.com`); any orchestrator with healthcheck-aware rolling works the same.

## Running agents unattended

Brokk agents are daemons: they poll, claim, and run without a human in the loop. That
shape has a failure mode worth knowing before you deploy it — an agent can be **healthy
and useless at the same time**, burning tokens on a task it can never complete, with
every metric green.

We hit it: a reviewer loop retried a permanently-failing GitHub call every 30 seconds for
29 hours, made 13,821 successful API calls, and published nothing. Write-up:
[**13,821 successful API calls. Zero output.**](https://coldcodelabs.com/blog/13821-successful-api-calls)

If you run this unattended, set a per-key budget with a **rolling window** at your
gateway, and alert on *agents that produce no artifact*, not just on errors. Note also
that framework step limits (`maxTurns`, `recursion_limit`) bound turns **inside** one
invocation — they do not bound how often a daemon re-invokes the agent.

## Status

**Operational (internal).** The full loop runs end-to-end: a card → the planner fans it
into a DAG of cards → a runner forges each in an isolated worktree → opens a PR; **Eitri**
reviews every PR (semgrep + trivy + LLM) and a webhook closes the plan on merge. Brokk
runs in production on **surtr** — container-first, blue/green `web` behind Traefik — and
powers an on-demand **dev preview lane** (`*.preview.coldcodelabs.com`) that Sindri can
drive and QA itself.

**Apache-2.0.**
See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design map, [docs/NORTH-STAR.md](docs/NORTH-STAR.md)
for the doctrine, and [docs/adr/](docs/adr/) for the decisions.
