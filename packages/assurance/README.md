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

## O que este PoC prova (e o que não prova)

**Prova:**

1. **Dedupe entre runs.** `fingerprint` não inclui linha — sobrevive a código que
   anda. Rodar duas vezes não republica nada.
2. **Triagem é permanente.** `wontfix`/`false_positive` viram `suppressed`: o
   achado nunca mais aparece, e a justificativa fica no `finding_events`.
3. **Verificação adversarial reduz ruído.** 3 lentes de verificação distintas
   (existe · importa · a prova é real), instruídas a refutar; sobrevive quem tiver
   ≥2 confirmações. Verificador que falha conta como refutação (fail-closed).
4. **Orçamento sem corte silencioso.** O que não coube é contado e dito.
5. **`accept_rate` por lente** — a métrica que rebaixa lente ruidosa.
6. **Isolamento.** A lente roda num `git worktree` descartável em `/tmp`, nunca na
   working tree do alvo.

**Não prova (e a ADR diz que não deve):**

- **Controle negativo.** `proof_ref` é *coletado*, não *executado*. Promover a
  `fixed` continua exigindo humano — ADR 0087 §3 e o LOOP.md do Svalinn.
- **Sec.** Não há lente de segurança aqui, por desenho: sec é do Svalinn (ADR 0079)
  e entra federada.

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
