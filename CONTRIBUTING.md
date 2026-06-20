# Contributing to Brokk

## Setup

Requires **Node ≥ 22** and **pnpm 9**.

```bash
pnpm install
cp .env.example .env   # fill in required vars (see README quickstart)
pnpm --filter @brokk/db db:push   # apply schema to your local Postgres
```

## Development

```bash
pnpm dev          # api + web in parallel
pnpm dev:api      # API only
pnpm dev:web      # web only
```

## Type-checking

```bash
pnpm -r typecheck   # runs typecheck in every package
```

Typecheck must pass before opening a PR.

## Linting

```bash
pnpm -r lint
```

## Branch & PR convention

| What | Convention |
|---|---|
| Branch name | `<scope>/<short-description>` — e.g. `runner/retry-logic` |
| Commit message | `brokk(<scope>): <imperative summary>` — e.g. `brokk(runner): retry on transient clone errors` |
| PR title | Same format as the commit message |
| PR size | Keep PRs focused; one logical change per PR |

Open PRs against `main`. CI must be green before merging.
