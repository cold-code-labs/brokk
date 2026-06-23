# Contributing to Brokk

Thanks for your interest in Brokk. It's the code pillar of the Cold Code Labs triad
(**Hauldr** · **Heimdall** · **Brokk**).

> **Status: private, hardening toward an Apache-2.0 public release.** While Brokk is
> internal, the most useful contributions are issues and design discussion. Before a large
> change, open an issue first.

## The shape of the codebase

Brokk is the **shell** around a coding agent — board, queue, runner orchestration, GitHub/PR.
The **brain is the Claude Agent SDK** (headless); we don't build an agent. The forge is a
trio: **Mímir** qualifies the prompt and fans it into a DAG of cards, **Brokkr** (the runner)
forges each in an isolated git worktree, **Eitri** reviews every PR (semgrep + trivy + LLM).

```
pnpm install
cp .env.example .env
pnpm --filter @brokk/db db:push
pnpm dev                     # api + web
pnpm --filter @brokk/runner start   # on a worker host with git, gh, claude
pnpm typecheck
```

## Branches

- `main` — production. Deployed to `brokk.coldcodelabs.com` (Logto auth). **Open PRs against
  `main`.**
- `dev` — Cold Code Labs' permanent dev lane, served on-demand at
  `*.preview.coldcodelabs.com` against an isolated database. It's where in-progress work is
  previewed, not where you contribute.

## Pull request guidelines

- Keep PRs focused — one logical change per PR.
- Match the style and structure of the surrounding code.
- Update the relevant docs (README / ARCHITECTURE) in the same PR when behavior changes.
- Write a clear description: what changed, why, and how you verified it.
- Link the issue the PR addresses.

## A note on the agent

Brokk can forge its own changes. PRs opened by the runner are reviewed by Eitri and then by a
human before merge — automation does not bypass review.

## Code of conduct

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE).
