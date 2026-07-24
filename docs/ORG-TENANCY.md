# Brokk — tenancy por organization Logto (serviço de builder da Asgard)

**Status:** T0–T2 live (`BROKK_ORG_TENANCY=1` em prod) · T3/T4 abertos  
**ADRs:** [0065](https://edda.coldcodelabs.com/decisoes/0065-asgard-cloud-porta-do-cliente/) (porta = Asgard) · [0064](https://edda.coldcodelabs.com/decisoes/0064-brokk-org-scoped-builder-b2b/) (tenancy)  
**Urðr:** `BROKK-47`  
**Relaciona:** ADR 0045, ADR 0041 (Lofn ≠ porta da cloud), ADR 0061, Asgard `docs/b2b/`, Midgard `docs/asgard-b2b-onboarding.md`

## Progresso (código)

| Fase | Estado |
|---|---|
| T0 session org + fail-closed layout | feito |
| T1 `logto_org_id` schema + ensureSchema | feito |
| T2 filtro projects/repos/tasks + connect | feito |
| T2 preview-gate por org | feito (`GET /previews/by-subdomain/:sub` + gate) |
| T2 studio / previews / Publicar | feito (runner bypass; humano escopado) |
| T2b forge GET projects/repos | feito (`requestActor` eleva `BROKK_RUNNER_SECRET` a staff — evita 404 em legado null) |
| Flag | `BROKK_ORG_TENANCY=1` liga filtro; sem flag, layout bloqueia só-cliente |
| Smoke Maglink | feito (client vs staff vs no-org) |

**Ainda aberto:** UI “Novo projeto” self-serve (T3); convite IT no Brokk (T4) — convite de *empresa* nasce na Asgard (ADR 0065 A0). Fuel/billing por org: [ADR 0077](https://edda.coldcodelabs.com/decisoes/0077-asgard-pricing-metering/) + [ORG-FUEL-SIM.md](./ORG-FUEL-SIM.md) (piloto seat→Omni).

## Por que

O Brokk isola **chat por dono**; sem tenancy, board/`repositories`/`projects` são globais. Qualquer user Logto veria a fábrica CCL.

**Porta do cliente = Asgard** (conta, org, uso, atalho Brokk). **Brokk = serviço de builder** dentro da cloud — só libera com filtro por org.

## Regra dura

Sem T0–T2 + flag em produção: **nenhum convite de cliente no Brokk**. Com tenancy live: entrada pelo deep-link da Asgard, não URL solta como primeiro contato.

## Backlog ordenado

### T0 — Identidade org no session Brokk

- Pedir scopes Logto `organizations` + `organization_roles` (mesmo padrão Kelvin/Lofn).
- Expor no actor da API/web: `orgIds[]`, `orgRoles[]`, flag `isCclStaff` (membro da org `Cold Code Labs` / `d5qacs8kwh79` **ou** role global ADMIN atual).
- Gate: usuário **só** membro de org-cliente (sem staff) **não** entra enquanto T1/T2 incompletos — fail closed (403 + copy).

### T1 — Schema: `org_id` no perímetro

Em `packages/db` (`schema.ts`):

- `repositories.logto_org_id text null` — null = legado CCL-only (visível só staff).
- `projects.logto_org_id text null` — denormalizado do repo na criação (filtro barato no board).
- Índice `(logto_org_id)` em ambos.
- Migração forward-only; backfill: repos CCL internos → null (ou org CCL explícita — preferir null = “só staff”).

### T2 — Filtro board + API

- Listagens `projects` / `tasks` / board:  
  - staff → tudo (ou toggle “só org X”);  
  - membro org-cliente → `WHERE logto_org_id IN (:actorOrgIds)`.
- Mutations: recusar criar/attach repo sem `logto_org_id` da org do ator (cliente) ou staff escolhendo org.
- Studio / Agent API / previews: herdam o escopo do `projectId` já filtrado — não abrir bypass por UUID adivinhado (404 se fora da org).

### T3 — Novo projeto self-serve (org-scoped)

- UI “Novo projeto” para membro `admin` da org.
- Chama Heimdall Agent API escopada (já sem `HAULDR_TOKEN` deus) + grava `logto_org_id`.
- Domínio/`slug` derivados do tenant; sem acesso Coolify cru.

### T4 — Convite do IT

- Só depois de T0–T2 live + smoke E2E com user de org de teste.
- Role Brokk ≠ ADMIN Logto global; org-role `admin`/`representante` mapeados para capabilities de builder.

### T5 — (opcional) Lofn bridge

- Se a relação for agência (pedir/aprovar): Lofn dispara card Brokk já com `logto_org_id` (ADR 0041 L3). Fora do caminho crítico do builder self-serve.

## Fora de escopo neste backlog

- Instância Brokk dedicada por cliente (custo/ops; só se isolamento N4+exigência contratual).
- SSO IdP do cliente (Azure AD) — Logto enterprise connector depois.
- Hauldr admin liberado ao cliente.

## Aceite (definição de pronto para liberar login)

1. User org-cliente A não lista projects/tasks da org B nem da CCL (null).
2. Staff CCL vê frota; `ccl_ops` na org A pode operar A.
3. Tentativa de abrir `projectId`/`preview` de outra org → 404/403.
4. Doc Asgard B2B atualizado: “Brokk liberado para `<slug>`”.

## Notas de implementação

- Não reinventar membership: Logto é a fonte; Brokk só lê claims.
- Seat Claude / billing por org: ver ADR 0077 + `ORG-FUEL-SIM.md`. F2 Omni (seat Mateus) destravou o fuel path; binding por `logto_org_id` no spawn = P3.
