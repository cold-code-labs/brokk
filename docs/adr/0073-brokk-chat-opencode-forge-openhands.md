---
title: "ADR 0073 — Brokk = harness AWF-class · Chat/OpenCode · Forge/OpenHands"
description: "Brokk é o control plane (classe AWF). Chat=OpenCode, Forge/jobs=OpenHands. AO inspira UX de missão. Dissolve Sindri."
sidebar:
  order: 73
tags: [adr, decisao, brokk, sindri, opencode, openhands, harness, awf, ao, chat, forge]
---

**Status:** Aceito · **Data:** 2026-07-23 · Depende de [ADR 0072](/decisoes/0072-brokk-openhands-omniroute/) · Fuel: [ADR 0071](/decisoes/0071-omniroute-fuel-line/) · Evolui superfície de chat (ex-Sindri)

# ADR 0073 — Brokk harness · Chat/OpenCode · Forge/OpenHands

## Contexto

O Brokk acumulou duas superfícies com engines misturáveis e um nome (**Sindri**) que parece um terceiro produto. O mercado separou três camadas; nós já somos a do meio e às vezes tentamos reinventar as outras:

| Camada | Exemplos de mercado | No Brokk |
|---|---|---|
| Interactive agent | OpenCode, Cline, Claude Code | Chat (ex-Sindri) — a fortalecer |
| Autonomous worker | OpenHands, cloud agents | Forge + jobs — OH (ADR 0072) |
| **Harness / control plane** | **AWF**, AO (parcial) | **Brokk** — board, claim, worktree, verify, PR, preview, Story, Eitri |

Insistir em chat nativo “estilo Plan” sem OpenCode é remar contra o mercado. Misturar OpenCode e OpenHands no mesmo processo recria Frankenstein. Confundir Brokk com “mais um agent” esconde o valor real: **somos o fabric**.

## Visão completa (onde cada um senta)

```text
┌─────────────────────────────────────────────────────────────┐
│  BROKK = harness / control plane (classe AWF)               │
│  projects · cards · lease · worktree · verify · acceptance  │
│  preview · Story · Eitri · jobs (Svalinn/Huginn/…) · Omni   │
│                                                             │
│   Brokk Chat              │         Brokk Forge / jobs      │
│   engine: OpenCode        │         engine: OpenHands       │
│   Plan ↔ Build            │         headless DoD            │
│   skills/MCP/preview*     │         claim → PR → monitor*   │
│           │               │                ▲                │
│           └──── card / job (só handoff Brokk) ─────────────┘│
└─────────────────────────────────────────────────────────────┘
* preview e PR-monitor são do harness Brokk; o agent só consome/dispara.
```

**Uma frase:** Brokk é o AWF da frota CCL; OpenCode e OpenHands são *contribuidores plugáveis*; AO é referência de UX de missão, não o tipo do produto.

## Brokk ≈ AWF ou AO?

**Brokk ≈ AWF (control plane), não AO (Agent IDE desktop).**

| | **AWF** | **AO** | **Brokk** |
|---|---|---|---|
| O que é | Fabric server-side: worktree → validate → PR → **monitor** | Desktop: frota de CLIs + preview + feedback na UI | SaaS multi-tenant + frota Coolify |
| Agente | Plugável (Codex, CC, OpenCode, Cursor…) | CLI agents em paralelo | Chat=OpenCode · Forge=OH |
| Isolation | worktree (+ Compose/profile) | worktree local | worktree forge + preview-proxy |
| Loop pós-PR | CI / review comment → re-agent → merge | devolve falha à sessão certa | Eitri + auto-merge (ainda raso vs AWF) |
| UX | ops / API | mission + inspector + preview | board + Chat (+ Mission UI a construir) |

- **Já somos AWF-class** no núcleo (claim, worktree, verify, PR, multi-app).  
- **Não somos AO** (não é IDE desktop de frota local).  
- **Copiamos de AO** só o que falta na *superfície*: Mission (plano + cards + preview juntos).  
- **Copiamos de AWF** o que falta no *loop*: validate profiles + PR-monitor contínuo.

Não forkamos AWF/AO. Absorvemos padrões.

## Decisão

### 1. Naming — dissolve “Sindri” como produto

| Antes | Depois |
|---|---|
| Sindri (app/produto) | **Brokk Chat** |
| “Sindri engine” | **Chat engine** = OpenCode |
| paths `sindri` / `apps/chat` | branding agora; rename de código = sweep depois |

Persona mitológica ok no tom; **arquitetura e produto falam Brokk Chat / Brokk Forge**.

### 2. Engines — duas lanes, zero mistura in-process

1. **Brokk Chat = OpenCode** — Plan → lock → Build leve; skills e preview **em cima** do OpenCode (MCP/bridge Brokk).
2. **Brokk Forge / jobs = OpenHands** — ADR 0072; DoD assíncrono.
3. Handoff **só via Brokk** (card/job). Nunca OH dentro do turn OpenCode, nem OpenCode no claim loop.
4. Sessão persistente no Chat (Asgard) ≠ pipeline DoD (verify/acceptance/Eitri/promote).
5. **Supersede** “Sindri `ChatEngine=openhands`” do ADR 0072.

### 3. Melhorias de harness (backlog explícito)

| Padrão | Fonte | Hoje | Alvo |
|---|---|---|---|
| Validate profile por app | AWF | verify/acceptance ad hoc | profiles versionados no projeto |
| PR-monitor loop | AWF | Eitri one-shot + auto-merge pontual | comment/CI → re-claim OH → merge/close |
| Adopt PR | AWF | parcial | monitor sem re-forjar |
| Mission UI | AO + OpenCode Plan | board + chat separados | Plan lock → cards + preview na mesma superfície |
| Agent pluggable | AWF | `BROKK_FORGE_ENGINE` | manter; Chat e Forge = dois plugs, um fabric |

**Jobs OH (além do card manual):** Svalinn sec-fix · Huginn/QA remediar · Eitri/CI heal (via PR-monitor).

## Não-objetivos

- Reescrever Brokk em AWF/AO.
- Virar Agent IDE desktop (AO).
- OpenHands como UI de chat; OpenCode como worker de Story (salvo experimento).
- Sweep completo de paths `sindri` neste ADR.

## Consequências

- Brokk posicionado como **fabric AWF-class**; OpenCode/OH = engines; AO = UX de missão.
- Docs/UI: Brokk Chat / Brokk Forge; Sindri = legado.
- Implementação: OpenCode no Chat + Omni; Forge = OH; handoff = card/job.
- Harness backlog priorizado: (1) validate profiles, (2) PR-monitor, (3) Mission UI.
- Próximo: bootstrap OpenCode em `apps/chat` + MCP Brokk (preview, projects, enqueue-card).
