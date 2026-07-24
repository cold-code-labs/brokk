---
title: "ADR 0074 — Brokk = plataforma de desenvolvimento CCL (AO + AWF + Devin-class)"
description: "Um produto web multi-tenant: IDE (Chat/OpenCode) + fabric (Forge/OpenHands) + ingress org (cards de qualquer serviço). Plano executável + o que entra/sai."
sidebar:
  order: 74
tags: [adr, decisao, brokk, plataforma, ao, awf, devin, opencode, openhands, multi-tenant, north-star, roadmap]
---

**Status:** Aceito · **Data:** 2026-07-23 · Depende de [ADR 0073](/decisoes/0073-brokk-chat-opencode-forge-openhands/) · Engines: [0072](/decisoes/0072-brokk-openhands-omniroute/) · Fuel: [0071](/decisoes/0071-omniroute-fuel-line/)

# ADR 0074 — Brokk como plataforma de desenvolvimento CCL

## Contexto

ADR 0073 posicionou Brokk como harness AWF-class e engines Chat/Forge. A pergunta de produto é maior: **a CCL precisa de uma só plataforma de desenvolvimento** que, via Web multi-tenant, cubra o que o mercado partiu em produtos separados:

| Mercado | Papel | Exemplo |
|---|---|---|
| AO / Agent IDE | humano pilota missão | Cursor |
| AWF / fabric | lifecycle worktree→PR→monitor | AWF OSS, parte de Devin |
| Devin-class | org manda trabalho; agente responde sozinho | Devin, Factory |

Não escolhemos um. **Brokk é a plataforma** que contém os três, com engines de mercado (OpenCode / OpenHands) e fuel Omni (ADR 0071). Sindri dissolveu-se em Brokk Chat (0073).

## Decisão — arquitetura correta

### 1. Um produto: Brokk

**Brokk = plataforma de desenvolvimento da CCL.** Acesso principal: **Web**, multi-tenant (conta → orgs/projetos → board/chat/preview/runs). Não é “mais um CLI”; é o lugar onde a frota e, depois, serviços externos *mandam trabalho* e *recebem PRs*.

### 2. Três capacidades, uma caixa

```text
                    ┌──────────────────────────────────────┐
                    │           BROKK (plataforma)         │
                    │     Web · multi-tenant · Omni fuel   │
                    │                                      │
   ingress ────────►│  cards / jobs / missions             │
   (Slack, Svalinn, │         │                            │
    Huginn, API,    │         ▼                            │
    outros CCL)     │  ┌─────────────┐  ┌───────────────┐  │
                    │  │ Brokk Chat  │  │ Brokk Forge   │  │
                    │  │ OpenCode    │  │ OpenHands     │  │
                    │  │ (AO surface)│  │ (AWF worker)  │  │
                    │  └──────┬──────┘  └───────▲───────┘  │
                    │         │  handoff card/job │         │
                    │         └─────────┬─────────┘         │
                    │                   ▼                   │
                    │  fabric: worktree · verify · preview  │
                    │  PR · Eitri · monitor* · promote      │
                    └──────────────────────────────────────┘
```

| Capacidade | O que o usuário sente | Engine / peça |
|---|---|---|
| **AO (IDE web)** | Abre Brokk, conversa, Plan, preview, skills | **Chat = OpenCode** + UI Brokk |
| **AWF (fabric)** | Card vira PR com DoD | **Forge = OpenHands** + harness Brokk |
| **Devin-class (org)** | Outro serviço fala com Brokk → card → esteira | **API / ingress** → mesmo fabric |

Humano no browser = AO. Card na fila = AWF. Svalinn/Huginn/Slack/API = Devin-class. **Mesmo board, mesmo projeto, mesmo Omni.**

### 3. Engines (não negociar de novo)

- **Chat → OpenCode** (Plan/Build, MCP/skills/preview plugados).
- **Forge / jobs → OpenHands** (headless DoD).
- Handoff só via **card/job Brokk** (ADR 0073). Sem mistura in-process.

### 4. Multi-tenancy (já é o eixo do Web)

- Conta (Logto) → orgs → **projetos** → board/chat/runs/preview.
- Ingress Devin-class autentica como app/serviço e **cria cards no projeto** (staff/API secrets / agent tokens) — não bypassa tenancy.
- Forge workers são frota compartilhada; **isolamento é por worktree/projeto**, não por “um Devin por humano”.

### 5. O que entra / sai / fica

**Entra (construir / adotar)**

| Item | Por quê |
|---|---|
| OpenCode no Chat | AO de mercado; Plan/Build |
| OpenHands no Forge/jobs | worker DoD (já 0072) |
| Mission UI (Plan lock → cards + preview) | AO completo no Web |
| Validate profiles + PR-monitor | AWF completo |
| Ingress API estável (“responde → cria card”) | Devin-class / plugar CCL |
| Jobs: Svalinn, Huginn/QA, Eitri heal | org autonomous |

**Fica ( Brokk nativo — valor CCL)**

| Item | Por quê |
|---|---|
| Board / cards / lease / Story | control plane |
| Preview-proxy + Coolify frota | multi-app |
| Eitri + promote Gjallarhorn | review + ship CCL |
| Omni / LiteLLM / Lago | fuel + custo |
| Multi-tenant Logto | produto SaaS |

**Sai / não insistir**

| Item | Por quê |
|---|---|
| Chat engine nativo competindo com OpenCode | mercado faz melhor |
| OH como UI de chat | papel errado |
| Sindri como produto | dissolve (0073) |
| Reimplementar AWF/AO do zero | adotar engines + copiar padrões |
| “Tudo no turn do chat” sem card | quebra DoD |

**Adia**

| Item | Nota |
|---|---|
| Desktop Agent IDE (AO nativo tipo Cursor app) | Web primeiro |
| Sandbox Docker OH (vs `RUNTIME=process`) | depois do cutover estável |
| VPC “Devin dedicated” | frota Coolify basta no médio prazo |

## Plano executável

Inventário fechado 2026-07-23 → implementação empurrada no mesmo ciclo.

### Fase 0 — Baseline ✅

| Item | DoD |
|---|---|
| OH no Forge | `BROKK_FORGE_ENGINE=openhands` (default compose + app) |
| Omni fuel | LLM_* → LiteLLM → OmniRoute |
| Tenancy T0–T2 | conta → projeto (Logto) |

### Fase 1 — Chat = OpenCode (AO) ✅

| Entrega | Paths | DoD |
|---|---|---|
| Driver CLI | `packages/afl/src/opencode-cli.ts` | `opencode run --format json` → AgentEvent |
| Engine wire | `apps/chat` + `cli-turn` + UI | default `opencode` quando available |
| Fuel Omni | `buildOpenCodeCliEnv` | LiteLLM via openai-compatible |
| Imagem | `apps/chat/Dockerfile` | `opencode-ai` pinned |
| MCP Brokk | `apps/chat/src/brokk-mcp-server.ts` | enqueue_card / projects / preview |

### Fase 2 — Mission UI (AO surface) ✅ (skeleton)

| Entrega | Paths | DoD |
|---|---|---|
| Página Mission | `apps/web` `/mission` | goal → mission → cards + status |

### Fase 3 — Ingress Devin-class ✅

| Entrega | Paths | DoD |
|---|---|---|
| Contrato estável | `POST /ingress/cards` + `docs/INGRESS.md` | brief → card + dedupeKey |
| Org jobs curls | Svalinn / Huginn / Eitri-CI | mesmo endpoint |

### Fase 4 — AWF completo ✅ (MVP)

| Entrega | Paths | DoD |
|---|---|---|
| Validate profiles | `.brokk/profile.json` + `apps/forge/src/profile.ts` | override `BROKK_VERIFY_CMD` |
| PR-monitor | `apps/api/src/pr-monitor.ts` + webhooks | review/CI → revise + dedupe |
| Cutover defaults | compose + Chat UI + forge default | Chat=opencode · Forge=openhands |

Docs: `docs/VALIDATE-PROFILES.md`, `docs/PR-MONITOR.md`, `docs/INGRESS.md`.

## Por que esta é a arquitetura certa

1. **Um produto** — não Chat vs Forge vs “Devin Brokk”; é Brokk com três modos de entrada.
2. **Engines de mercado** — OpenCode/OH; Brokk não compete com All Hands/SST no agent loop.
3. **Harness CCL** — multi-tenant, preview, Story, Eitri, Omni: o que Devin/Cursor não são pra frota interna.
4. **Ingress = card** — qualquer serviço “pluga” sem novo pipeline; Forge já existe.
5. **AO + AWF + Devin-class** no mesmo fabric evita Frankenstein de três apps.

## Não-objetivos

- Substituir Cursor no laptop do fundador (Brokk Web ≠ editor local).
- Fork AWF/AO.
- Um OpenHands por usuário sentado (é frota de workers).

## Consequências

- North-star de produto: **plataforma de desenvolvimento CCL**, não “kanban com agent”.
- Fases 0–4 entregues no código (MVP); refinamentos de Mission compose / multi-profile DB / agent tokens ficam como follow-ups.
- Marketing/docs: Brokk = IDE web + esteira + autônomo org; Chat/Forge são superfícies, não produtos.
- ADR 0073 permanece válido para engines/naming; **este ADR fixa o envelope de produto e o plano de execução**.
