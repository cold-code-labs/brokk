# Design showroom — "Brokk — The Forge at Night" on claude.ai/design

`python3 build.py` → `out/` = 18 self-contained HTML cards (embedded fonts,
real forge.css-mirrored markup, dark+light stages). Synced to the Claude
Design project `4a4bf03d-ab34-4557-8ca4-4ef5eacb184f` via the DesignSync tool
(`finalize_plan → write_files → register_assets`).

The showroom is a RENDER of the system — `apps/web/app/forge.css` is the
source of truth. Changed a word there? Mirror it here and re-sync (Brilliance
Gate step 8 / SYSTEM-MAP L8). `assets/fonts-embedded.css` is generated
(Big Shoulders 600/700 + JetBrains Mono 400/600, latin, base64 woff2).
