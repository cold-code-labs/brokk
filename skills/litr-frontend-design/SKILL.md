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
| Tweak / tela já-souled | `litr` |
| Overhaul brand e/ou product · room craft · fila | **`litr-frontend-design`** |

## Uma linha

```
alma própria → DESIGN + dials → register → hot spot por sala → vocab CSS → shot → gate
```

## Contrato

1. **Soul outranks chat.** Conflito → parar e avisar.
2. **Assinatura nomeada e única** por produto. Proibido emprestar assinaturas da frota.
3. **Brand ≠ product.** Landing = *uma* assinatura memorável. Console = *hot spot de tarefa por rota*.
4. **Chrome quieto; ousadia no gesto.**
5. **Lógica byte-estável** salvo pedido explícito.
6. **Gate com shots** dark+light (ou preview real). Máx. 2–4 rodadas de crítico.
7. **Deploy frota:** push → Gjallarhorn → Coolify. Sem deploy manual pós-push.

## Modo A — site único (checklist)

```
- [ ] 1. litr-init se faltar docs/litr/; soul COM o dono (missão/metáfora/display)
- [ ] 2. DESIGN.md: 1 cena física · paleta · type law · FORBIDDEN · register
- [ ] 3. Dials Taste: brand (VARIANCE alto) / product (DENSITY + hot spot)
- [ ] 4. Mapa de salas: rota → missão → gesto → ruído → NOME do hot spot
- [ ] 5. Register certo (brand | product)
- [ ] 6. Implementar no vocab CSS do app (zero style={{}} visual)
- [ ] 7. Shot/preview dark+light · gate · SYSTEM-MAP curto se o repo usa
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
