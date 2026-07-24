---
name: user-data-flow
description: >-
  Spec, full audit, and gate for user-facing data lifecycles (CRUD + archive +
  empty CTA). Discovery builds a versioned room/entity catalog; Audit scans all
  or targeted rooms (static + optional live preview). Use for "full data flow",
  "auditar CRUD", "varre as telas", "cadê adicionar", entity lifecycle, arquivar,
  excluir, fluxo de dados, or Hero maturity checks. Prefer Full over one-room
  when covering more than one entity screen.
---

# User Data Flow (Spec → Discover → Audit)

Lista sem verbo = vitrine. Dois modos:

| Modo | Quando |
|---|---|
| **Spec / Fix** | Implementar ou completar **uma** sala entity |
| **Full / Targeted Audit** | Varrer o app como o `full-qa` — catálogo + veredito por sala |

Não editar produto no Audit salvo o usuário pedir fixes depois do report.

## Uma linha

```
Discover catálogo → Audit (static ± live) → report → Fix só se pedido
```

---

## Catálogo (fonte da verdade)

No checkout:

`.brokk/data-flow/catalog.json`

Espelho humano (sempre atualizar junto): `docs/litr/data-flow.md`

```json
{
  "version": 1,
  "fingerprint": "<hash routes+rooms+pedidos>",
  "discoveredAt": "<iso>",
  "summary": "one paragraph",
  "rooms": [
    {
      "id": "representantes",
      "route": "/representantes",
      "kind": "entity",
      "entity": "Representante",
      "priority": "p0",
      "required": ["create", "read", "edit", "archive", "empty_cta"],
      "linksTo": ["/funil"],
      "notes": ""
    }
  ]
}
```

**Kinds → required verbs**

| kind | required |
|---|---|
| `entity` | create, read, edit, archive, empty_cta |
| `pipeline` | move_stage \| create_card (pelo menos um), read |
| `tool` | primary_action; `save_as_entity` se o fluxo cria registro |
| `ledger` | status_transition (ou explícito seed-only) |
| `study` | read + badge/copy “estudo” (CRUD = **n/a**, não fail) |
| `brand` | primary CTA de conversão |

Se a UI/chat já colou um catálogo, use-o — não reinvente.

---

## Phase A — Discovery

Quando: “descobrir data-flow”, catálogo ausente, ou **stale**.

1. Ler `docs/litr/rooms.md`, `docs/litr/pedidos.md`, `docs/litr/data-flow.md`,
   rotas (`App.tsx` / router), nav do shell, `features.json` se houver.
2. Classificar cada rota (`kind`) + entidade dona.
3. Regra **cita → dona**: se `/funil` filtra por rep e não existe sala
   representantes → gap `missing_owner` no catálogo.
4. Fingerprint = hash estável de rotas + kinds + required[] (kebab ids estáveis).
5. Escrever `.brokk/data-flow/catalog.json` **e** espelhar tabela em
   `docs/litr/data-flow.md`.
6. Report: contagem por kind, lista p0, fingerprint mudou? sim/não.

Discovery **não** implementa CRUD — só mapeia.

**Stale:** rotas/rooms mudaram e o fingerprint diverge → avisar e re-Discover
antes do Full Audit (mesmo espírito do `full-qa`).

---

## Phase B — Audit (varredura)

Precisa do catálogo fresco. Modos:

- **Full** — todas as rooms, p0 primeiro, depois p1.
- **Targeted** — só ids/rotas/módulos nomeados na mensagem.

### B1 — Static (sempre)

Por room no catálogo:

1. Abrir a page/component da rota.
2. Checar evidência de cada `required[]`:

| verb | Evidência (código ou copy) |
|---|---|
| create | botão/link “Novo/Adicionar/+ …” ou form de create |
| edit | “Editar” / form de update por item |
| archive | “Arquivar” (não só Excluir hard) |
| empty_cta | empty state com o mesmo create |
| move_stage / create_card | controle de estágio ou + card |
| save_as_entity | “Salvar proposta/orçamento” que persiste |
| status_transition | muda status visível |
| study badge | “estudo” / read-only explícito |

3. Opcional: rodar o helper da skill:

```bash
node skills/user-data-flow/scripts/audit-static.mjs .
# ou, no checkout do produto:
node path/to/user-data-flow/scripts/audit-static.mjs .
```

(Se o script não estiver no checkout, copie de `brokk/skills/user-data-flow/scripts/`
ou faça o grep manual equivalente.)

### B2 — Live (quando houver preview + browser tools)

**Obrigatório no aceite de piloto** se o preview existir. Sem `__bk` → 403;
mint com `scripts/mint-preview-url.mjs` + Ice Vault `BROKK_PREVIEW_KEY`
(ver runbook Var §9).

Espírito do `qa-review` / `full-qa` Execution:

1. Navigate com URL mintada → cookie `__bk` → login demo.
2. Snapshot: CTA create visível sem scroll hunt?
3. Happy path mínimo entity: criar → editar → arquivar (se required).
4. Screenshot só em fail (e 1 shot de prova no gate).
5. Honesty: não achar o botão = `blocked` (agente), não `fail` de produto.

### Veredito por room

`pass` | `fail` | `deferred` | `n/a` | `blocked`

- `deferred` = gap **consciente** já anotado em data-flow.md (ok no Hero se
  explícito; ainda aparece no report).
- `n/a` = study/brand sem aquele verbo.
- `fail` = required ausente e **não** deferred.

### Report (obrigatório)

Escrever `.brokk/data-flow/last-report.md` e responder no chat:

**Lead:** `X pass · Y fail · Z deferred · W blocked` (stale? sim/não)

Tabela: `id · kind · verdict · missing[] · note`

Expandir só fails. Sem especulação de código salvo pedido de Fix.

---

## Phase C — Fix (só se pedido)

Para cada `fail` (p0 primeiro):

1. Implementar verbos mínimos do kind (mock/local state ok).
2. Atualizar `docs/litr/data-flow.md` + catalog.
3. Re-auditar a room (static; live se preview up).
4. Não expandir pra BaaS.

---

## Spec rápida (uma sala)

Checklist entity:

```
- [ ] Primary CTA "+ Novo …" no head
- [ ] Empty state com o mesmo CTA
- [ ] Item: editar + arquivar
- [ ] Campos do brief (não form genérico)
- [ ] Persistência declarada (useState / localStorage / mock)
- [ ] Vínculo / deep-link pra sala que cita
- [ ] Arquivar ≠ Excluir (copy pt-BR)
```

**Delete hard** no Hero: default não.

## Anti-padrões

- Roster read-only sem gesto de cadastro
- CRUD só no chat Sindri
- Omitir botão em vez de marcar `deferred`
- Inventar BaaS só pra ter POST

## Brokk / one-shot

Ordem no forge:

1. Litr room map  
2. **user-data-flow Discover** → catalog  
3. Hero paint + **Full Audit** nas entity do hero_set  
4. fails → cards de profundidade ou Fix no mesmo run se o brief mandar  

Chip mental: `/user-data-flow full` · `/user-data-flow discover` ·
`/user-data-flow targeted representantes,propostas`
