# Brokk — DESIGN lock (product)

**Register:** product (console `/(app)`). Brand landing unchanged.
**Soul:** The Forge at Night (`docs/litr/soul.json`).
**Dials (Taste):** VARIANCE low–medium · MOTION low · DENSITY high · hot-spot bump local.
**Passe:** new face — 2026-07-14 (litr-frontend-design Modo A, product): collapsible rail,
forged anvil switcher, composer auto-grow, fleet floor queue-first, new-card plate.

## Cena física (product)

A oficina à noite vista de dentro: parede que **retrai** (sidebar → icon rail),
chão quieto (canvas), placa carimbada no alto de cada sala, e o único calor no
gesto/trabalho vivo. O cockpit Sindri (chat|preview) define o ritmo de margem —
edge-to-edge; as outras salas herdam o **mesmo alinhamento de nameplate + gutter**.

## Assinatura de superfície (product)

| Nome | O quê | Onde |
|---|---|---|
| Workshop frame | Gutter único (`--sp-5`) + max-width por papel; canvas `min-width:0` | `.forge-room` / `.ygg-main` |
| Stamped nameplate | Eyebrow mono + title display alinhado a actions na mesma baseline | `.forge-head*` |
| Ember pulse | Único calor; quieto quando a forja descansa | `.forge-pulse` / fleet |
| Collapsible rail | Icon strip (`--sidebar-w-collapsed`); chrome quieto, gain no cockpit | `.brokk-rail.is-collapsed` |
| Growing tray | Composer cresce com o prompt (cap `--sindri-input-max`); thread scrolls | `.sindri-input` |

## FORBIDDEN (product)

- Hero boxed com border + shadow na home (ainda SaaS/marketing)
- `style={{ maxWidth, padding, margin }}` de apresentação nas salas
- Title display > ~2.4rem no console (grita; competir com o work)
- Actions do masthead em `align-items: flex-end` solto (skew visual)
- Native `<select>` no chrome (anvil switcher = forged menu)
- Emprestar eclipse (Svalinn) / selo (Syn) / ritmo Heimdall
- AI Elements / shadcn chat registry (conflito Yggdrasil preflight)

## Room map

| Route | Mission | Primary gesture | Noise to demote | Hot spot |
|---|---|---|---|---|
| chrome | Orientar + liberar canvas | Collapse rail | GitHub foot, native select | collapsible rail |
| `/fleet` | Ver a frota e enfileirar trabalho | Queue → | Stats aurora-first | fleet floor |
| `/dashboard` | Ler vitais do anvil ativo | (leitura) | Title oversized | vitals strip |
| `/projects/[id]` | Operar o board | New card | Inline drawer/SSE styles | anvil board |
| `/chat` | Conversar + ver preview | Send (growing tray) | Fixed 2-line composer | sindri cockpit |
| `/connect` | Ligar repos | Connect N | maxWidth inline | connect ledger |
| `/new` | Nascer projeto | Create | — | new plate |
| `/history` | Ledger de runs | — | — | history ledger |
| `/users` | Crew + seats | Connect seat | — | crew plate |
| `/settings` | Theme + project truth | Theme | section inline margin | toolbench |

## Type / palette (product)

- Display: Big Shoulders uppercase — mastheads only, clamp ≤ 2.35rem console
- Body: Inter · Data: JetBrains Mono
- Literal `--ember` só running work / pulse / Publicar / queue hotspot rim
- Chrome: night registers já em `forge.css`
