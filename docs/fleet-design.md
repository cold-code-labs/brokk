# Fleet — "The Forge at Night" (design notes)

The Brokk home / Fleet board is the reference surface for the platform's visual
quality. It's composed **entirely on Yggdrasil tokens** so it stays on-brand and
flips light/dark for free — no shadcn, no extra component library. This doc is
the design language so future surfaces (and the `Litr` design skill) can extend
it coherently.

## Constraints

- **Tailwind preflight is OFF** (`corePlugins.preflight = false`). There is no
  global base reset, so:
  - native `<a>` keeps the browser underline — interactive links rendered as
    buttons need `text-decoration: none` explicitly (`.fleet a` handles it).
  - never use an underline to "highlight" text — use accent **color** + weight.
- **Dark-native** (`defaultTheme: "dark"`). Token themes: `:root` is the light
  base, `.dark` overrides. Everything must read in both.
- All color/space comes from Yggdrasil CSS vars (`--bg`, `--panel`, `--accent`,
  `--line`, `--fg*`, `--radius*`, `--shadow-*`). The one literal we add is
  `--ember` (warm forge signal) — and only for *running* work.

## Vocabulary

- **Cold sky-blue** (`--accent`) = structure, links, live/info metrics.
- **Warm ember** (`--ember`) = the single warm signal, reserved for work in the
  fire (running tasks). Used sparingly: the forge pulse, running card rails,
  the running queue row. Overusing it breaks the metaphor.
- **Surface tiers**: `--panel` cards on `--bg`, `--panel-2` on hover, glass
  (`color-mix(--panel 72%, transparent)` + `backdrop-filter`) for floating
  controls (stats, composer).
- **One radius family** (`--radius`, `--radius-lg`, `--radius-sm`) and one
  border color (`--line`) everywhere → cohesion. Don't introduce new borders.
- **Motion is a garnish, not the message**: entrance rises, a slow wordmark
  sheen, an ember pulse, a running beam. Everything degrades under
  `prefers-reduced-motion: reduce`.

## Files

- `apps/web/app/fleet.css` — the design language (all classes prefixed `fleet-`).
- `apps/web/components/FleetView.tsx` — **pure, props-driven** render. No data
  fetching; renders identically under live data or a screenshot harness. This is
  the surface a design pass (human or `Litr`) edits.
- `apps/web/components/Fleet.tsx` — owns data fetching/polling, passes props.

## Visual-verify loop (what `Litr` Phase 4 automates)

Render the real CSS + `FleetView` markup with sample data and screenshot it in
both themes with headless Chrome:

```
chrome-headless-shell --headless --no-sandbox --hide-scrollbars \
  --window-size=1280,1700 --virtual-time-budget=4000 \
  --screenshot=out.png file://mock.html
```

`--virtual-time-budget` is **mandatory** — entrance animations use
`animation: … both` with stagger delays, so a bare screenshot captures elements
mid-fade at `opacity: 0` and reads as "missing". Advance virtual time past the
longest entrance before capturing.
