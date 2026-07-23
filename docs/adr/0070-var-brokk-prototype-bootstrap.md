---
title: "ADR 0070 — Bootstrap de protótipo: Var ↔ Brokk (e Brokk chat-first)"
description: "Um motor Enhance→Rank→Hero para Var e Brokk chat-first. Identidade provisória no nascimento — sem nome DNS fixo como pré-step. Evolui ADR 0038."
sidebar:
  order: 70
tags: [adr, decisao, brokk, var, heimdall, prototipo, provisionamento, litr, muninn, huginn, ux]
---

**Status:** Aceito (decisão) · **implementação em fatias** · **Data:** 2026-07-23  
**Escopo:** Var, Brokk, Heimdall (engine) · Evolui [ADR 0038](https://edda.coldcodelabs.com/decisoes/0038-brokk-face-v0/) · Muninn / Huginn / Litr (0028)

# ADR 0070 — Bootstrap de protótipo: Var ↔ Brokk (e Brokk chat-first)

> Fecha o sweet spot que o mercado (v0 / Lovable / Replit) acerta com prompt solto — **Enhance → Rank → Hero paint** — usando o que a CCL já tem de concreto (pedidos, Saga, brief) **e** o caminho nativo do Brokk sem nome DNS fixo como pré-step.

## Contexto

### O que já funciona (ADR 0038)

**Nova Conversa** hoje: digitar um **nome** → Heimdall slugifica → repo + Hauldr `_dev` + preview `<slug>.preview…` + sessão Sindri. Prod só no **Publicar**.

Var **Iniciar protótipo** reutiliza isso: precisa de um nome (CRM / overview) para o mesmo `POST /conversations`, depois pode enfileirar `from-brief` com pedidos.

### Onde dói

1. **Nome/domínio como pré-step.** O gesto feliz do mercado é: *Novo projeto → chat abre → faz o pedido → já começou*. Hoje o nome amigável (e o slug DNS/repo) bloqueia o parto.
2. **`from-brief` monolítico.** Pedidos crus viram uma task gigante; sem Expand/Rank, sem Hero set, sem Litr no zero — perde o sweet spot (criatividade × spec limpo × vetor de negócio).
3. **Duas portas, um motor.** Var chega com insumos ricos; Brokk isolado chega com um chat vazio. Sem contrato comum, cada porta inventa um bootstrap.

DNS wildcard (`*` / `*.preview`) **já cobre qualquer slug** (ADR 0038) — o gargalo não é Cloudflare; é o produto exigir identidade permanente *antes* da conversa.

## Decisão

### 1. Um motor, duas portas

| Porta | Entrada | O que alimenta o motor |
|---|---|---|
| **Var** | Cliente → Projeto → pedidos (Saga / arquivos / manual) | Insumos estruturados |
| **Brokk** | Novo Projeto → chat → primeiro pedido | Prompt (+ anexos); Enhance sintetiza o Pack |

O motor é o mesmo: **Prototype Pack → Hero forge → cards de profundidade**. Heimdall continua **única engine** de provisionamento; Brokk orquestra UX + forge; Var orquestra CRM + gate quando a origem é comercial.

### 2. Nascimento chat-first com identidade provisória

Inverte o *pré-requisito de nome* da superfície feliz (a 0038 permanece válida como **birth nomeado** explícito).

**Alvo UX:**

```
Novo Projeto → abre Novo Chat → usuário faz o pedido
  → provisionamento (async) + Enhance + Hero forge começam
```

**Identidade:**

| Camada | No nascimento | Depois |
|---|---|---|
| **Id técnico** | Slug provisório estável (`p-<nanoid>` ou `proj_<short>`) — repo, Hauldr `_dev`, preview host | Imutável (ou rename raro, ops) |
| **Nome de exibição** | “Novo projeto” / título do CRM / 1ª linha do pedido | Editável a qualquer momento |
| **Slug amigável (claim)** | Ausente | Opcional antes do **Publicar**; mapeia prod `<claim>.coldcodelabs.com` (e, se quiser, alias de preview). Sem claim, Publicar usa o id técnico |

Regras:

- Chat **abre na hora** (sessão Sindri + project row); provision Heimdall pode ser `202` + progresso na UI.
- O **primeiro pedido** (ou “Iniciar” no Var com Pack pronto) é o trigger de: ensure provision → Pack → Hero.
- Colisão 409 no claim → pedir outro slug; id técnico nunca depende do claim.
- Birth **nomeado** (digitar “MarkupLab” no form clássico) continua: slug = slugify(nome), sem provisório — compat 0038.

### 3. Prototype Pack (Enhance + Rank)

Antes de qualquer forge de produto, uma passada (LLM + schema) produz o **Pack**:

- `mission` — uma frase do que o protótipo prova  
- `context` — quem usa, em que momento, que decisão (estilo v0)  
- `constraints` — só frontend, mock, Next (`template-web-coolify-light` / Heimdall `client`), sem BaaS  
- `design_read` — vibe + dials Taste; semente Litr  
- `hero_set[]` — **≤ 4 salas** que vendem na demo (rota, job, dados fake, prioridade)  
- `deferred[]` — pedidos/áreas que existem mas **não** entram no Hero (não somem)  
- `evidence[]` — citações Saga / trechos de pedido (quando houver)

**Rank (vetor de negócio):** prioriza o que fecha a discovery (landing + 1–2 shells do core), não a cobertura do backlog.

**Gate:**

- **Var:** operador revisa Pack (cortar/escalar salas) → “Enviar ao Brokk”.  
- **Brokk chat:** Pack aparece no fio (Plan Mode leve); segue em frente salvo interrupção — ritmo mercado, com insumos melhores quando Var alimentou.

### 4. Hero forge, depois profundidade

1. **Ensure** preview no Next client (Heimdall `template: client` → `template-web-coolify-light`, dev-first, 0038).  
2. **Hero run (1):** Litr (`litr-frontend-design` / soul + DESIGN) **e** as salas do `hero_set` num app **navegável e coerente** — o “primeiro paint” que vende. Skills de anti-slop (Taste / frontend-design) entram aqui, não em cada card. Tipografia: manter Geist do template (não puxar famílias novas via `next/font/google` — acceptance GET `/` 500).  
3. **Profundidade:** restante/`deferred` → cards PROPOSED (formato Muninn / `backlog-from-brief`); approve → forge.  
4. **Publicar** (0038) só após fechar com o cliente — fora do bootstrap.

`from-brief` monolítico **deixa de ser** o bootstrap canônico; pode restar como atalho legado até a migração.

### 5. Contrato Var ↔ Brokk (mínimo)

Var guarda: `brokk_project_id`, `preview_subdomain` (ou id técnico), pedidos, Pack (versão).  
Brokk expõe (nomes ilustrativos; implementação em cards):

- nascimento chat-first / nomeado (evolui `POST /conversations`)  
- `POST …/prototype-pack` (aceita Pack pronto **ou** insumos crus para Enhance)  
- `POST …/hero-forge` (enfileira o Hero run a partir do Pack aprovado)  
- cards de profundidade via Muninn/Huginn já existentes  

Idempotência: Pack versionado por projeto; re-Enhance não duplica Hero se já houver run ativo/sucesso no mesmo hash (política fina na implementação).

## Não-objetivos

- Não é clonar Lovable (sem BaaS mágico no protótipo).  
- Não substitui Publicar / rollback (0038).  
- Não exige Pack perfeito: Hero set curto > especificação enciclopédica.  
- Não renomear repo GitHub a cada claim — claim é **DNS/prod + display**; id técnico estável.

## Consequências

- **UX:** Brokk isolado ganha o gesto mercado; Var ganha o mesmo motor com insumos superiores.  
- **Heimdall:** create com slug provisório + API de **claim** (prod host / metadata); engine única.  
- **Brokk UI:** “Novo projeto” sem campo de domínio obrigatório; progresso de provision no chat.  
- **Var:** Iniciar = ensure birth (nome CRM **ou** provisório) → Pack gate → Hero; não mais dump de pedidos.  
- **Qualidade:** Litr no Hero evita skin genérica; Rank evita 12 telas mediocres.  
- **Risco:** provisório feio na URL de preview — aceitável até o claim; demo cliente pode esperar claim ou usar display name na conversa.

## Fatias de implementação (cards)

| Id | Fatia | Aceite |
|---|---|---|
| H1 | Schema Pack + Enhance (insumos → Pack) | JSON validado; hero_set ≤ 4 | ✅ |
| H2 | Var: UI gate Pack → envia ao Brokk | Operador edita salas; POST idempotente | ✅ |
| H3 | Brokk: Hero forge (Litr + salas) no preview | Preview navegável cobrindo hero_set | ✅ (from-brief Hero) |
| H4 | Profundidade via Muninn/Huginn a partir de deferred | Cards PROPOSED; approve funciona | ✅ |
| H5 | Chat-first birth + slug provisório | Novo Projeto → chat sem nome DNS; provision async | ✅ |
| H6 | Claim de slug amigável pré-Publicar | Claim sem recriar Hauldr; 409 tratado | ✅ |

Citar commits: `ADR 0070 / Hn`.

## Relação com ADRs

| ADR | Papel |
|---|---|
| 0038 | Dev-first, Publicar, preview sem `-dev` — **base**; esta ADR afrouxa só o pré-step de nome |
| 0028 / Litr | Soul no Hero (H3) |
| Muninn / Huginn | Profundidade (H4), não o primeiro paint |
| 0008 | Superada no nascimento pela 0038; esta ADR não a reabre |
