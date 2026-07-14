# Brokk — DESIGN lock (product)

**Register:** product (console `/(app)`). Brand landing unchanged.
**Soul:** The Forge at Night (`docs/litr/soul.json`).
**Dials (Taste):** VARIANCE medium (chrome) · MOTION low · DENSITY high · hot-spot bump local.
**Passe:** verga / lintel — 2026-07-14 (topbar Hauldr-form, Brokk soul).

## Cena física (product)

Uma oficina vista de dentro: a **verga** (lintel, ~44px) é a trave do portal —
mark + **Brokk**, rooms, New, Anvil (projeto ativo), ⌘K, Bench, avatar. O
**chão** (canvas) é quase todo o frame abaixo. O calor só no trabalho: Queue →,
ember em running, Publicar. Forma de workbench topbar (Hauldr), alma Brokk —
**nunca** eclipses Svalinn.

## Assinatura de superfície (product)

| Nome | O quê | Onde |
|---|---|---|
| **Forge bar (verga)** | Topbar fixa/sticky; Anvil mostra projeto; Bench/User em pop de cima | `.forge-bar` |
| ⌘K palette | Salto para rooms/projects | `.cmdk*` |
| Workshop frame | Gutter + max-width por papel | `.forge-room` |
| Stamped nameplate | Eyebrow + title display | `.forge-head*` |
| Growing tray | Composer auto-grow | `.sindri-input` |
| Ember pulse | Único calor no trabalho vivo | `.forge-pulse` / fleet |

## FORBIDDEN (product)

- Sidebar / wall-rail de ícones (forma aposentada)
- Sidebar larga com grupos Forge / Anvil / Bench rotulados
- Title display > ~2.35rem no console
- Native `<select>` no chrome
- Emprestar eclipse (Svalinn) / ritmo Heimdall
- AI Elements / shadcn chat registry
- Card grid de marketing dentro do product shell

## Room map

| Route | Mission | Primary gesture | Noise to demote | Hot spot |
|---|---|---|---|---|
| chrome | Orientar sem comer canvas | ⌘K / rooms na verga | Fat nav labels | **forge bar** |
| `/fleet` | Ver frota + enfileirar | Queue → | Stats-first hero | fleet floor |
| `/chat` | Conversar + preview | Send | Fixed 2-line composer | sindri cockpit |
| `/projects/[id]` | Operar o board | New card | Inline drawer styles | anvil board |
| `/dashboard` | Ler vitais | (leitura) | Title oversized | vitals strip |
| `/connect` | Ligar repos | Connect N | — | connect ledger |
| `/new` | Nascer projeto | Create | — | new plate |
| `/history` | Ledger de runs | — | — | history ledger |
| `/users` | Crew + seats | Connect seat | — | crew plate |
| `/settings` | Theme + truth | Theme | — | toolbench |

## Type / palette

- Display: Big Shoulders · Body: Inter · Mono: JetBrains
- `--ember` só running / pulse / Publicar / active link inset
- Chrome quiet night registers in `forge.css` + `.forge-bar`
