# brokk

Control plane de agentes de código. Monorepo pnpm com três apps: `apps/api`
(control plane), `apps/web` (workbench) e `apps/reviewer` (Eitri, revisão de PR).

**O runtime não mora aqui.** Desde a ADR 0100 quem roda código é o **Coder**: uma
*bancada* por projeto (checkout + dev server com HMR + agente + Playwright) num
workspace provisionado na surtr. O Brokk decide, coordena e mostra.

- quente: `coder.coldcodelabs.com/@brokk/<ws>.main/apps/bancada/` — onde se trabalha
- frio: `<app>.preview.coldcodelabs.com` (branch `preview`) e `<app>.coldcodelabs.com`
  (branch `main`) — build no push, com o BaaS montado junto

O template da bancada é versionado em `deploy/coder/bancada`. Empurrar uma versão:

```bash
coder templates push bancada -d deploy/coder/bancada --yes
```

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
| `brokk-forge` | `apps/reviewer/**`, `tools/**` (só o Eitri sobrou aqui) |

Quem serve `brokk.coldcodelabs.com` é o **`brokk-core`**. Um terceiro app (`brokk`), com
build mal configurado e 25 falhas seguidas sem servir nada, foi removido em 18/08/2026 —
e **voltou sozinho 4h depois**, recriado por um push de documentação, porque o
provisionamento do Gjallarhorn ignorava o `lifecycle` do registro. Corrigido no mesmo dia
(`ensure-engine-for-push` passou a exigir `lifecycle=active`), e o registro do `brokk` foi
marcado como `terminated`.

⚠️ Este repo tem **três** registros no Heimdall (`brokk-core`, `brokk-forge` e o `brokk`
desativado). Se um app do Coolify reaparecer aqui sem ninguém ter criado, é o registro
`brokk` tendo voltado a `active` — não crie um app novo, verifique o lifecycle.

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
