---
name: qa-review
description: >-
  Do a visual / GUI / QA review of the running app IN THE CONVERSATION by driving
  the live preview with the browser tools (mcp__playwright__*). Use when the user
  asks to see, test, QA, or GUI-review the front — "faz um QA visual", "testa o
  fluxo X", "does the app work", "review the UI". Drives the preview; does not
  edit files.
---

# QA Review (visual / GUI)

Drive the live preview and report what a **user** would see — don't read code to
guess; OBSERVE the running app.

## When

The user wants a visual/behavioral check of the running front: "faz um QA
visual", "testa o mockup 3D", "o fluxo de login", "does X work", "review the UI".
For a pure QA request, drive and report — do NOT edit files.

## The preview

The system prompt carries the preview URL (`http://forge:<port>`), and you have
the Playwright browser tools (`mcp__playwright__*`). If neither is present, say
so plainly — the QA lane isn't wired on this session (it needs the `claude-cli`
engine + a live preview), so don't pretend to have driven anything.

## Method

1. `browser_navigate` to the preview URL. If a login screen appears, click
   **"Entrar como demo"**.
2. `browser_snapshot` to READ the page (the accessibility tree) BEFORE acting —
   never click blind.
3. Exercise the flow the user named, step by step (click, type, upload, submit).
   Wait for async results (generation, navigation) before judging — poll with
   another snapshot.
4. Cover the states that break in real use: **empty**, **error**, the **happy
   path**, and one **edge** (bad input / very long text).
5. Screenshot the key moments (`browser_take_screenshot`) — a claim without a
   shot is weaker.

For a **matrix of scenarios** (Full / Targeted QA, stale catalog, Discovery),
use the **`full-qa`** skill instead of improvising a multi-flow run here.

## Report

Lead with the verdict: **does it work?** Then, concretely:

- What you did (the steps) and what you saw at each.
- What's **broken**, specifically: the element, expected vs actual, a screenshot.
- What's rough but not broken (polish notes).

Keep it to what a user experiences — no code-level speculation unless asked.

## Honesty

If a step failed because YOU couldn't find or click an element (not a real bug),
**say that** — don't report a false bug, and don't claim a success you didn't
observe. A click that did nothing IS a finding, but verify with a snapshot before
you conclude the feature is broken.
