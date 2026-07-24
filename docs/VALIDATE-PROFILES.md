# Validate profiles (ADR 0074 Fase 4)

Each app/repo can ship a **validate profile** next to the code. The Forge runner
reads it from the worktree and uses it as the verify gate (typecheck / lint / test)
before opening or updating a PR.

## File

```text
.brokk/profile.json
```

## Shape

```json
{
  "name": "default",
  "commands": {
    "typecheck": "pnpm typecheck",
    "lint": "pnpm lint",
    "test": "pnpm test"
  }
}
```

Named commands run in order **typecheck → lint → test** (missing keys skipped),
joined with `&&`.

Or an explicit ordered list (wins over named keys):

```json
{
  "name": "custom",
  "commands": {
    "verify": ["pnpm install", "pnpm typecheck", "pnpm test -- --run"]
  }
}
```

## Resolution

| Priority | Source |
|---|---|
| 1 | `.brokk/profile.json` in the worktree |
| 2 | Worker env `BROKK_VERIFY_CMD` |
| 3 | No verify (skip) |

Acceptance (`.brokk/acceptance.mjs`) stays orthogonal — UI/behavior gate, not compile.

## Dogfood

This repo ships `.brokk/profile.json` as the reference.
