# ADR 0028 — Product Soul: identity as a versioned, validated contract

**Status:** Accepted · **Date:** 2026-07-10 · **Scope:** Brokk first, then the CCL fleet

## Context

Every CCL app ships on the same material — Yggdrasil tokens, primitives, shell —
which made the fleet *consistent* but not *characterful*: consistency without
personality is a uniform. The one surface with a genuinely strong identity,
Brokk's Fleet board ("The Forge at Night"), got it because one design pass
reasoned mission → metaphor → palette → motion → copy, once — and that
reasoning survived only as a CSS file and a Brokk-local skill
(`docs/litr/SKILL.md` + `design-language.json`).

Three structural gaps:

1. **Identity is not an artifact.** There is no file that says who Brokk *is*
   (character, anti-traits, voice). New surfaces re-derive taste from scratch;
   agents can't be held to a contract that doesn't exist.
2. **Litr covers visuals only.** Copy — empty states, errors, button labels —
   is half of personality and had no rules at all. A strong skin with
   "Oops! Something went wrong" is still a generic app.
3. **The method is trapped in Brokk.** The pipeline and harness were written
   against Fleet specifically; nothing was reusable by Heimdall, Saga, or a
   client app.

## Decision

### 1. `soul.json` — the identity contract

Each product carries `docs/litr/soul.json`: mission (one sentence), the ONE
metaphor, personality (character + 3–5 traits + ≥2 anti-traits), **voice**
(writing principles, metaphor vocabulary, copy patterns — empty state and error
mandatory), palette discipline (tokens by meaning + at most one reserved
literal), motion budget (≤8, every entry metaphor-justified), layout scarcity,
and 3–5 named **signature moments**. Souls outrank tasks: a design/copy pass
reads the soul first and may not contradict it; changing a soul is a reviewed
act.

### 2. The system lives in Yggdrasil: `@cold-code-labs/yggdrasil-litr`

New package (`yggdrasil/packages/litr`): the JSON Schema + TS types, `litr-validate`
(schema + design lint rules: one metaphor, reserved literal, motion cap,
mandatory empty/error voice, 3–5 signatures), `litr-verify` (the both-theme
screenshot harness generalized — app supplies a small `litr.config.mjs`, the
runner owns chrome discovery and the mandatory `--virtual-time-budget`), and
`METHOD.md` (the pipeline, app-agnostic:
`mission → metaphor → personality → voice → palette → motion → layout → recipes → verify`).

Layering: **Yggdrasil = material** (what things are made of) · **soul =
identity** (who the product is) · **surfaces = the app's css/components** ·
**verify = proof**. Internals share the material and differ in soul; client
apps use the same schema with `palette.base = "client-brand"` and their own
metaphor/voice — one method, N souls.

### 3. Brokk is the reference soul

`docs/litr/soul.json` formalizes The Forge at Night and **adds the missing
voice layer**: a taciturn master smith — numbers over adjectives, verb-first
actions, no exclamation marks, the cold-hearth empty pattern, errors that name
what cracked and how to reforge it. Validated by `litr-validate`; the existing
harness (`tools/litr-verify/render.mjs`) remains Brokk's verify (it predates
and is compatible with the generalized CLI — migrating it to a
`litr.config.mjs` is optional cleanup, not required).

### 4. Agents are bound by souls

A design or copy task for Sindri/session agents is well-formed when it names a
surface + mission; the agent loads `soul.json`, runs the method, and returns
diff + both-theme crops. On conflict between task and soul, the agent stops and
surfaces it.

## Consequences

- Identity survives sessions: taste stops living in one person's (or one
  model's) head and starts living in git, validated in CI-able form.
- Copy becomes reviewable against rules, not vibes — the counterexamples in the
  soul are lint targets.
- The fleet can now be personality-audited: `litr-validate` failing = the app
  literally doesn't know who it is.
- Cost: one more artifact to keep honest. Mitigation: the validator is 150
  lines, zero-dep, and the soul only changes when the product's identity does.

## Follow-ups

- Sweep Brokk's existing UI copy against `voice.patterns` (empty/error/success
  strings) — first enforcement pass.
- Write souls for Heimdall, Hauldr panel, Saga (fleet identity map proposed in
  Edda ADR 0028).
- Publish `@cold-code-labs/yggdrasil-litr@0.1.0` to GitHub Packages alongside
  the next tokens/react release.
