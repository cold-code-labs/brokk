# Remediação Svalinn — brokk

**Target:** `brokk`  
**Branch:** `fix/svalinn-brokk-debt`  
**Base:** `origin/main` @ `99c3ab2`  
**Playbook:** Brokk skill `/svalinn-remediate` (House)

## Placard

| | início | após esteira |
|---|---:|---:|
| Open (pedido) | 17 code_bug | 0 open no cluster pedido |
| High | 9 | 0 |
| Medium | 8 | 0 |

## Smoke — PASS

| Id | Finding | Ref |
|---|---|---|
| `7ac958cd` | Forge `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_ANON_KEY` = raw `jwtSecret` | `eec1b14` — mint anon + long-lived service_role JWT; `NEXT_PUBLIC_SUPABASE_URL` → publicUrl |

## Clusters fechados (fix)

| Cluster | Ids | Commit |
|---|---|---|
| Forge JWT mint | `7ac958cd` | `eec1b14` |
| API auth GET + x-brokk hop + CORS + onError | `ef283197` · `82392f6a` · `092df07e` · `c465f30f` | `1a66b69` |
| Scout bash → enclave | `909b366a` · `352671e5` · `38f2d98d` | `c3f236a` |
| SplitEnclave git creds boundary | `7077a658` | `e2ed721` |
| canSeeProject + setCurrentId + discover rate-limit | `f860b064` · `d58feb21` · `7568c1d6` · `0a6da22e` · `3a5f2f2a` · `ad50a313` | `7bf413d` |
| setup-token env + crew/seats role gate | `31a89ffe` · `aa387166` | `7bf413d` · `4b80f02` |

## Causas-raiz

1. **Preview env** — publishable keys nunca são o signing secret; service role é JWT mintado.
2. **Control-plane** — bearer em todos os métodos (probes `/health` `/ping` `/version` públicos); headers `x-brokk-*` só em hop autenticado; CORS allowlist; 500 genérico.
3. **Scout** — `makeFsExecutor` + `resolveEnclave` (mesmo chokepoint do reviewer/forge).
4. **N4 SplitEnclave** — `needsCreds` rejeita `-c`/`--exec-path`/`--git-dir`/submodule; worker injeta `core.hooksPath=/dev/null` + `credential.helper=` + `GIT_CONFIG_*=/dev/null`.
5. **Tenancy** — missions/Sindri QA+discover com `canSeeProject`; cooldown 60s em scout POSTs; `setCurrentId` só após `listProjects`.
6. **Crew** — `/users` staff-only; connect/token amarra ao ator (staff pode targetar); setup-token env allowlist.

## wontfix / deferred

Nenhum no pedido desta esteira. (Rate-limit é in-memory por processo — suficiente contra abuso autenticado cross-tenant; persistir depois se o chat escalar horizontalmente.)

## Validação

```bash
pnpm --filter @brokk/afl test
pnpm exec tsx --test apps/api/src/actor.test.ts
```

Probes públicos preservados: `GET /health` `/ping` `/version`.
