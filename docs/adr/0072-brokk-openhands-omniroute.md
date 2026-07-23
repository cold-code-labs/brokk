---
title: "ADR 0072 — Brokk → OpenHands ↔ OmniRoute (mãos pluggable)"
description: "OpenHands como AgentEngine do forge; modelos só via LiteLLM→OmniRoute. Dissolve hardcode Cursor/Claude no worker."
sidebar:
  order: 72
tags: [adr, decisao, brokk, openhands, omniroute, forge, engine, plug-in]
---

**Status:** Aceito · **Data:** 2026-07-23 · Depende de [ADR 0071](/decisoes/0071-omniroute-fuel-line/) (OmniRoute fuel line) · Evolui Brokk forge engines

# ADR 0072 — Brokk → OpenHands ↔ OmniRoute

## Contexto

O forge Brokk está amarrado a lanes hardcoded (`cursor-cli`, `claude-cli`/`cli`, `afl`). Trocar de seat/provider exige binário + env específicos no worker. A frota já tem **OmniRoute** (ADR 0071) como fuel line multi-provider atrás do LiteLLM. OpenHands (All Hands) já falou com Omni no e2e (`openhands-omni-e2e-notes`, profile `omni-cursor` → `openai/cursor/auto`).

Queremos **mãos over-powered pluggable** e **fuel trocável** sem reescrever claim/Story/Eitri.

## Decisão

```text
Brokk (orquestra) → OpenHands (mãos) ↔ LiteLLM → OmniRoute (modelos)
```

1. **Brokk continua** dono de: claim, lease, worktree, verify, acceptance, push/PR, Story, Eitri, preview.
2. **OpenHands** entra como `AgentEngine` (`BROKK_FORGE_ENGINE=openhands`), espelhando `CliEngine` / `cursor-cli`.
3. **LLM só via env** no processo OH: `LLM_BASE_URL` + `LLM_API_KEY` (vkey LiteLLM) + `LLM_MODEL` (ex. `openai/cursor/auto`). **Sem** `CURSOR_API_KEY` / OAT Claude nesta lane.
4. **MVP:** `openhands --headless --json --override-with-envs -t …` no worktree do Brokk com `RUNTIME=process` (sem Docker sock no forge). Agent-server / Docker sandbox OH = fase posterior.
5. **Default da frota** permanece `cursor-cli` até shadow worker verde; cutover por env/flag. Binário OH vai na imagem forge (pin `BROKK_OPENHANDS_VERSION`).

## Não-objetivos

- Substituir Brokk por OpenHands UI.
- Substituir LiteLLM/Lago.
- Cutover Claude no Omni (bloqueio org — ADR 0071 F2).

## Consequências

- Novo driver `@brokk/afl` `runOpenHandsCliTurn` + `OpenHandsCliEngine`.
- Imagem forge instala o binário `openhands` (pin); sem `LLM_*` → fallback ruidoso.
- `RUNTIME=process` no child — edita o worktree Brokk in-place.
- Observabilidade: eventos JSONL OH → `AgentEvent` (board/Langfuse).
- Próximo: shadow cutover forge; agent-server OH opcional. Chat → OpenCode ([ADR 0073](/decisoes/0073-brokk-chat-opencode-forge-openhands/)), **não** ChatEngine=openhands.
