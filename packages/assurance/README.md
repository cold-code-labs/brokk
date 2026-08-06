# @brokk/assurance — PoC

Implementação-piloto da **[ADR 0087](../../docs/adr/0087-brokk-lentes-de-asseguracao.md)**:
lentes de asseguração com **ledger de achados**. O que o Brokk não tem hoje não é
mais um revisor — é memória de revisão.

> **Status: PoC.** `.mjs` sem build (mesmo padrão do worker do Svalinn), ledger em
> SQLite. O schema espelha `sql/0001_findings.sql`, que é o alvo no `db_brokk`.
> Nada aqui está plugado no `apps/reviewer` ainda.

## Engine

**Cursor API**, igual o Svalinn (`worker/engines/report.mjs`, `--agent cursor`):
binário `cursor-agent` headless autenticado por `CURSOR_API_KEY`. Sem gateway no
meio — é a API do Cursor direto.

A chave vem de `CURSOR_API_KEY` ou do cofre local `~/.config/ccl/cursor_api_key`.

```bash
node bin/assurance.mjs doctor
```

## Uso

```bash
node bin/assurance.mjs lenses

# lente de repo (advisory)
node bin/assurance.mjs run --project arte-one --repo ~/ccl/arte-one --lens arch.debt

# lente de diff (a do Eitri, agora com ledger)
node bin/assurance.mjs run --project arte-one --repo ~/ccl/arte-one \
  --lens review.correctness --base main

node bin/assurance.mjs list   --project arte-one --status open
node bin/assurance.mjs triage 1a2b3c4d --status wontfix --reason "by design: ..."
node bin/assurance.mjs stats  --project arte-one
```

## Medido (arte-one, 2026-08-06, engine Cursor API)

| o que | resultado |
|---|---|
| `arch.debt`, 1ª passada | 10 achados; pegou **4/4 do gabarito** da ADR 0078 (god-component de 1.008 LOC, `docs/STACK.md` com o stack errado, ilha morta de `config/*`, tokens furados) + 3 que a auditoria humana não pegou |
| dedupe, fingerprint só | **3/10** em duas passadas no MESMO commit — a LLM não repete slug nem título |
| dedupe, 2 camadas | **9/10** (o décimo era achado genuinamente novo) |
| `review.correctness` no diff `main...dev` | 6 achados, 1 refutado; 3 `critical` de escalação de privilégio em RLS |
| 2ª passada da `review.correctness` | 7 brutos → 6 deduplicados, **2 suprimidos** (1 `wontfix` humano + 1 falso-positivo da verificação), 1 novo |
| verificadores, por ângulo | `existe` 6/6 confirmou · `importa` 4/6 · **`prova` refutou 5/6** |

As duas últimas linhas viraram correção de desenho — ver "o que mudou por medição".

## O que este PoC prova (e o que não prova)

**Prova:**

1. **Dedupe entre runs**, em duas camadas: fingerprint sem número de linha +
   julgamento semântico por arquivo. Rodar de novo não republica.
2. **Triagem é permanente.** `wontfix`/`false_positive` viram `suppressed`: o
   achado não volta, e a justificativa fica no `finding_events`. Triagem **sem
   justificativa falha** em vez de gravar.
3. **Verificação adversarial reduz ruído**, com dois portões separados —
   publicar (`existe ∧ importa`) e fechar (`+ prova`). Verificador que falha
   conta como refutação (fail-closed).
4. **Orçamento sem corte silencioso.** O que não coube é contado e dito.
5. **`accept_rate` por lente** — a métrica que rebaixa lente ruidosa.
6. **Isolamento.** A lente roda num `git worktree` descartável em `/tmp`, nunca na
   working tree do alvo.

## O que mudou por medição (não por teoria)

- **Fingerprint não ancora mais no slug da LLM.** Ela não o repete. Ancora em
  lente + arquivo + título normalizado, e ganhou a 2ª camada (`src/dedupe.mjs`).
- **`prova` deixou de ser voto de publicação.** Refutando 5/6, ele não filtrava
  nada e só rebaixava a confiança de todo mundo. Agora um achado confirmado sem
  prova convincente é **publicado e rebaixado a `proof_kind=advisory`** — some do
  caminho de fechamento automático, não do painel.

**Não prova (e a ADR diz que não deve):**

- **Controle negativo.** `proof_ref` é *coletado*, não *executado*. Promover a
  `fixed` continua exigindo humano — ADR 0087 §3 e o LOOP.md do Svalinn.
- **Sec.** Não há lente de segurança aqui, por desenho: sec é do Svalinn (ADR 0079)
  e entra federada. **Mas os 3 `critical` de RLS saíram pela lente de correção** —
  a fronteira "review vs sec" precisa de decisão explícita antes da F1.
- **Fila de re-tentativa do dedupe.** A 2ª camada é fail-open: se a chamada falha,
  o achado é tratado como novo e pode republicar um suprimido. Buraco conhecido.
- **Integração.** Nada está plugado no `apps/reviewer`. O Eitri ainda não grava.

## Mapa

| arquivo | papel |
|---|---|
| `src/lenses/index.mjs` | o registro — plugar lente nova é uma entrada aqui |
| `src/cursor.mjs` | engine Cursor API + worktree descartável + extração de JSON |
| `src/fingerprint.mjs` | identidade estável do achado entre runs |
| `src/ledger.mjs` | findings + finding_events + dedupe + triagem + accept_rate |
| `src/verify.mjs` | verificação adversarial (3 ângulos, fail-closed) |
| `src/pipeline.mjs` | fan-out → dedupe → verificar → rank → orçamento |
| `sql/0001_findings.sql` | o schema Postgres alvo (com as invariantes da ADR em `check`) |
