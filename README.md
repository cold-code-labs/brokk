# Brokk

Organization-scoped development workspace for Cold Code Labs: scope, tasks, screens, design system, client reviews, review calls and supervised Devin development. Operators direct product work without database, shell or infrastructure access.

React 19 + Vite 8 SPA, Hono API and Postgres. One HTTP service serves the SPA and API. [Reconstruction plan](docs/v2/PLANO.md). [Design system contract and NFCS validation](docs/v2/DESIGN-SYSTEM.md).

## Local development

Install Node ≥22.18 and pnpm 9.15.9. Create a Postgres database, load the server-only environment from `.env.example` in your shell, then run:

```sh
pnpm install --frozen-lockfile
pnpm dev:api
# In another terminal, with the same local environment:
pnpm dev
```

Migrations create `brokk_v2` without modifying legacy tables. Local sign-in requires `BROKK_DEV_AUTH=1` and is always disabled in production. The administrator email allowlist is server-only. A newly signed-in person receives no organization access until assigned.

## Verification

```sh
pnpm typecheck
pnpm lint
BROKK_TEST_DATABASE_URL=postgresql://user:password@localhost/brokk_test pnpm test
pnpm build
```

Tests require an isolated database with `_test` in its name and truncate only that database's Brokk v2 schema. Browser verification covers actual project, scope, screen, task and review forms, plus responsive layouts.

## Production

Use the root Dockerfile, port 8080, `/api/health`, real OIDC credentials, HTTPS `BROKK_ORIGIN`, a restricted database connection and `BROKK_ADMIN_EMAILS`. Configure the OIDC redirect at `${BROKK_ORIGIN}/api/auth/callback`. No production development fallback exists. The CI gate is Woodpecker; deployment follows the official Coolify route after a green PR is merged. No GitHub Actions are used.

Devin and Daily credentials stay exclusively on the server. Missing provider credentials produce an explicit unavailable state. Review notes and product planning work independently of providers. Every Devin launch has a durable reservation and bounded ACU limit; ambiguous creation cannot automatically relaunch. Scope approval is required before delegation. Technical administration must restrict repositories and provider-side credentials; product operators cannot configure infrastructure through Brokk.

The Var catalog integration uses `/api/integrations/var/handoff` with a server-only bearer key. It accepts authorized organization/project context and returns a short-lived single-use workspace ticket. It does not accept repository settings or administrator grants.

Legacy code is preserved by Git history and the local `archive/mimir-recovered-20261013` recovery reference. Preview preparation and checked publication are described in [the preview guide](docs/v2/PREVIEW.md). Coder and production promotion remain separate.

## A4 Live Coach

Reuniões do Meet são preparadas em https://app.a4.ia.br/live-coach. A extensão global A4 Live Coach substitui Brokk Review e entrega reuniões finalizadas a Calls do projeto escolhido. A gravação privada e os highlights ficam na empresa da A4. A importação usa o backchannel da suite, valida empresa/projeto e conserva propostas pendentes de confirmação; repetir a entrega reutiliza a mesma call. A extensão da Contorna é independente.
