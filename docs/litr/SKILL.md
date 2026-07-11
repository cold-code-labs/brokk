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

> **ADR 0028 (2026-07-10):** Litr was promoted fleet-wide as the **product-soul
> system** (`@cold-code-labs/yggdrasil-litr` in the Yggdrasil repo: soul schema,
> `litr-validate`, generalized `litr-verify`, METHOD.md). Brokk's identity —
> including the **voice/copy layer** this skill didn't cover — is now the
> contract in [`soul.json`](./soul.json) (validated: `litr-validate
> docs/litr/soul.json`). **Read the soul before any design or copy pass; souls
> outrank tasks.** This SKILL.md remains the Brokk-local pipeline; the
> app-agnostic version is the package's METHOD.md.

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

## v2 — the three layers that turn a system into a world (2026-07-11)

v1 of this skill produced a *correct* app that read dead: uniform 1px boxes,
one 8px warm dot, 0.85rem grey everywhere. The founder's verdict: "rígido, sem
alma, sem cor, widgets padrão". The fix was not a library — it was three layers
of art direction, now part of the language (`forge.css` v2, soul `typography`):

1. **The voice (type).** `--font-display` (Big Shoulders, condensed industrial
   caps) carries every masthead, numeral, wordmark and empty-state title. Mono
   marks machine truth (eyebrows, table heads, labels, metadata). Body stays
   Inter. A surface whose biggest type is 1rem Inter has no voice.
2. **The night (atmosphere).** The shell has its own dark register (char-black,
   not corporate navy), forge-light rising from below the frame, a cold aurora
   at the top, film grain on everything. Empty space must read as *night air*.
3. **The heat.** `--ember` has a ramp (`--heat`: ember→gold) and real presence:
   molten rails, burning numerals, banked coals in cold hearths. Reservation
   unchanged — running work only — but when it appears, it *burns*.

## The Brilliance Gate — the mandatory critique pass

**Every change that touches a Brokk surface ends with this gate on the REAL
rendered app** (runbook: memory `litr-real-render-walkthrough` — build on the
surtr lane, screenshot 1440×900, dark AND light, populated AND empty). The mock
harness checks the vocabulary; the gate checks the composition. A surface that
was not walked is not done. Nobody should have to prompt "fix this screen" —
the gate exists so the critique happens *before* ship, systematically.

Read each screenshot as a skeptical user and answer ALL of these. One "no" =
not done:

1. **Nameplate** — mono eyebrow with the hot tick + display-caps title present
   and correctly worded (the room of the smithy this surface is)?
2. **Night floor** — atmosphere visible; does empty space read as air, or as a
   dead void begging for content?
3. **Type law** — is every string ≥1rem in the display face or deliberately
   body? Is ALL machine truth (IDs, counts, timestamps, column heads, roles)
   in mono? Any default-sans heading = fail.
4. **Heat law** — ember/heat on every piece of live work, and NOWHERE else?
   Empty hearths banked (faint warmth), never grey-dead?
5. **No naked widget** — zero browser-default or library-default controls:
   selects, checkboxes, buttons, pills, scrollbars, file inputs. Every control
   speaks the vocabulary (forge-bar, forged buttons, forge-chips, brokk-switch).
6. **No box-in-box** — bordered panels never nest; lists are ledgers/tallies
   (hairline rows inside ONE surface), never stacks of bordered cards.
7. **No inline composition** — presentation lives in the vocabulary files
   (forge.css / fleet.css / globals.css). `style={{}}` for anything beyond a
   one-off gap/flex is a missing word in the vocabulary: add the word.
8. **Both themes** — light is a wash, not a stain (glows halved); dark is the
   night, not navy. Contrast holds in both.
9. **Both states** — populated AND empty verified. Populated hides in the empty
   shot and vice-versa.
10. **The two-second read** — does the surface answer its mission instantly
    (what is burning / what do I do next), with the primary action exactly once?

Deliverable of any design pass: the diff + the gate screenshots that prove it.

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
