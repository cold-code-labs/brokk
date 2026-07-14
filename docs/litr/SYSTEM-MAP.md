# The System Map — how a CCL design system gets built, end to end

> The complete development process of a product design system at Cold Code
> Labs, using Brokk ("The Forge at Night") as the reference implementation.
> This is the map from *nothing* to *every pixel accounted for* — foundations,
> elements, components, patterns, pages — plus the two loops that keep it
> alive (the Brilliance Gate) and visible (the Claude Design showroom).
> When another product (Heimdall, Saga, Hauldr…) builds its system, it walks
> THIS map with its own soul.

## The layers — each one only uses what the layer above decided

```
L0  SOUL        docs/litr/soul.json — mission · metaphor · personality · voice
L1  TOKENS      Yggdrasil base + the product's night/paper registers + literal(s)
L2  FOUNDATIONS type · color · space · radius · atmosphere · motion budget
L3  ELEMENTS    the atoms: button, chip, badge, field, tick, rule, plate
L4  COMPONENTS  the molecules: masthead, vitals, ledger, tally, bar, seg,
                toast, dialog, empty state, identity pod
L5  PATTERNS    the organisms: sidebar/chrome, kanban board, chat cockpit,
                data table, form section, notification stack
L6  PAGES       the rooms: each surface = one mission, composed ONLY of L2–L5
L7  GATE        the Brilliance Gate — 10-point critique on the REAL render
L8  SHOWROOM    Claude Design project — every word of the language as a
                browsable dark+light card (DesignSync)
```

Two hard rules make the layers real:

1. **Every layer is a vocabulary, not a suggestion.** If a surface needs
   presentation that no class provides, the vocabulary is missing a word —
   the word gets added to the layer file (forge.css / globals.css), never
   inlined at the call site.
2. **Souls outrank tasks.** A change that conflicts with soul.json stops and
   escalates; the soul changes first or the change doesn't ship.

## The process — from zero to shipped, for any product

1. **Write the soul** (L0). `litr-validate` green. No pixels before this.
2. **Derive the registers** (L1). The product's dark ("the night") and light
   ("the paper") value sets over the Yggdrasil token contract, plus at most
   one literal with a written reservation (Brokk: `--ember`/`--heat`).
3. **Declare the voice in type** (L2). A display face that is THIS product's
   (never another product's), body, mono. Typography is in the soul schema —
   a soul without a display face renders generic.
4. **Forge the vocabulary bottom-up** (L3→L5). Elements first, then
   components, then patterns. Every state designed: rest, hover, active,
   live, empty, error, loading. Empty = the system at rest.
5. **Compose the pages** (L6). One mission per surface; the two-second read;
   the primary action exactly once.
6. **Walk the gate** (L7). Real render, both themes, both states, all 10
   checks. One "no" = not done.
7. **Sync the showroom** (L8). Regenerate the Claude Design cards for every
   word that changed. The showroom is the review surface for humans — if the
   founder points at a card, the fix lands in the layer file and re-syncs.
8. **Repeat 4–7 forever.** The system is never "done"; it converges.

## The inventory — Brokk's coverage today

Status: ✓ forged and adopted · ◐ forged, adoption incomplete · ✗ missing.
"Where" names the layer file that owns the word.

### L2 Foundations
| Word | Status | Where |
|---|---|---|
| Type voice (display/body/mono + rules) | ✓ | soul.json `typography`, layout.tsx fonts |
| Night + paper registers | ✓ | forge.css `.dark .ygg-shell` / tokens |
| The heat ramp (`--ember`/`--gold`/`--heat`) | ✓ | forge.css `:root` |
| Atmosphere (floor glow + aurora + grain) | ✓ | forge.css `.ygg-shell::before/::after` |
| Motion budget (≤6, all reduced-motion safe) | ✓ | soul.json `motion` |
| Space/radius scale | ✓ | Yggdrasil tokens (`--radius*`) |

### L3 Elements
| Word | Status | Where |
|---|---|---|
| Forged primary button | ✓ | globals `[class*="bg-primary"]`, forge-bar-send |
| Iron ghost / outline button | ✓ | globals `[class*="border-input"]` |
| Chip (default / is-ember / is-accent) | ✓ | forge.css `.forge-chip` |
| Etched mono badge (status pills) | ✓ | globals `.ygg-badge` |
| Field (mono label + input) | ✓ | forge.css `.forge-field` |
| Checkbox / radio (accent) | ✓ | globals input[type=checkbox/radio] |
| Eyebrow + hot tick | ✓ | forge.css `.forge-eyebrow` |
| Cooling rule / section rule | ✓ | `.forge-head-rule` / `.forge-h-rule` |
| Crumb (mono breadcrumb) | ✓ | forge.css `.forge-crumb` |
| Identity plate (initials) | ✓ | globals `.brokk-user-plate` |
| Skeleton (metal heating shimmer) | ✓ | forge.css `.forge-skeleton` |
| Tooltip | ✓ | `[data-tip]` etched mono plate (CSS-only); rich/positioned tips promote to component later |

### L4 Components
| Word | Status | Where |
|---|---|---|
| Masthead / stamped nameplate | ✓ | `.forge-head*` (+ `.forge-head-copy` / `.forge-head-actions` baseline) |
| Workshop room frame | ✓ | `.forge-room` + `.ygg-main` gutter; Sindri stays edge-to-edge |
| Collapsible rail | ✓ | `.brokk-rail` / `.is-collapsed` + `--sidebar-w-collapsed` (Brokk-local) |
| Anvil switcher (forged menu) | ✓ | `.brokk-switch*` + ComposerMenu (no native select) |
| Growing composer tray | ✓ | `.sindri-input` auto-grow + `--sindri-input-max` |
| Section heading | ✓ | `.forge-h*` |
| Vitals strip | ✓ | `.forge-tiles/tile` |
| Ledger (+ running row, table-hosted) | ✓ | `.forge-ledger/row` |
| Tally (built/ore) | ✓ | `.forge-tally` |
| Command-bar | ✓ | `.forge-bar` |
| Segmented control | ✓ | `.forge-seg` |
| Ember pulse | ✓ | `.forge-pulse` |
| Cold hearth (empty state) | ✓ | `.forge-empty` |
| Banner (info/ok/err) | ✓ | globals `.ygg-banner` restyle |
| Toast — quiet confirmation stack | ✓ | `.forge-toast*` + Toaster.tsx; adopted: Discovery, Board (queue/done), Connect, Crew, Mímir (save) |
| Dialog / modal plate | ✓ | forge.css `.forge-dialog*` + New card (`is-form` / owner picks) |
| Panel card | ✓ | `.forge-panel` |
| Identity pod | ✓ | globals `.brokk-user` |

### L5 Patterns
| Word | Status | Where |
|---|---|---|
| Sidebar chrome (rail, groups, active, switcher) | ✓ | globals + shell.css |
| Kanban board (anvil, columns, snap-scroll) | ✓ | `.anvil-*` incl. `.anvil-card*` (selected/running states, act buttons, PR link); drawer stays inline by design |
| Chat cockpit (bubbles, composer, chips) | ✓ | globals `.sindri-*` (bespoke layer, in-language) |
| Data table | ✓ | `.forge-ledger table` (History) |
| Form section | ◐ | forge-field exists; no multi-field surface yet |
| Notification stack | ✓ | `.forge-toasts` (top-right, stacking) |
| Route loading state | ✓ | `app/(app)/loading.tsx` skeleton (nav never feels dead) |

### L6 Pages (each = one mission; new-face pass 2026-07-14)
Fleet ✓ (queue-first hot spot) · Dashboard ✓ · Board ✓ (forge-dialog new card) ·
Discovery ✓ · Sindri ✓ (growing tray + rail room) · Mímir ✓ ·
Connect ✓ · History ✓ · Crew ✓ · Settings ✓ · Landing ✓ (own art, kept).

### Known debt (next rounds)
1. Board drawer/detail still inline styles (convert when touching Detail).
2. Sindri live-session surfaces (thread, Studio, FileViewer) gate-walked with a real open session.
3. Populated-board gate shot once real cards exist on any project.
4. Gate A/B dark+light shots for this new-face pass on the real preview (auth).
5. Promote collapsible rail into Yggdrasil NavSidebar when a second app needs it.
6. Fleet-wide: extract the product-agnostic halves of this map into
   `@cold-code-labs/yggdrasil-litr` METHOD.md when Heimdall builds its soul.

## The showroom — Claude Design sync

Project **"Brokk — The Forge at Night"** (claude.ai/design) mirrors every word
as a self-contained dark+light card (fonts embedded base64, real markup).
Groups: Brand · Type · Colors · Elements · Components · Patterns · States ·
Pages. Regenerate + push after any vocabulary change:

```
python3 <bundle>/build.py          # assembles cards from the vocabulary
DesignSync finalize_plan → write_files → register_assets
```

The showroom is a *render* of the system, never the source — forge.css is the
source. If a card and the app disagree, the app wins and the card regenerates.
