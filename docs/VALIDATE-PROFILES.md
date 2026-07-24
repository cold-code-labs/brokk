# Validate profiles (ADR 0074 Fase 4)

Each app/repo can ship a **validate profile** next to the code. The Forge runner
reads it from the worktree and uses it as the **verify** gate (typecheck / lint / test)
and optionally the **E2E** gate (UI / behaviour) before opening or updating a PR.

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
    "test": "pnpm test",
    "e2e": "pnpm exec playwright test"
  }
}
```

Named verify commands run in order **typecheck → lint → test** (missing keys skipped),
joined with `&&`.

Or an explicit ordered list (wins over named keys):

```json
{
  "name": "custom",
  "commands": {
    "verify": ["pnpm install", "pnpm typecheck", "pnpm test -- --run"],
    "e2e": "pnpm exec playwright test e2e/smoke.spec.ts"
  }
}
```

## Verify resolution

| Priority | Source |
|---|---|
| 1 | `.brokk/profile.json` in the worktree |
| 2 | Worker env `BROKK_VERIFY_CMD` |
| 3 | No verify (skip) — **loud warn** on the forge |

Set `BROKK_REQUIRE_VERIFY=1` on the worker to **fail the run** when source is
`none` (no silent skip). Recommended for frota once every app ships a profile.

## E2E gate (UI / behaviour)

Orthogonal to compile verify. Brokk boots the card worktree on an ephemeral port,
then runs the resolved command with:

| Env | Value |
|---|---|
| `PLAYWRIGHT_BASE_URL` / `BASE_URL` | `http://127.0.0.1:<port>` |
| `BROKK_CHROMIUM` / `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | headless Chromium on the worker |

### Resolution

| Priority | Source |
|---|---|
| 1 | `commands.e2e` in `.brokk/profile.json` |
| 2 | `playwright.config.{ts,js,mjs,…}` → `pnpm exec playwright test` |
| 3 | Legacy `.brokk/acceptance.mjs` (still supported) |
| 4 | No E2E (skip) |

If an E2E gate is present and `BROKK_BROWSER` is off, the run **fail-closes**
(red receipt) instead of skipping.

Prefer Playwright specs under `e2e/` — market shape. Prefer not inventing a
new browser runner for a one-line fix when the repo has no E2E yet.

## Dogfood

This repo ships `.brokk/profile.json` as the reference (verify only today).
