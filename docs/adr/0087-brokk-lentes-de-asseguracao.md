---
title: "ADR 0087 — Brokk: lentes de asseguração (o ledger de achados é o que falta, não mais um revisor)"
description: "O Svalinn é excepcional em Sec, mas o que o faz bom não é o prompt de segurança — é o plano de asseguração: registro de engines, fingerprint/dedupe, triagem com justificativa, ciclo de vida do finding e o gate de controle negativo. Esse kernel é agnóstico de eixo. Esta ADR o generaliza para o Brokk como LENTE: QA, UI/UX, arquitetura, discovery e correção passam a produzir findings persistentes no mesmo ledger, com dedupe entre runs, verificação adversarial e orçamento por seat. Sec NÃO vira eixo do Brokk — continua no Svalinn (ADR 0079) e federa. A regra que separa eixo de opinião: uma lente só despacha forge se declarar sua PROVA de remediação executável; sem prova, é advisory e nunca fecha sozinha. O Eitri deixa de ser o revisor único e vira o publicador do conselho."
sidebar:
  order: 87
tags: [adr, decisao, brokk, review, qa, asseguracao, lentes, findings, eitri, huginn, svalinn, dedupe, controle-negativo, budget]
---

**Status:** Proposta · **PoC rodando** (`packages/assurance`, alvo arte-one, engine Cursor API) · **Data:** 2026-08-06 · **Escopo:** Brokk (`packages/db`, `apps/reviewer`, `packages/agents/{reviewer,scout}`, `apps/api`) · Svalinn (federação, sem migração de dado)
**Aplica ao Brokk a doutrina de registro da [ADR 0079](/decisoes/0079-svalinn-catalogo-de-engines-de-seguranca/)** · Consome [ADR 0005](/decisoes/0005-remediacao-frota-brokk/) (finding→card) · Evolui [ADR 0069](/decisoes/0069-brokk-story-qa-eitri-trigger/) (Story QA + Eitri sob trigger) · Resolve o item 4 da [ADR 0078](/decisoes/0078-brokk-one-shot-quality/) (nenhum gate toca estética) · Naming pela [ADR 0039](/decisoes/0039-corte-de-unhas-nomes-de-produto/)

> Nasce de uma pergunta do fundador: *"o Svalinn faz um trabalho excepcional em Sec, mas Sec poderia ser só um eixo do Brokk? Como trazer grandiosidade de revisão? O gargalo é review, código está abundante."*
> A resposta desta ADR: **o eixo não é o que falta — o ledger é.** E Sec continua no Svalinn.

## Contexto

### O gargalo é real e medido

IA responde por ~42% do código commitado (expectativa de 65% em 2027); 96% dos devs não confiam plenamente na correção funcional e só 48% sempre verificam antes de commitar; PRs gerados por IA esperam **4,6× mais** para serem pegos, e revisar 2× mais rápido depois não recupera o cycle time. O gargalo deixou de ser escrever código e passou a ser **decidir se é seguro mergear**. Na frota isso é literal: o Brokk é uma fábrica de PRs, e o Eitri é o único olho.

### O que o Svalinn tem e o Brokk não tem

Vale separar duas coisas que estão coladas:

| | conteúdo | plano |
|---|---|---|
| **Svalinn** | deepsec/semgrep/gitleaks/trivy — prompts e ferramentas de **segurança** | registro de engine com contrato mínimo · normalização p/ shape canônico · **fingerprint/dedupe** · severidade canônica · triagem com justificativa e lote · ciclo de vida `open → dispatched → awaiting_verification → fixed\|wontfix` · **gate de controle negativo** |

O plano é 100% agnóstico de segurança. É *ele* que faz o Svalinn parecer grandioso.

O Brokk hoje tem `reviews` (veredito efêmero do Eitri por PR), `runs`, `run_events` e `tasks` — **e nenhum ledger**. Sem fingerprint, sem dedupe entre runs, sem histórico de triagem, sem "esse achado eu já rejeitei mês passado". Cada review do Eitri nasce e morre no PR. O Svalinn **acumula**; o Eitri **esquece**. Essa é a diferença inteira.

### O mercado não fechou os furos que nós já fechamos

A categoria (~US$ 420 M ARR 2026, +US$ 1,2 bi levantados) escolheu pontos fixos na curva precisão×recall — Greptile 82% de captura com o maior ruído, CodeRabbit 44% quase sem ruído, Graphite Diamond 6% com FP ~zero — e todo mundo comenta no PR e esquece. Review standalone está sendo comoditizado pelo bundle das plataformas (Copilot, Bugbot, Claude Code). Os três furos abertos: **(a)** ledger persistente com dedupe entre runs, **(b)** prova de remediação (o mercado aceita "agente disse que consertou + testes verdes"), **(c)** multi-eixo com orçamento — que ninguém modela porque ninguém paga capacidade fixa, e nós pagamos.

### A medição de 19/07 é o ativo mais valioso do stack

O [LOOP.md do Svalinn](https://github.com/cold-code-labs/svalinn/blob/main/docs/LOOP.md) registra: nos dois criticals do Hauldr, **um fix veio com o mecanismo central falso** — comentário confiante explicando por que funcionava, 40 testes novos passando, `verify` verde — e teria saído **limpo num re-scan**. O `verify` prova que compila, não que o mecanismo existe.

Isso não é um detalhe de segurança. É a regra geral de qualquer eixo de revisão automatizada, e vira o critério de projeto desta ADR.

## Decisão

### 1. A LENTE é o único ponto de expansão de revisão do Brokk

Espelhando a ADR 0079 (engine é o ponto de expansão do Svalinn): **toda nova capacidade de revisão/QA/discovery do Brokk entra como uma LENTE no registro, atrás de um contrato mínimo. Não nasce app novo, não nasce nome novo.** `id` de lente é funcional (`review.correctness`, `qa.a11y`, `arch.debt`) — codinome nórdico é para produto (ADR 0039), e os produtos aqui já existem: Brokk (a forja) e Svalinn (a segurança).

```ts
// packages/assurance/src/lenses/<id>.ts
export const lens = {
  id: "review.correctness",
  axis: "review",
  kind: "llm" | "tool" | "federated",
  scope: "diff" | "repo" | "runtime",
  trigger: "pr" | "nightly" | "campaign",
  proof: "executable" | "advisory",   // ver §3 — o corte que importa
  cost: "cheap" | "heavy",            // orçamento de seat (§4)
  run(ctx): Promise<RawFinding[]>,
}
```

O normalizador por lente mapeia para o shape canônico e monta o `fingerprint` — mesmo desenho de `worker/normalize.mjs` no Svalinn. **Plugar lente nova não toca o pipeline.**

### 2. Sec NÃO vira eixo do Brokk — federa do Svalinn

A ADR 0079 é explícita: Svalinn é o único app de segurança, e toda capacidade de sec entra como engine dele. Esta ADR não a revoga. O Brokk **não** reimplementa SAST/DAST/RLS.

Federação, não migração: findings de sec continuam em `db_svalinn`; o Brokk os exibe no mesmo painel de PR/projeto via API do Svalinn, com `kind: "federated"` e `source: "svalinn"`. Nenhuma linha de finding de segurança se muda de banco. O fluxo finding→card Brokk da ADR 0005 continua sendo a única via de remediação de sec.

### 3. O gate de controle negativo vira regra de projeto — e define quais lentes existem

> **Uma lente só pode despachar forge e fechar achado sozinha se declarar sua prova de remediação executável.**

`proof: "executable"` exige, por lente, um **controle negativo**: algo que *falha antes* e *passa depois*, rodado contra o sistema real. `proof: "advisory"` produz achado que vira card ou nada — **nunca** transiciona para `fixed` sem humano.

| Lente | Eixo | Prova (controle negativo) | `proof` | Origem no repo |
|---|---|---|---|---|
| `review.correctness` | review | teste de regressão que falha no HEAD anterior | executable | `packages/agents/reviewer` (Eitri) |
| `review.simplification` | review | — (é julgamento) | advisory | skill `simplify` |
| `qa.functional` | qa | cenário Playwright falha antes / passa depois | executable | Huginn `scout/qa-discovery.ts` + Targeted QA (ADR 0069) |
| `qa.a11y` | qa | asserção WCAG 2.1 AA falha antes / passa depois | executable | novo (barato) |
| `ui.visual` | ui | screenshot diff + gate G do Litr | executable* | Playwright MCP + Chromium compartilhado do Chat |
| `arch.debt` | arch | — | advisory | `packages/repomap` (PageRank) |
| `product.discovery` | product | — | advisory | `scout/discovery.ts` |
| `sec.*` | sec | exploit reproduz antes / bloqueia depois | executable | **federado do Svalinn** |

\* `ui.visual` tem prova parcial: regressão visual é assertiva, gosto não é. Achado de gosto é `advisory` mesmo dentro da lente.

Sem esse corte, "QA + Discovery + UI/UX + Review" vira sopa de opinião de LLM e o painel morre de ruído em três semanas — que é como a maioria das ferramentas do mercado morre. Ele também resolve a tensão da ADR 0078 item 4 ("nenhum gate toca estética"): o Eitri continua **proibido** de dar `REQUEST_CHANGES` por design, porque design agora tem lente própria, advisory, com superfície própria — não sequestra o gate de merge.

### 4. Três camadas de gatilho, com orçamento de seat

O Brokk roda com **um seat** (North Star §1). "Todas as lentes em todo PR" é economicamente impossível e epistemicamente ruim.

| Camada | Quando | Lentes | Custo |
|---|---|---|---|
| **`pr`** | a cada PR, sob trigger (ADR 0069, `EITRI_MODE=trigger`) | só `scope: diff` e `cost: cheap` — `review.correctness`, `review.simplification`, `qa.a11y` | baixo, alta precisão |
| **`nightly`** | cadência por projeto (`cadence_hours`, igual Svalinn) | `scope: repo` — `arch.debt`, `qa.functional` completo, `ui.visual` | alto, alta recall |
| **`campaign`** | um eixo, um alvo, loop com gate até `clean` | qualquer lente `executable` | o LOOP.md, parametrizado por eixo |

O loop de campanha **permanece no Svalinn para sec** e, para os demais eixos, mora no Brokk — mas a doutrina do LOOP.md vale igual: o estado da campanha não pode viver na cabeça de um agente efêmero. Um tick, um passo, idempotente e serial.

### 5. O pipeline: fan-out → dedupe contra o ledger → verificação adversarial → publicação com orçamento

```
lentes em paralelo
  → normalize → fingerprint
  → dedupe contra o LEDGER INTEIRO (todos os fingerprints já vistos, não os desta run)
  → verificação adversarial: painel de lentes DISTINTAS (correção · segurança · reproduz?)
                              sobrevive quem ≥2 confirmam
  → rank por severidade × confiança
  → publica os N que cabem no budget de atenção; o resto CONTADO E VISÍVEL
```

**Dedupe é em DUAS camadas — corrigido pela medição do PoC (2026-08-06).** A
versão original desta ADR assumia que um fingerprint determinístico bastava. Não
basta quando a fonte é um agente: duas passadas da lente `arch.debt` no **mesmo
commit** do arte-one deduplicaram **3 de 10** — a LLM não repete o slug da regra
nem o título, então o mesmo defeito volta com identidade nova. Com a segunda
camada, **9 de 10** (o décimo era achado genuinamente novo).

| camada | o que é | custo | quando roda |
|---|---|---|---|
| 1 — fingerprint | `lente + arquivo + título normalizado` (sem número de linha) | zero | sempre |
| 2 — semântica | um julgamento "é o mesmo defeito?" contra os achados da mesma lente **no mesmo arquivo** | 1 chamada curta | só quando a camada 1 não bate e há candidatos |

A camada 2 é instruída a preferir **"mesmo"** na dúvida: republicar um achado que
o humano já triou custa mais que agrupar dois parecidos. Ela falha **fail-open**
(trata como novo) — buraco conhecido e declarado, cuja correção (fila de
re-tentativa) é trabalho de F1.

Duas regras não-negociáveis, ambas com falha conhecida:

- **Dedupe contra `seen`, nunca contra `confirmed`.** Se deduplicar contra confirmados, todo achado que o juiz rejeitou reaparece na próxima rodada e o loop nunca converge.
- **Nenhum corte silencioso.** Se o budget truncou, o painel diz quantos ficaram de fora. Truncar em silêncio lê como "cobrimos tudo" — é a mentira mais cara que um painel de asseguração pode contar.

### 6. Feedback loop: a triagem calibra a lente

Toda triagem exige justificativa (já provado no Svalinn) e alimenta duas coisas:

1. **Supressão por fingerprint** — achado rejeitado não volta; volta como `suppressed` com link para a justificativa original.
2. **Calibração da lente** — `accept_rate` por lente (aceitos / publicados) é métrica de primeira classe. Lente abaixo do piso por duas janelas consecutivas é **rebaixada a advisory automaticamente** e, persistindo, desligada. Uma lente que ninguém aceita não é uma lente; é ruído com CPU.

### 7. O Eitri deixa de ser o revisor e vira o publicador

Hoje o Eitri é o revisor único e a voz no PR. Passa a ser **a voz** — uma única mensagem no PR, consolidando o conselho de lentes já deduplicado e verificado. `review.correctness` continua sendo a lente dele. O veredito de merge (`APPROVE`/`REQUEST_CHANGES`) só pode ser movido por lentes `executable` do eixo `review`/`qa`; lentes advisory nunca bloqueiam merge.

## Modelo de dados (Brokk, `packages/db`)

```sql
create table findings (
  id             uuid primary key,
  project_id     uuid not null references projects(id),
  repo           text not null,
  lens_id        text not null,             -- 'review.correctness'
  axis           text not null,             -- 'review'|'qa'|'ui'|'arch'|'product'|'sec'
  source         text not null default 'brokk',  -- 'brokk' | 'svalinn' (federado)
  fingerprint    text not null,             -- dedupe estável entre runs
  cluster_id     uuid,                      -- rollup de achados irmãos
  severity       text not null,             -- critical|high|medium|low|info
  confidence     numeric,                   -- do verificador adversarial
  title          text not null,
  body           text,
  file_path      text, line_start int, line_end int,
  proof_kind     text not null,             -- 'executable' | 'advisory'
  proof_ref      text,                      -- teste/cenário/exploit que é o controle negativo
  status         text not null,             -- open|triaged|dispatched|awaiting_verification
                                            -- |fixed|wontfix|suppressed
  triage_reason  text,                      -- OBRIGATÓRIO em wontfix/suppressed
  triaged_by     text, triaged_at timestamptz,
  task_id        uuid references tasks(id), -- o card de remediação
  pr_url         text,
  first_seen_run uuid references runs(id),
  last_seen_run  uuid references runs(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, lens_id, fingerprint)
);

create table finding_events (   -- histórico imutável: quem mexeu, quando, por quê
  id uuid primary key,
  finding_id uuid not null references findings(id) on delete cascade,
  kind text not null,           -- seen|verified|refuted|triaged|dispatched|verified_fixed
  actor text, reason text, payload jsonb,
  created_at timestamptz not null default now()
);
```

`reviews` permanece (o veredito do Eitri por PR); passa a apontar para os findings que o sustentaram.

## Faseamento

| Fase | Entrega | Critério de pronto |
|---|---|---|
| **F0** | `findings` + `finding_events` + fingerprint + triagem com justificativa. Eitri **grava** em vez de só comentar. | um achado rejeitado não reaparece no PR seguinte |
| **F1** | Registro de lentes + as duas lentes `pr` baratas (`correctness`, `simplification`) + dedupe adversarial + budget de publicação | `accept_rate` medido por lente; nenhum corte silencioso |
| **F2** | Camada `nightly`: `arch.debt` (repomap) + `qa.functional` amarrado ao Story QA da ADR 0069 + `qa.a11y`; `proof_ref` obrigatório em lente executable | um finding só vai a `fixed` com controle negativo registrado |
| **F3** | Federação Svalinn (sec no mesmo painel, dado fica lá) + loop de campanha por eixo + `ui.visual` | painel único por projeto, multi-eixo |

## Consequências

**Positivas**

- O Brokk para de esquecer. Ganho de F0 é imediato e não depende de lente nova.
- O ledger é o ativo defensável: o mercado comoditizou o revisor, não a memória de revisão nem a prova de remediação.
- Custo fica sob controle explícito (camada × `cost`), em vez de emergir da conta do seat.
- A ADR 0078 destrava sem afrouxar o gate de merge: design ganha lente, não veto.

**Negativas / riscos**

- Mais uma tabela quente no `db_brokk` e mais estado para migrar. Aceito: é o ponto inteiro.
- Fan-out multi-lente satura o seat compartilhado se a camada `nightly` não respeitar cadência. Mitigação: mesma disciplina do Svalinn — dispare deliberadamente.
- `accept_rate` pode punir lente boa em projeto novo (baseline pequena). Mitigação: piso só vale após N publicações.
- Risco de o painel virar backlog eterno de advisory. Mitigação: advisory sem card em X dias expira.

## O que esta ADR NÃO faz

- **Não move o eixo de segurança para o Brokk.** ADR 0079 continua valendo integralmente.
- **Não move o loop de campanha de sec** para fora do Svalinn.
- **Não cria app novo nem nome novo.** Lente é serviço; os apps já existem.
- **Não automatiza o controle negativo.** Continua trabalho próprio, não um flip — exatamente como o LOOP.md decidiu.
- **Não cria lente advisory sem destino.** Achado que não pode virar card não deve ser gerado.

## Métricas de sucesso

- `accept_rate` por lente ≥ piso (a definir por lente na F1; sugestão inicial 40%).
- Achados publicados por PR ≤ orçamento, com o descartado sempre contado.
- **Reincidência** (fingerprint reaparecendo após `fixed`) → tende a zero. É a métrica que prova que o controle negativo funciona.
- Tempo até primeiro review humano em PR de agente — comparar com a linha de base (o 4,6× do mercado).

## Questões em aberto

1. `packages/assurance` dentro do Brokk ou pacote publicado que o Svalinn também consome? (Precedente: `@cold-code-labs/contorna-pack`.) Proposta: nasce em `packages/assurance` no Brokk; só extrai se o Svalinn quiser trocar o dele.
2. Ledger por projeto ou por repo? (Projeto ≠ repo em org multi-repo — ADR 0064.)
3. Piso de `accept_rate` por lente: valor único ou por eixo?
