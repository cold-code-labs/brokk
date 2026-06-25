# Litr — the Brokk design skill

> Litr is the dwarf who fans Brokk's forge. This skill is how an agent turns a
> **product mission** into an on-brand, verifiable **UI** for Brokk surfaces —
> the same way the Fleet board was forged. It is written to be executed by a
> coding agent (Sonnet/Opus) or followed by a human.

**The whole skill in one line:** `mission -> metaphor -> palette+motion -> layout -> ui/ux recipes -> verify in both themes`. Each arrow is a constraint, not a suggestion: a later step may only use what an earlier step decided.

The machine-readable knowledge this skill reasons over lives in
[`design-language.json`](./design-language.json). The worked reference surface
is the Fleet board ([`fleet-design.md`](../fleet-design.md),
`apps/web/app/fleet.css`, `apps/web/components/FleetView.tsx`). Read those before
forging a new surface.

---

## When to run

- Building a new Brokk surface (a page, a panel, a board).
- Elevating an existing surface to the Fleet bar ("make this brilliant", "extract the juice").
- Reviewing a surface for cohesion with the rest of the app.

## How to run — the pipeline

Work the steps in order. **Write down the output of each step** (a comment block
at the top of the surface's CSS is ideal) so the next step — and the next agent —
can cite it. The authoritative version of each step, with rules and the Fleet
example, is `design-language.json -> method.steps`.

1. **Mission -> Metaphor.** One sentence: who looks at this surface and what do
   they need *first*? Then name the *one* physical metaphor latent in the brand
   (CCL = a cold mountain; Brokk = a forge). The metaphor generates every later
   constraint. One metaphor only — two reads as noise.

2. **Metaphor -> Palette.** Map the metaphor onto Yggdrasil tokens *by meaning*.
   Cold/structural = `--accent`. Reserve at most **one** warm signal (`--ember`)
   with an explicit rule for when it may appear ("running work only"). All color
   is tokens; flips light/dark for free.

3. **Metaphor -> Motion budget.** List only motions the metaphor literally
   justifies (forge pulse, aurora drift, running beam). Cap it (~6). Every motion
   degrades to static under `prefers-reduced-motion`. No meaning -> cut it.

4. **Mission -> Layout.** Order regions by what the operator needs first. Lock
   **one** column system, **one** max-width, **one** radius family, **one**
   border color. Cohesion = scarcity; reuse surface tiers instead of inventing.

5. **Layout -> UI/UX recipes.** Build each region from tokens + the metaphor
   vocabulary only. Design *every state*: rest, hover, active, live, **empty**,
   error. Empty = "the system at rest" (same material, one calm mark, one clear
   action), never "broken". The nav/chrome shares the canvas's hover/blend
   vocabulary so the app reads as one material. Reuse the recipes in
   `design-language.json -> recipes`.

6. **Verify in both themes.** Run the harness, read the crops, fix, repeat:
   ```
   node tools/litr-verify/render.mjs
   # -> tools/litr-verify/out/<state>-<theme>.png  (populated|empty x dark|light)
   ```
   `--virtual-time-budget` is already baked in and is **mandatory** — entrance
   animations use `animation: ... both` with stagger, so a bare screenshot
   captures `opacity:0` mid-fade and reads as "missing". Never ship a surface
   verified in only one theme.

## Hard constraints (the easy ways to break the language)

- **Preflight is OFF** (no global reset). A link rendered as a button keeps the
  browser underline — set `text-decoration:none` (e.g. `.fleet a`). Emphasis is
  accent **color + weight**, never an underline.
- **One warm signal.** `--ember` means running work and nothing else. Decorative
  ember breaks the metaphor.
- **No new primitives.** Don't add a second border color, radius family, or
  shadow scale. Tint an existing surface instead.
- **Pure render.** The design surface is a props-driven component with no data
  fetching, so it renders identically live or under the harness.

## Keeping the loop honest

The harness markup in `tools/litr-verify/render.mjs` mirrors `FleetView`'s
canonical states by hand. When you change a surface's structure, update the
harness `SAMPLES` in the **same commit** — otherwise the verify loop drifts from
reality.

## For the planner / orchestrator

A design task is well-formed for an agent when the prompt names the surface and
its mission. The agent then: reads `design-language.json` + the worked example,
runs the 6-step pipeline, edits the surface CSS/component, runs the harness, and
returns the crops as evidence. The deliverable is **the diff + both-theme
screenshots that prove it reads**, not prose.
