---
name: litr-frontend-design
description: >-
  Full brand+product craft pipeline (soul → DESIGN → register → room hot spots →
  CSS vocab → shot → gate). Use for landing/console redesign, room signatures,
  frota craft, or "playbook" overhauls. Companion to skill `litr` (day-to-day).
  Never copy another product's signature.
---

# Litr Frontend Design

Craft pipeline: **method travels; visuals do not.** Pacote verde mental: Litr ×
Taste dials × anti-generic frontend-design floor × Impeccable register
(brand|product). Tokens/UI packages stay in Yggdrasil; **this Brokk skill** is
the operating playbook for agents in Chat.

## Quando usar

| Pedido | Skill |
|---|---|
| **Hero / Iniciar protótipo** | **Modo Hero** abaixo (paint primeiro) — *não* o Modo A completo |
| Tweak / tela já-souled | `litr` |
| Overhaul brand e/ou product · room craft · fila | **`litr-frontend-design`** Modo A |
| Pós-Hero (G já verde) | Modo A / profundidade |

## Uma linha

```
Hero: paint ≤3 superfícies → gate G (shot live) → litr leve
Profundidade: alma → DESIGN + dials → rooms → vocab → shot → gate
```

## Contrato

1. **Gate G outranks docs.** Preview que perde para um one-shot limpo = fail, mesmo com DESIGN.md perfeito.
2. **Soul outranks chat** *depois* do primeiro frame bom. No Hero, metáfora curta alinhada ao que já está na tela — não bloquear paint por soul committee.
3. **Assinatura nomeada e única** por produto. Proibido emprestar assinaturas da frota.
4. **Brand ≠ product.** Landing = *uma* assinatura memorável. Console = *hot spot de tarefa por rota*.
5. **Chrome quieto; ousadia no gesto.**
6. **Lógica byte-estável** salvo pedido explícito.
7. **Gate com shots** no preview **live** (não só markdown). Máx. 2–4 rodadas de crítico.
8. **Deploy frota:** push → Gjallarhorn → Coolify. Sem deploy manual pós-push.

## Modo Hero — Iniciar / pack (checklist)

Folha em branco. Premiar simplicidade vista. Runbook: `var/docs/fluxo-cliente-projeto-prototipo.md` §5–6.

```
- [ ] 1. ≤3 superfícies: vitrine + 1 gesto forte + no máx. 1 lista
- [ ] 2. Pedidos fora disso → deferred[] (não pintar “porque a Saga listou”)
- [ ] 3. Implementar UI crível (tipografia expressa, atmosfera, zero CSS de outro app)
- [ ] 4. Push → preview live → screenshot → **gate G**
- [ ] 5. G fail → redesenhar; NÃO abrir litr-init / Discover / Full Audit
- [ ] 6. G ok → `litr` leve (soul curta) + `user-data-flow targeted` só no happy path
```

Anti-Hero: room map completo, Full Audit, 9 rotas, `#critical` gambiarra de iframe, herdar chrome da frota.

## Modo A — site único / profundidade (checklist)

Só com **G verde** ou pedido explícito de overhaul (não é o default do Iniciar).

```
- [ ] 1. litr-init se faltar docs/litr/; soul COM o dono (missão/metáfora/display)
- [ ] 2. DESIGN.md: 1 cena física · paleta · type law · FORBIDDEN · register
- [ ] 3. Dials Taste: brand (VARIANCE alto) / product (DENSITY + hot spot)
- [ ] 4. Mapa de salas: rota → missão → gesto → ruído → NOME do hot spot
- [ ] 4b. **user-data-flow** nas salas entity do escopo (Novo · Editar · Arquivar · empty CTA)
- [ ] 5. Register certo (brand | product)
- [ ] 6. Implementar no vocab CSS do app (zero style={{}} visual)
- [ ] 7. Shot/preview live · gate · SYSTEM-MAP curto se o repo usa
- [ ] 8. Commit + push (preview / Gjallarhorn)
```

## Modo B — esteira

Fila `[{repo, surfaces, owner?}]` — um checkout por item; **não** reutilizar
assinatura/CSS names entre itens. Falha num site não cancela a fila.

## Brand vs product

**Brand (landing):** uma assinatura física; resto quieto; VARIANCE alto.

**Product (console):** chrome restrained; por rota: missão + gesto + ruído a
demover + **nome do hot spot**; densificar; literal reservado só onde a soul manda.

## Fases (emitir progresso)

Ao avançar, diga a fase em uma linha: `soul` · `design` · `register` · `rooms` ·
`css` · `shot` · `gate` · `publish`.

## Artefatos no checkout

Preferir gravar no repo alvo: `docs/litr/soul.json`, DESIGN lock, notas de room
map. O Chat acompanha evolução por esses arquivos + commits — não inventar um
segundo sistema de verdade.
