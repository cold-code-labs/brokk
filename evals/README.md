# Golden-task evals (ADR 0027 §5.2)

Fixed tasks + programmatic assertions over the agent kernel. **Run these before
touching `packages/afl` (the loop, gateway, tools) or Sindri's turn path** —
they are the regression net the ADR 0027 kernel changes land behind.

```
pnpm eval                      # all available lanes
pnpm eval --lane mock          # deterministic, free, runs anywhere
pnpm eval --lane chat          # Sindri runTurn persistence vs throwaway Postgres
pnpm eval --lane llm           # semantic tasks vs the real gateway (haiku)
pnpm eval --lane llm --model sonnet
pnpm eval --only loop-tool-roundtrip
```

Lanes:

- **mock** — loop mechanics against a scripted SSE gateway (`mock-gateway.ts`
  speaks exactly the dialect `afl/gateway.ts` parses): transcript shape, hook
  ordering (the persistence contract), multi-tool rounds, `max_rounds`, abort,
  usage accounting, streaming deltas, the fs-executor contract, and the N1
  env-allowlist (a process secret must NOT reach the agent's shell).
- **chat** — a real `runTurn` against a throwaway Postgres + the mock gateway:
  pins the `chat_messages` rows (count/roles/seq/blocks/meta.usage), the emit
  stream, and title derivation. Needs docker, or point `EVAL_PG_URL` at any
  scratch Postgres.
- **build** — builds the chat+forge bundles and boots them with a bare env:
  pass = dies at config validation, fail = dies at module load (the CJS-inlined-
  into-ESM class that typecheck and unit tests cannot see). Run it whenever a
  bundled `@brokk/*` package gains a dependency.
- **llm** — golden semantic tasks against the real gateway (needs
  `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`). Haiku by default: the weakest
  model is the strictest gate. One retry per task (model flakiness ≠
  regression); mock/chat lanes never retry — a failure there is a real bug.

Failures exit 1. Skipped lanes are reported loudly, never silently.
