# Validate profiles (ADR 0074 Fase 4)

Each app/repo can ship **validate profiles** next to the code. The Forge runner
reads them from the worktree and uses the selected profile as the verify gate
(typecheck / lint / test) before opening or updating a PR.

## Files

### Default profile

```text
.brokk/profile.json
```

### Named profiles

You can define multiple profiles using either:

1. **Directory-based profiles**: Create individual files in `.brokk/profiles/`
   ```text
   .brokk/profiles/ci.json
   .brokk/profiles/fast.json
   .brokk/profiles/lint-only.json
   ```

2. **Profile map in profile.json**: Add a `profiles` map to your default profile.json
   ```json
   {
     "name": "default",
     "profiles": {
       "ci": { "commands": { "typecheck": "tsc -b", "test": "jest" } },
       "fast": { "commands": { "verify": ["echo fast"] } },
       "lint-only": { "commands": { "lint": "eslint ." } }
     }
   }
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

## Profile Selection

Profiles can be selected per card/task using labels:

```text
profile:ci
profile:fast
```

The resolution order for which profile to use is:

| Priority | Source | Description |
|---|---|---|
| 1 | Card label `profile:<name>` | Highest priority - card-specific override |
| 2 | `BROKK_VERIFY_PROFILE` env var | Project-wide default via environment |
| 3 | `.brokk/profile.json` default | Default profile from profile.json (name: "default") |
| 4 | `BROKK_VERIFY_CMD` env var | Legacy fallback command |
| 5 | No verify (skip) | When no profile or command is found |

**Important**: If a card label selects a profile that doesn't exist, Forge fails
loudly with an error instead of silently skipping verification.

## Resolution Details

1. **Card label selection**: Extracts `profile:<name>` from card labels
2. **Profile loading**: Loads all available profiles from:
   - `.brokk/profiles/` directory (higher precedence)
   - `profiles` map in `.brokk/profile.json`
   - Default profile from `.brokk/profile.json`
3. **Command generation**: Uses `profileVerifyCmd()` to generate the final command

## Dogfood

This repo ships `.brokk/profile.json` as the reference.
