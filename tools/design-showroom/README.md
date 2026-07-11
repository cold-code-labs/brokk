# Design showroom — Claude Design cards

Generates the "Brokk — The Forge at Night" cards (dark+light, fonts embedded)
for the claude.ai/design project. Source of truth is forge.css — these cards
are a RENDER of the vocabulary, regenerated after any language change.

```
python3 build.py            # writes out/<group>/<card>.html
# then push via DesignSync: finalize_plan -> write_files -> register_assets
```
