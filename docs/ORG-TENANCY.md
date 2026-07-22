# Brokk — tenancy por organization Logto (bloqueio do portal B2B)

**Status:** em implementação · **bloqueia** login de IT externo até T2 + `BROKK_ORG_TENANCY=1`  
**ADR:** [0064](https://edda.coldcodelabs.com/decisoes/0064-brokk-org-scoped-builder-b2b/) (Edda)  
**Urðr:** `BROKK-47`  
**Relaciona:** ADR 0045 (CCL ID org-scoped), ADR 0041 (Lofn = portal comercial), ADR 0061 (Midgard executor), Asgard B2B (`~/ccl/asgard/docs/b2b/`), Midgard `docs/asgard-b2b-onboarding.md`

## Progresso (código)

| Fase | Estado |
|---|---|
| T0 session org + fail-closed layout | feito |
| T1 `logto_org_id` schema + ensureSchema | feito |
| T2 filtro projects/repos/tasks + connect | feito |
| T2 preview-gate por org | feito (`GET /previews/by-subdomain/:sub` + gate) |
| T2 studio / previews / Publicar | feito (runner bypass; humano escopado) |
| Flag | `BROKK_ORG_TENANCY=1` liga filtro; sem flag, layout bloqueia só-cliente |

**Ainda aberto:** smoke E2E com user de org de teste; convite IT (T4); UI “Novo projeto” self-serve (T3).

## Por que

Hoje o Brokk isola **chat por dono**; board, `repositories` e `projects` são **globais**. Qualquer usuário Logto autenticado no Brokk vê a fábrica CCL. Abrir isso para empresa-cliente = vazamento operacional.

Alvo do segmento “empresa builder na Asgard”: Brokk = porta (projetos, brief, preview, pedir/Publicar prod, Studio). Isso **só** depois de filtrar por org.

## Regra dura

Até os itens **T0–T2** abaixo estarem done em produção: **nenhum convite de cliente no Brokk**.

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
- Seat Claude / billing por org = fase posterior; throughput compartilhado permanece limite honesto na venda.
