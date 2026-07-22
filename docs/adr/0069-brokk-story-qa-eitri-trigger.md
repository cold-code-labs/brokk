---
title: "ADR 0069 — Story QA: um PR por história, re-QA e Eitri sob trigger"
description: "qa-fail agrupados em Plan (história) por módulo; forge sem PR por card; Targeted QA ao fechar a história; um PR final; Eitri só sob POST explícito (sem poll constante). Evolui ADR 0066/0067."
sidebar:
  order: 69
tags: [adr, decisao, brokk, huginn, qa, story, plan, eitri, forge, anti-spam]
---

**Status:** Aceito · **Data:** 2026-07-22 · **Piloto:** Arte One · Evolui [ADR 0066](/decisoes/0066-brokk-full-qa-discovery-execution/) · [ADR 0067](/decisoes/0067-brokk-huginn-discovery-qa/)

> Fecha o loop Discovery → QA → Forge → **re-QA** → **um PR** → Eitri, sem PR-spam e sem avaliação constante do Eitri.

## Contexto

Antes desta ADR:

- Cada `qa-fail` Approve → branch + PR próprio (spam).
- Eitri polla open PRs da frota a cada ~30s.
- `done` no forge ≠ cenário QA revalidado.

Já existia `Plan` com `featureBranch` compartilhada — a peça certa para história.

## Decisão

### 1. História = Plan

`POST /projects/:id/approve-qa-stories` agrupa backlog `qa-fail` por **módulo** do catálogo QA (fallback `qa`). Cria um Plan por módulo (`storyModule` set, `mode=feature`, branch `story/qa-<module>-<short>`), associa cards (`planId`/`planKey`), enfileira.

### 2. Forge sem PR por card de Story

Cards com `plan.storyModule` commitam na `featureBranch` e **não** abrem PR. Card → `done`/`failed`. Plan fica `forging` até o gate.

### 3. Re-QA automático

Quando todos os cards da Plan estão terminais (`done`/`cancelled`) e nenhum `failed` bloqueante (ou política: só `done`), Brokk dispara **Targeted QA** nos scenario ids (`qa-fail:<id>`). Resultado em `plans.validation_status` + `validation_run_id`.

- `pass` → Story pronta para PR
- `fail` → reabre/re-enfileira fails; Plan não abre PR

### 4. Um PR + Eitri trigger

`POST /plans/:id/open-pr` (humano ou auto após pass): abre **um** PR da `featureBranch` → base do projeto; grava `prUrl`. Em seguida `POST` interno ao Eitri **só para esse PR**.

### 5. Eitri `EITRI_MODE=trigger`

- `poll` (legado): loop atual
- `trigger` (padrão frota após esta ADR): **sem** `listOpenPrs` contínuo; só `POST /eitri/review { repo, prNumber }`

## Consequências

- Approve all clássico (discovery/plan/qa-fail soltos) permanece; Stories QA usam o endpoint novo.
- Plans Mímir sem `storyModule` mantêm comportamento atual (PR no primeiro card).
- Closed loop mensurável: N fails/módulo → 1 branch → 0 PRs intermediários → 1 PR → 1 review Eitri.
