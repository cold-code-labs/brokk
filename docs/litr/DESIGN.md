# Brokk — DESIGN lock (product)

**Register:** product (console `/(app)`). Brand landing unchanged.
**Soul:** The Forge at Night (`docs/litr/soul.json`).
**Dials (Taste):** VARIANCE medium (chrome) · MOTION low · DENSITY high · hot-spot bump local.
**Passe:** remolho elite — 2026-07-14 (litr-frontend-design Modo A, product).

## Cena física (product)

Uma oficina vista de dentro: a **parede** (wall rail, 3.5rem) só segura as
ferramentas — mark, rooms, bigorna, bancada. O chão (canvas) é quase todo o
frame. O calor só no trabalho: Queue →, ember em running, Publicar. Forma de
workbench (v0/Lovable), alma Brokk — **nunca** eclipses Svalinn.

## Assinatura de superfície (product)

| Nome | O quê | Onde |
|---|---|---|
| **Wall rail** | Faixa de ícones permanente; tip à direita; Bench/Anvil em flyout | `.wall-rail` |
| ⌘K palette | Salto para rooms/projects sem sidebar gorda | `.cmdk*` |
| Workshop frame | Gutter + max-width por papel | `.forge-room` |
| Stamped nameplate | Eyebrow + title display | `.forge-head*` |
| Growing tray | Composer auto-grow | `.sindri-input` |
| Ember pulse | Único calor no trabalho vivo | `.forge-pulse` / fleet |

## FORBIDDEN (product)

- Sidebar larga com grupos Forge / Anvil / Bench rotulados
- Title display > ~2.35rem no console
- Native `<select>` no chrome
- Emprestar eclipse (Svalinn) / ritmo Heimdall
- AI Elements / shadcn chat registry
- Card grid de marketing dentro do product shell

## Room map

| Route | Mission | Primary gesture | Noise to demote | Hot spot |
|---|---|---|---|---|
| chrome | Orientar sem comer canvas | ⌘K / wall icons | Fat nav labels | **wall rail** |
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
- `--ember` só running / pulse / Publicar / active rail inset
- Chrome quiet night registers in `forge.css` + `.wall-rail`
