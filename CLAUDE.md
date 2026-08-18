# brokk

Forja de agentes de código autônomos. Monorepo pnpm com vários apps (`apps/api`,
`apps/web`, `apps/forge`, `apps/chat`, `apps/reviewer`, `apps/enclave-manager`,
`apps/preview-proxy`).

## Rodar

```bash
pnpm install && pnpm dev
pnpm typecheck && pnpm build
```

## Deploy — um repo, dois apps, por caminho

Ambos em `main`, **path-scoped**:

| app | observa |
|---|---|
| `brokk-core` | `apps/web/**`, `apps/api/**`, `packages/**`, lockfiles, `docker-compose.core.yml` |
| `brokk-forge` | `apps/forge/**`, `apps/chat/**`, `apps/reviewer/**`, `apps/enclave-manager/**`, `apps/preview-proxy/**`, `tools/**` |

Quem serve `brokk.coldcodelabs.com` é o **`brokk-core`**. Um terceiro app (`brokk`), com
build mal configurado e 25 falhas seguidas sem servir nada, foi **removido** em 18/08/2026.

Push que não toca os caminhos acima não deploya — comportamento esperado.

## CI: o gate mora aqui, não no GitHub

Este repo **não usa GitHub Actions**. O que valida o código é `.ccl/gate.yml`, rodado pela
ferramenta de frota `ccl` (repo `midgard`, em `fleet/mimir/`):

```bash
ccl ci brokk        # roda o gate deste repo
ccl ci-db brokk     # migrações numa base descartável (job que precisa de Postgres)
```

Um hook de `pre-push` roda o gate antes de qualquer push que mexa em `main`/`master`/`dev`
e **bloqueia se falhar**. Instalar num clone novo: `ccl gate-install brokk`. Emergência:
`git push --no-verify`.

Por quê: o Actions não deployava (quem deploya é o Gjallarhorn/Coolify), não bloqueava
merge (nenhum repo tem branch protection) e parou de validar quando a conta foi bloqueada
por cobrança. Migrado em 18/08/2026 — ADR 0098 e `operacoes/gate-ccl` na Edda.

**Mexeu no que o gate valida? Edite `.ccl/gate.yml`.** É a fonte da verdade; não há
workflow para manter em sincronia.
