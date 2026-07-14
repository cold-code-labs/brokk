# Brokk — DESIGN lock (product)

**Register:** product (console `/(app)`). Brand landing unchanged.
**Soul:** The Forge at Night (`docs/litr/soul.json`).
**Dials (Taste):** VARIANCE low–medium · MOTION low · DENSITY high · hot-spot bump local.
**Passe:** workshop frame — 2026-07-14 (litr-frontend-design Modo A, product).

## Cena física (product)

A oficina à noite vista de dentro: parede escura (sidebar), chão quieto (canvas),
uma placa carimbada no alto de cada sala, e o único calor no gesto/trabalho
vivo. O cockpit Sindri (chat|preview) define o ritmo de margem — edge-to-edge;
as outras salas herdam o **mesmo alinhamento de nameplate + gutter**, sem se
fazerem de landing.

## Assinatura de superfície (product)

| Nome | O quê | Onde |
|---|---|---|
| Workshop frame | Gutter único (`--sp-5`) + max-width por papel; canvas `min-width:0` | `.forge-room` / `.ygg-main` |
| Stamped nameplate | Eyebrow mono + title display alinhado a actions na mesma baseline | `.forge-head*` |
| Ember pulse | Único calor; quieto quando a forja descansa | `.forge-pulse` / fleet |

## FORBIDDEN (product)

- Hero boxed com border + shadow na home (ainda SaaS/marketing)
- `style={{ maxWidth, padding, margin }}` de apresentação nas salas
- Title display > ~2.4rem no console (grita; competir com o work)
- Actions do masthead em `align-items: flex-end` solto (skew visual)
- Emprestar eclipse (Svalinn) / selo (Syn) / ritmo Heimdall

## Room map

| Route | Mission | Primary gesture | Noise to demote | Hot spot |
|---|---|---|---|---|
| `/fleet` | Ver a frota e enfileirar trabalho | Queue → | Hero card, aurora forte | fleet floor |
| `/dashboard` | Ler vitais do anvil ativo | (leitura) | Title oversized | vitals strip |
| `/projects/[id]` | Operar o board | New card | Inline toolbar styles | anvil board |
| `/chat` | Conversar + ver preview | Send | (já referência) | sindri cockpit |
| `/connect` | Ligar repos | Connect N | maxWidth inline | connect ledger |
| `/new` | Nascer projeto | Create | — | new plate |
| `/history` | Ledger de runs | — | — | history ledger |
| `/users` | Crew + seats | Connect seat | — | crew plate |
| `/settings` | Theme + project truth | Theme | section inline margin | toolbench |

## Type / palette (product)

- Display: Big Shoulders uppercase — mastheads only, clamp ≤ 2.35rem console
- Body: Inter · Data: JetBrains Mono
- Literal `--ember` só running work / pulse / Publicar
- Chrome: night registers já em `forge.css`
