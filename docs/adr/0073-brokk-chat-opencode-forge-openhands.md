---
title: "ADR 0073 — Brokk Chat/OpenCode · Forge/OpenHands (dissolve Sindri)"
description: "Chat = OpenCode; Forge/jobs = OpenHands; harness Brokk absorve lições AWF/AO. Dissolve o termo Sindri como produto."
sidebar:
  order: 73
tags: [adr, decisao, brokk, sindri, opencode, openhands, harness, awf, ao, chat, forge]
---

**Status:** Aceito · **Data:** 2026-07-23 · Depende de [ADR 0072](/decisoes/0072-brokk-openhands-omniroute/) · Fuel: [ADR 0071](/decisoes/0071-omniroute-fuel-line/) · Evolui superfície de chat (ex-Sindri)

# ADR 0073 — Brokk Chat/OpenCode · Forge/OpenHands

## Contexto

O Brokk acumulou duas superfícies com engines misturáveis e um nome de produto (**Sindri**) que já não descreve o sistema — parece um terceiro app, não a face de chat do Brokk. Em paralelo, o mercado separou bem:

- **Interactive agent** (OpenCode, Cline, Claude Code) — Plan/Build, sessão, MCP/skills.
- **Autonomous worker** (OpenHands, cloud agents) — tarefa → sandbox/worktree → PR.
- **Harness / control plane** (Brokk, e referências OSS **AWF** / **AO**) — claim, isolation, validate, PR monitor.

Já plugamos OpenHands na forge (ADR 0072). Insistir em chat nativo “estilo Cursor Plan” sem OpenCode é remar contra o mercado. Misturar OpenCode e OpenHands no mesmo processo recria Frankenstein.

## Decisão

### 1. Naming — dissolve “Sindri” como produto

| Antes (falar / UI) | Depois |
|---|---|
| Sindri (app/persona de chat) | **Brokk Chat** (superfície do Brokk) |
| “Sindri engine” | **Chat engine** = OpenCode |
| Código/pacotes `sindri` / `apps/chat` | migração gradual de *branding*; paths internos podem permanecer até sweep |

Persona mitológica pode continuar no tom de voz; **o termo de produto e de arquitetura é Brokk Chat**. Docs/ADRs novos não introduzem Sindri como sistema separado.

### 2. Duas lanes, zero mistura in-process

```text
                    OmniRoute ← LiteLLM (ADR 0071)
                            │
         ┌──────────────────┴──────────────────┐
         ▼                                     ▼
   Brokk Chat                            Brokk Forge / jobs
   (OpenCode)                            (OpenHands)
   Plan ↔ Build                          headless DoD
   skills / MCP / preview                claim → verify → PR
         │                                     ▲
         └──── card / job (handoff Brokk) ─────┘
```

1. **Brokk Chat = OpenCode** — Plan (read-only) → lock → Build leve; skills e preview **plugam em cima** do OpenCode (MCP / tools / bridge Brokk), não o contrário.
2. **Brokk Forge (e jobs de frota) = OpenHands** — ADR 0072; execução assíncrona com DoD.
3. **Não se misturam no mesmo processo.** Handoff só via **Brokk**: plano no Chat vira card/job → Forge OH (ou job Svalinn/Huginn/Eitri).
4. **Sessão persistente no Chat ≠ DoD de frota.** Background no Asgard (sessão OpenCode) não substitui claim/verify/acceptance/Eitri.
5. **Supersede** a consequência “Sindri `ChatEngine=openhands`” do ADR 0072 — chat **não** cutover para OH.

### 3. Referências de harness: AWF e AO (o que são)

**AWF — [Agent Workspace Fabric](https://github.com/dimileeh/agent-workspace-fabric)** (Apache-2.0)  
Control plane que trata agentes de coding (Codex, Claude Code, OpenCode, Cursor, …) como *contribuidores disciplinados*:

- worktree isolado + (opcional) Compose por task  
- validation por *profile* do projeto  
- abre PR  
- **PR-monitor loop**: review comments, CI vermelho, sync de base, auto-merge  

É o OSS mais próximo do **forge Brokk** (lifecycle genérico; o agente é plugável).

**AO — [Agent Orchestrator](https://github.com/AgentWrapper/agent-orchestrator)**  
“Agent IDE” / meta-harness desktop: frota de CLIs em paralelo, workspaces isolados, estado de PR, loop de CI/review de volta à sessão certa, **preview no inspector**.

É referência de **UX de missão + feedback loop**, não necessariamente de multi-tenant SaaS.

### 4. Como AWF/AO melhoram o harness Brokk (sem fork obrigatório)

Não substituímos Brokk por AWF/AO. **Absorvemos padrões** onde o nosso harness ainda é fraco:

| Padrão (AWF/AO) | Hoje no Brokk | Melhoria alvo |
|---|---|---|
| Profile de validate por app | `BROKK_VERIFY_CMD` / acceptance ad hoc | profiles versionados por projeto (como AWF) |
| PR-monitor loop | Eitri one-shot + auto-merge pontual | loop contínuo: comment/CI → re-claim OH → até merge/close |
| Agent pluggable no mesmo lifecycle | `BROKK_FORGE_ENGINE` | manter; Chat OpenCode e Forge OH são *dois* plugs, um harness |
| Preview ao lado da sessão (AO) | preview-proxy / live preview | Mission UI: plano + card + preview na mesma superfície Brokk Chat |
| Adopt PR existente no monitor (AWF) | parcial | “adotar PR” → monitor sem re-forjar do zero |

**Jobs de frota** (utilidade do OpenHands além do card manual):

| Gatilho | Job | Engine |
|---|---|---|
| Card / Story / Plan lock (Chat) | implementar | Forge + OH |
| Svalinn (sec) | fix + PR | OH |
| Huginn / Full QA fail | remediar | OH |
| Eitri request-changes / CI | heal | OH (PR-monitor) |

## Não-objetivos

- Reescrever Brokk em cima de AWF/AO.
- OpenHands como UI de chat.
- OpenCode como worker de claim/Story (salvo experimento explícito).
- Renomear todos os paths `sindri` neste ADR (sweep de código = follow-up).

## Consequências

- Branding e docs: **Brokk Chat** / **Brokk Forge**; Sindri = legado verbal.
- Implementação Chat: lane OpenCode + Omni (`baseURL` LiteLLM); skills/preview como tools/MCP sobre OpenCode.
- Forge permanece OH (0072); handoff Chat→Forge = card/job, nunca spawn OH dentro do turn OpenCode.
- Backlog de harness: (1) validate profiles, (2) PR-monitor loop estilo AWF, (3) Mission UI (Plan lock → cards) inspirada em AO/OpenCode Plan.
- Próximo ADR/implementação: bootstrap OpenCode no `apps/chat` + ponte MCP Brokk (preview, projects, open-pr).
