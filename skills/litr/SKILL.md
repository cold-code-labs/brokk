---
name: litr
description: >-
  Day-to-day product identity pass (CCL Litr). Use for UI/UX tweaks, elevating an
  existing surface, soul-aware copy, or "make this brilliant" when the app already
  has docs/litr/. Prefer litr-frontend-design for brand/product overhauls and room
  craft pipelines. Tokens/CSS systems live in Yggdrasil; this skill is method + gate.
---

# Litr (Brokk Skill)

Identity and craft pass for a **product checkout**. Method travels; visuals do not.
Souls outrank the chat brief (ADR 0028).

## When to use

- Tweak / elevate a screen that already has a soul
- Vocabulary, chrome, empty states, motion budget
- Not a full brand+product redesign → use **`litr-frontend-design`**

## Pipeline (short)

1. **Read the soul** — `docs/litr/soul.json` (and DESIGN lock if present). If missing, stop and ask for `litr-init` / owner metaphor — do not invent another product's signature.
2. **Mission → metaphor** — one sentence, one physical metaphor only.
3. **Tokens by meaning** — prefer the app's CSS variables / Yggdrasil token package if already wired; no raw hex sprawl; at most one accent rule.
4. **Layout scarcity** — one column system, one radius family, one border language.
5. **States** — rest, hover, live, **empty**, error. Empty = system at rest, not broken.
6. **Verify** — both themes when the app has them; screenshot or preview before claiming done.
7. **Publish** — commit + push per repo CLAUDE.md so preview updates.

## Non‑negotiable

- Never copy another CCL product's signature (eclipse, ember, selo, …).
- Logic/handlers stay byte-stable unless the user asked for behavior change.
- Prefer CSS vocabulary over `style={{}}` for visual chrome.
