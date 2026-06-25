# litr-verify

Reproducible visual-verify harness for Brokk surfaces. Screenshots the **real**
design-language CSS in both themes so a design pass can be checked, not guessed.

```bash
node tools/litr-verify/render.mjs          # all states, both themes -> out/*.png
node tools/litr-verify/render.mjs --html   # write HTML only (no chrome)
LITR_CHROME=/path/to/chrome-headless-shell node tools/litr-verify/render.mjs
```

- Reads `fleet.css` + token CSS + the forge-nav block from disk every run, so it
  always verifies current source.
- `--virtual-time-budget` is baked in and **mandatory** — entrance animations
  fade in with stagger; a bare screenshot would capture them mid-fade.
- Output (`out/`) is gitignored.

This is the Step 6 tool of the **Litr** design skill — see
[`docs/litr/SKILL.md`](../../docs/litr/SKILL.md).
