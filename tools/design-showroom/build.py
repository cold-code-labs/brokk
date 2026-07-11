#!/usr/bin/env python3
"""Assemble the Brokk 'Forge at Night' design-system cards for Claude Design.
Each card is a self-contained HTML file: embedded fonts + the forge vocabulary
(mirrored from apps/web/app/forge.css) + real markup, staged dark AND light."""
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
FONTS = open(os.path.join(ROOT, "assets/fonts-embedded.css")).read()

DS_CSS = """
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: Inter, system-ui, -apple-system, sans-serif; background: #10131a; padding: 14px; display: grid; gap: 14px; }
.stage { position: relative; isolation: isolate; overflow: hidden; border-radius: 12px; padding: 26px 28px 30px; background: var(--bg); color: var(--fg); }
.stage::before { content: ""; position: absolute; inset: 0; z-index: -2; pointer-events: none; background:
  radial-gradient(60rem 30rem at 78% 118%, color-mix(in srgb, var(--ember) 7%, transparent), transparent 62%),
  radial-gradient(46rem 20rem at 12% -18%, color-mix(in srgb, var(--accent) 6%, transparent), transparent 60%); }
.stage::after { content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none; opacity: .05; mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.55'/%3E%3C/svg%3E");
  background-size: 140px 140px; }
.stage.light::after { opacity: .035; mix-blend-mode: multiply; }
.stage.dark { --bg:#07090f; --bg-soft:#0a0d15; --panel:#0c101a; --line:#1c2432; --line-soft:#131926;
  --fg:#f1f4f9; --fg-soft:#a3aec2; --fg-dim:#5f6b83; --accent:#5aa9e6; --ok:#3dd68c;
  --ember:#ff7a45; --gold:#ffb454; --heat:linear-gradient(90deg,#ff5a1f,#ff7a45 45%,#ffb454); --on-accent:#fff; }
.stage.light { --bg:#f5f8fc; --bg-soft:#eaf1f9; --panel:#ffffff; --line:#d8e2ef; --line-soft:#e7eef7;
  --fg:#0c1726; --fg-soft:#42566d; --fg-dim:#6a7c91; --accent:#2e7cc0; --ok:#0f9d63;
  --ember:#e0571f; --gold:#d98a1f; --heat:linear-gradient(90deg,#d8480f,#e0571f 45%,#d98a1f); --on-accent:#fff; }
.stage-tag { position: absolute; top: 10px; right: 12px; font-family: 'JetBrains Mono', monospace; font-size: 9px;
  letter-spacing: .22em; color: var(--fg-dim); opacity: .8; }
.radius { --radius: 10px; }

/* ── the vocabulary (mirror of forge.css v2) ── */
.forge-eyebrow { display:inline-flex; align-items:center; gap:.6rem; font-family:'JetBrains Mono',monospace;
  font-size:.68rem; font-weight:600; letter-spacing:.18em; text-transform:uppercase; color:var(--fg-dim); margin-bottom:.55rem; }
.forge-eyebrow::before { content:""; width:1.15em; height:2px; background:var(--heat); border-radius:1px; }
.forge-title { font-family:'Big Shoulders'; font-size:2.6rem; font-weight:700; text-transform:uppercase;
  letter-spacing:.015em; line-height:.95; color:var(--fg); }
.forge-sub { margin:.55rem 0 0; color:var(--fg-soft); font-size:.92rem; }
.forge-head-rule { margin-top:1.05rem; height:1px; background:linear-gradient(90deg,
  color-mix(in srgb, var(--ember) 55%, var(--line)), color-mix(in srgb, var(--accent) 35%, var(--line)) 22%, var(--line) 45%, transparent); }
.forge-h { display:flex; align-items:baseline; gap:.6rem; margin:0 0 .8rem; }
.forge-h-title { font-family:'Big Shoulders'; font-size:.92rem; font-weight:600; text-transform:uppercase; letter-spacing:.16em; color:var(--fg-soft); }
.forge-h-meta { font-size:.75rem; color:var(--fg-dim); font-family:'JetBrains Mono',monospace; }
.forge-h-rule { flex:1; height:1px; background:linear-gradient(90deg,var(--line),transparent); }

.forge-pulse { display:inline-flex; align-items:center; gap:.5rem; padding:.4rem .85rem .4rem .65rem; border-radius:999px;
  border:1px solid color-mix(in srgb, var(--ember) 40%, var(--line));
  background: radial-gradient(120% 160% at 15% 50%, color-mix(in srgb, var(--ember) 16%, transparent), transparent 55%),
    color-mix(in srgb, var(--ember) 6%, transparent);
  font-size:.8rem; font-weight:600; color:var(--fg); box-shadow:0 0 18px -6px color-mix(in srgb, var(--ember) 45%, transparent); }
.forge-pulse.is-quiet { border-color:var(--line); background:color-mix(in srgb, var(--fg) 4%, transparent); color:var(--fg-dim); box-shadow:none; }
.forge-ember { width:.5rem; height:.5rem; border-radius:50%; background:radial-gradient(circle at 35% 35%, var(--gold), var(--ember) 70%);
  animation:pulse 1.7s ease-out infinite; }
.forge-pulse.is-quiet .forge-ember { background:var(--fg-dim); animation:none; }
@keyframes pulse { 0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--ember) 65%,transparent);} 70%{box-shadow:0 0 0 8px transparent;} 100%{box-shadow:0 0 0 0 transparent;} }

.forge-chip { display:inline-flex; align-items:center; gap:.4rem; padding:.18rem .55rem; border-radius:999px;
  border:1px solid var(--line); background:color-mix(in srgb, var(--fg) 5%, transparent);
  font-size:.72rem; font-weight:600; color:var(--fg-soft); }
.forge-chip.is-ember { border-color:color-mix(in srgb,var(--ember) 40%,var(--line)); background:color-mix(in srgb,var(--ember) 10%,transparent);
  color:var(--ember); box-shadow:0 0 12px -4px color-mix(in srgb,var(--ember) 50%,transparent); }
.forge-chip.is-accent { border-color:color-mix(in srgb,var(--accent) 35%,var(--line)); background:color-mix(in srgb,var(--accent) 9%,transparent); color:var(--accent); }
.mono-badge { font-family:'JetBrains Mono',monospace; font-size:.64rem; font-weight:600; letter-spacing:.1em; text-transform:uppercase;
  border-radius:999px; padding:.2rem .6rem; border:1px solid var(--line); color:var(--fg-soft); }

.forge-tiles { display:grid; grid-template-columns:repeat(4,1fr); gap:0; border:1px solid var(--line); border-radius:10px; overflow:hidden;
  background:linear-gradient(180deg, color-mix(in srgb, var(--fg) 2.5%, transparent), transparent 45%), color-mix(in srgb, var(--panel) 72%, transparent); }
.forge-tile { position:relative; overflow:hidden; border-left:1px solid var(--line-soft); padding:1rem 1.15rem .9rem; }
.forge-tile:first-child { border-left:0; }
.forge-tile-num { font-family:'Big Shoulders'; font-size:2.4rem; font-weight:700; line-height:.9; color:var(--fg); }
.forge-tile.is-live .forge-tile-num { color:var(--accent); text-shadow:0 0 22px color-mix(in srgb,var(--accent) 45%,transparent); }
.forge-tile:first-child.is-live .forge-tile-num { color:var(--ember); text-shadow:0 0 24px color-mix(in srgb,var(--ember) 50%,transparent); }
.forge-tile-label { margin-top:.45rem; font-family:'JetBrains Mono',monospace; font-size:.62rem; font-weight:500;
  letter-spacing:.14em; text-transform:uppercase; color:var(--fg-dim); }
.forge-tile-spark { position:absolute; left:0; top:0; height:2px; width:100%; background:var(--heat); opacity:0; }
.forge-tile.is-live .forge-tile-spark { opacity:.9; }
.forge-tile.is-live:not(:first-child) .forge-tile-spark { background:linear-gradient(90deg,transparent,var(--accent),transparent); }

.forge-ledger { border:1px solid var(--line); border-radius:10px; background:var(--panel); overflow:hidden; }
.forge-row { position:relative; display:flex; align-items:center; gap:.7rem; padding:.78rem 1rem .78rem 1.15rem; border-bottom:1px solid var(--line-soft); }
.forge-row:last-child { border-bottom:0; }
.forge-row::before { content:""; position:absolute; left:0; top:0; bottom:0; width:2px; background:transparent; }
.forge-row.is-running::before { width:3px; background:linear-gradient(180deg,var(--gold),var(--ember));
  box-shadow:0 0 10px color-mix(in srgb,var(--ember) 60%,transparent); }
.forge-row.is-running { background:linear-gradient(90deg, color-mix(in srgb, var(--ember) 9%, transparent), transparent 45%); }
.forge-row-title { font-size:.9rem; font-weight:500; flex:1; color:var(--fg); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.forge-row-meta { font-size:.76rem; color:var(--fg-dim); font-family:'JetBrains Mono',monospace; }
.dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }

.forge-tally { list-style:none; border:1px solid var(--line); border-radius:10px; background:var(--panel); overflow:hidden; }
.forge-tally li { position:relative; padding:.6rem .9rem .6rem 2rem; border-bottom:1px solid var(--line-soft);
  font-size:.84rem; line-height:1.45; color:var(--fg-soft); }
.forge-tally li:last-child { border-bottom:0; }
.forge-tally li::before { content:""; position:absolute; left:.9rem; top:1rem; width:.55rem; height:2px; border-radius:1px; background:var(--fg-dim); opacity:.6; }
.forge-tally.is-built li::before { background:var(--ok); opacity:.7; }
.forge-tally.is-ore li { color:var(--fg); }
.forge-tally.is-ore li::before { background:var(--accent); opacity:1; }

.btn { display:inline-flex; align-items:center; gap:.4rem; border:0; border-radius:8px; padding:.5rem 1.05rem;
  font:inherit; font-size:.85rem; font-weight:650; cursor:pointer; color:var(--on-accent);
  background:linear-gradient(180deg, color-mix(in srgb, var(--accent) 88%, #fff), var(--accent));
  box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 25%,transparent), 0 10px 24px -14px color-mix(in srgb,var(--accent) 60%,transparent); }
.btn.ghost { background:color-mix(in srgb, var(--fg) 3%, transparent); border:1px solid var(--line); color:var(--fg-soft); box-shadow:none; }
.forge-seg { display:inline-flex; border:1px solid var(--line); border-radius:9px; overflow:hidden; background:color-mix(in srgb, var(--fg) 3%, transparent); }
.forge-seg button { border:0; border-left:1px solid var(--line-soft); background:transparent; color:var(--fg-dim);
  font:inherit; font-size:.78rem; font-weight:600; padding:.38rem .75rem; cursor:pointer; }
.forge-seg button:first-child { border-left:0; }
.forge-seg button.is-on { background:linear-gradient(180deg, color-mix(in srgb, var(--accent) 88%, #fff), var(--accent));
  box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 25%,transparent); color:var(--on-accent); }
.forge-bar { display:flex; align-items:stretch; border:1px solid var(--line); border-radius:12px;
  background:color-mix(in srgb, var(--panel) 72%, transparent); overflow:hidden; }
.forge-bar input { flex:1; min-width:0; background:transparent; border:0; outline:none; color:var(--fg); font:inherit; font-size:.92rem; padding:.75rem 1.05rem; }
.forge-bar input::placeholder { color:var(--fg-dim); }
.forge-bar-send { border:0; background:linear-gradient(180deg, color-mix(in srgb, var(--accent) 88%, #fff), var(--accent));
  box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 25%,transparent); color:var(--on-accent); font:inherit; font-weight:650; font-size:.9rem; padding:0 1.3rem; cursor:pointer; }

.forge-empty { display:grid; place-items:center; text-align:center; gap:.5rem; padding:2.4rem 1.5rem;
  border:1px solid var(--line); border-radius:10px;
  background: radial-gradient(70% 90% at 50% 118%, color-mix(in srgb, var(--ember) 7%, transparent), transparent 60%),
    radial-gradient(120% 140% at 50% -20%, color-mix(in srgb, var(--accent) 7%, transparent), transparent 60%), var(--panel); }
.forge-empty-mark { display:grid; place-items:center; width:3.4rem; height:3.4rem; border-radius:50%;
  color:color-mix(in srgb, var(--ember) 55%, var(--fg-dim));
  background: radial-gradient(circle at 50% 62%, color-mix(in srgb, var(--ember) 13%, transparent), transparent 68%),
    color-mix(in srgb, var(--fg) 4%, transparent);
  border:1px solid color-mix(in srgb, var(--ember) 18%, var(--line));
  box-shadow:0 0 26px -8px color-mix(in srgb, var(--ember) 35%, transparent); font-size:1.3rem; }
.forge-empty-title { font-family:'Big Shoulders'; font-size:1.2rem; font-weight:600; text-transform:uppercase; letter-spacing:.06em; color:var(--fg-soft); }
.forge-empty-sub { font-size:.84rem; line-height:1.55; color:var(--fg-dim); max-width:40ch; }

.sw-row { display:flex; gap:10px; flex-wrap:wrap; }
.sw { width:118px; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:var(--panel); }
.sw-fill { height:44px; }
.sw-name { font-family:'JetBrains Mono',monospace; font-size:.58rem; letter-spacing:.08em; color:var(--fg-dim); padding:.35rem .5rem; text-transform:uppercase; }
.heat-bar { height:14px; border-radius:7px; background:var(--heat); box-shadow:0 0 18px -4px color-mix(in srgb, var(--ember) 55%, transparent); }
.note { font-size:.8rem; color:var(--fg-dim); line-height:1.5; }
.spec-display { font-family:'Big Shoulders'; font-weight:700; text-transform:uppercase; line-height:.95; color:var(--fg); }
.spec-mono { font-family:'JetBrains Mono',monospace; color:var(--fg-soft); }
"""

def card(marker, body_dark, body_light=None):
    if body_light is None:
        body_light = body_dark
    return f"""{marker}
<!doctype html><html><head><meta charset="utf-8"><style>{FONTS}{DS_CSS}</style></head><body>
<div class="stage dark radius"><span class="stage-tag">DARK · THE NIGHT</span>{body_dark}</div>
<div class="stage light radius"><span class="stage-tag">LIGHT · THE PAPER</span>{body_light}</div>
</body></html>"""

CARDS = {}

CARDS["brand/nameplate.html"] = card(
    '<!-- @dsCard group="Brand" name="The stamped nameplate" subtitle="eyebrow · display caps · cooling rule · ember pulse" width="820" height="640" -->',
    """
<span class="forge-eyebrow">Brokk · the forge floor</span>
<h1 class="forge-title">Maglink</h1>
<p class="forge-sub">2 active · 14 on the books</p>
<div class="forge-head-rule"></div>
<div style="display:flex; gap:10px; margin-top:16px;">
  <span class="forge-pulse"><span class="forge-ember"></span>Forging now · 2 in the fire</span>
  <span class="forge-pulse is-quiet"><span class="forge-ember"></span>The forge is quiet</span>
</div>
""")

CARDS["type/voice.html"] = card(
    '<!-- @dsCard group="Type" name="The voice" subtitle="Big Shoulders display · Inter body · JetBrains Mono machine truth" width="820" height="760" -->',
    """
<div class="spec-display" style="font-size:3rem;">Big Shoulders</div>
<div class="spec-display" style="font-size:1.4rem; margin-top:6px; color:var(--fg-soft);">Every masthead, numeral &amp; wordmark — stamped steel</div>
<div class="forge-head-rule" style="margin:18px 0 16px;"></div>
<p style="font-size:.95rem; color:var(--fg); max-width:60ch;">Inter carries the body — what a human reads: subtitles, briefs, row titles, empty-state lines. Quiet, never the voice.</p>
<p class="spec-mono" style="font-size:.8rem; margin-top:14px;">JetBrains Mono marks machine truth → ids · counts · timestamps · column heads · 75.2k/2.5k · 3d ago</p>
<p class="note" style="margin-top:16px;">Rule: display face is ALWAYS caps with positive tracking; mono only where a machine wrote it. If the biggest type on a surface is 1rem Inter, the surface has no voice.</p>
""")

CARDS["colors/night-heat.html"] = card(
    '<!-- @dsCard group="Colors" name="Night & heat" subtitle="the night registers · cold accent · the heat ramp (running work ONLY)" width="820" height="820" -->',
    """
<div class="forge-h"><span class="forge-h-title">The night</span><span class="forge-h-rule"></span></div>
<div class="sw-row">
  <div class="sw"><div class="sw-fill" style="background:var(--bg);"></div><div class="sw-name">--bg</div></div>
  <div class="sw"><div class="sw-fill" style="background:var(--panel);"></div><div class="sw-name">--panel</div></div>
  <div class="sw"><div class="sw-fill" style="background:var(--line);"></div><div class="sw-name">--line</div></div>
  <div class="sw"><div class="sw-fill" style="background:var(--fg-dim);"></div><div class="sw-name">--fg-dim</div></div>
  <div class="sw"><div class="sw-fill" style="background:var(--fg);"></div><div class="sw-name">--fg</div></div>
  <div class="sw"><div class="sw-fill" style="background:var(--accent);"></div><div class="sw-name">--accent · cold structure</div></div>
</div>
<div class="forge-h" style="margin-top:20px;"><span class="forge-h-title">The heat</span><span class="forge-h-meta">running work ONLY</span><span class="forge-h-rule"></span></div>
<div class="heat-bar"></div>
<p class="note" style="margin-top:10px;">--heat: ember → gold. The single warm register in a cold world. Molten rails, burning numerals, banked coals — never decorative, never emphasis, never errors. When it appears, it burns.</p>
""")

CARDS["components/vitals.html"] = card(
    '<!-- @dsCard group="Components" name="The vitals strip" subtitle="one forged bar, hairline-divided; running burns ember, live glows accent" width="820" height="560" -->',
    """
<div class="forge-tiles">
  <div class="forge-tile is-live"><div class="forge-tile-num">2</div><div class="forge-tile-label">Running now</div><span class="forge-tile-spark"></span></div>
  <div class="forge-tile"><div class="forge-tile-num">5</div><div class="forge-tile-label">Queued</div></div>
  <div class="forge-tile is-live"><div class="forge-tile-num">1</div><div class="forge-tile-label">In review · PR</div><span class="forge-tile-spark"></span></div>
  <div class="forge-tile"><div class="forge-tile-num">61</div><div class="forge-tile-label">Forged</div></div>
</div>
<p class="note" style="margin-top:12px;">Numerals the operator reads from across the room. Never a crate of boxes — one surface, hairline dividers.</p>
""")

CARDS["components/ledger.html"] = card(
    '<!-- @dsCard group="Components" name="The ledger" subtitle="rows of work, next-up first; the running row carries molten metal" width="820" height="640" -->',
    """
<div class="forge-ledger">
  <div class="forge-row is-running"><span class="dot" style="background:var(--ember);"></span><span class="forge-row-title">rate-limit the public API</span><span class="forge-row-meta">Brokkr · forging</span></div>
  <div class="forge-row"><span class="dot" style="background:var(--accent);"></span><span class="forge-row-title">add a /health endpoint</span><span class="forge-row-meta">queued</span></div>
  <div class="forge-row"><span class="dot" style="background:var(--ok);"></span><span class="forge-row-title">port the consultas flow</span><span class="forge-row-meta">PR #218 · shipped</span></div>
  <div class="forge-row"><span class="dot" style="background:var(--fg-dim);"></span><span class="forge-row-title">dark-mode the settings</span><span class="forge-row-meta">3d ago</span></div>
</div>
""")

CARDS["components/tally.html"] = card(
    '<!-- @dsCard group="Components" name="The tally" subtitle="static lists as hairline rows — built (quiet tick) vs ore (accent tick)" width="820" height="640" -->',
    """
<div style="display:grid; grid-template-columns:1fr 1fr; gap:18px;">
  <div>
    <div class="forge-h"><span class="forge-h-title">Built</span><span class="forge-h-meta">3</span><span class="forge-h-rule"></span></div>
    <ul class="forge-tally is-built"><li>Expo Router app shell with auth provider at root</li><li>Multi-mode auth resolved by env seam</li><li>NativeWind styling with themed components</li></ul>
  </div>
  <div>
    <div class="forge-h"><span class="forge-h-title">Missing</span><span class="forge-h-meta">2</span><span class="forge-h-rule"></span></div>
    <ul class="forge-tally is-ore"><li>Real feature screens beyond the scaffold</li><li>Auth integration tests for token refresh</li></ul>
  </div>
</div>
<p class="note" style="margin-top:12px;">Never a stack of bordered boxes. One surface, hairline rows, the actionable half ticked in accent.</p>
""")

CARDS["components/chips.html"] = card(
    '<!-- @dsCard group="Components" name="Chips, pulse & badges" subtitle="ember strictly for running work; badges are etched mono" width="820" height="560" -->',
    """
<div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
  <span class="forge-pulse"><span class="forge-ember"></span>Forging now · 2 in the fire</span>
  <span class="forge-pulse is-quiet"><span class="forge-ember"></span>The forge is quiet</span>
</div>
<div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-top:14px;">
  <span class="forge-chip">subscription</span>
  <span class="forge-chip is-accent">engine default</span>
  <span class="forge-chip is-ember">forging</span>
</div>
<div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-top:14px;">
  <span class="mono-badge" style="color:var(--ok); border-color:color-mix(in srgb, var(--ok) 35%, var(--line));">● done</span>
  <span class="mono-badge" style="color:var(--ember); border-color:color-mix(in srgb, var(--ember) 35%, var(--line));">● failed</span>
  <span class="mono-badge">● cancelled</span>
</div>
""")

CARDS["components/controls.html"] = card(
    '<!-- @dsCard group="Components" name="Controls" subtitle="forged primary · quiet iron ghost · segmented · the command-bar" width="820" height="640" -->',
    """
<div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
  <button class="btn">Queue work</button>
  <button class="btn ghost">Scout again</button>
  <span class="forge-seg"><button>Light</button><button class="is-on">Standard</button><button>Full</button></span>
</div>
<div class="forge-bar" style="margin-top:16px;">
  <input placeholder="Describe a task and queue it to the forge…">
  <button class="forge-bar-send">Queue →</button>
</div>
<p class="note" style="margin-top:12px;">Primary = struck metal (top highlight on accent). Ghost = quiet iron that lights accent on touch. No naked library defaults, ever.</p>
""")

CARDS["states/hearth.html"] = card(
    '<!-- @dsCard group="States" name="The cold hearth" subtitle="zero is rest, never failure — the coals stay faintly warm" width="820" height="640" -->',
    """
<div class="forge-empty">
  <span class="forge-empty-mark">▲</span>
  <span class="forge-empty-title">The forge is quiet</span>
  <p class="forge-empty-sub">Queued and running tasks line up here, next-up first. Describe a task above to light it.</p>
  <button class="btn" style="margin-top:8px;">Queue work</button>
</div>
""")

DS_CSS += """
.forge-field { display:flex; flex-direction:column; gap:.35rem; min-width:0; }
.forge-field-label { font-family:'JetBrains Mono',monospace; font-size:.62rem; font-weight:600; letter-spacing:.16em; text-transform:uppercase; color:var(--fg-dim); }
.forge-field input, .forge-field select { border:1px solid var(--line); border-radius:.55rem; background:color-mix(in srgb, var(--fg) 3%, transparent);
  color:var(--fg); font:inherit; font-size:.9rem; padding:.55rem .8rem; outline:none; }
.forge-field input:focus { border-color:color-mix(in srgb, var(--accent) 50%, var(--line)); box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent); }
.forge-skeleton { position:relative; overflow:hidden; border-radius:.45rem; background:color-mix(in srgb, var(--fg) 5%, transparent); }
.forge-skeleton::after { content:""; position:absolute; inset:0; background:linear-gradient(100deg, transparent 30%,
  color-mix(in srgb, var(--ember) 7%, color-mix(in srgb, var(--fg) 7%, transparent)) 50%, transparent 70%);
  background-size:220% 100%; animation:heat 1.6s linear infinite; }
@keyframes heat { to { background-position:-220% 0; } }
.forge-toast { display:flex; align-items:center; gap:.6rem; min-width:16rem; max-width:26rem; padding:.7rem .95rem;
  border:1px solid var(--line); border-radius:.7rem;
  background:linear-gradient(180deg, color-mix(in srgb, var(--fg) 2.5%, transparent), transparent 45%), color-mix(in srgb, var(--panel) 88%, transparent);
  box-shadow:0 18px 40px -18px rgba(0,0,0,.55); color:var(--fg); font-size:.84rem; line-height:1.45; }
.forge-toast::before { content:""; align-self:stretch; width:2px; border-radius:1px; background:var(--accent); flex-shrink:0; }
.forge-toast.is-ok::before { background:var(--ok); }
.forge-toast.is-err::before { background:#e5484d; }
.forge-toast-meta { font-family:'JetBrains Mono',monospace; font-size:.72rem; color:var(--fg-dim); }
.forge-dialog { width:min(28rem,100%); border:1px solid var(--line); border-radius:12px;
  background:linear-gradient(180deg, color-mix(in srgb, var(--fg) 2.5%, transparent), transparent 40%), var(--panel);
  box-shadow:0 30px 80px -30px rgba(0,0,0,.7); padding:1.4rem 1.5rem 1.25rem; }
.forge-dialog-title { font-family:'Big Shoulders'; font-size:1.25rem; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--fg); margin:0 0 .5rem; }
.forge-dialog-body { font-size:.88rem; line-height:1.55; color:var(--fg-soft); margin:0 0 1.1rem; }
.forge-dialog-actions { display:flex; justify-content:flex-end; gap:.6rem; }
.scrim-demo { background:color-mix(in srgb, #000 45%, transparent); border-radius:10px; display:grid; place-items:center; padding:1.6rem; }
.ygg-banner { position:relative; border:1px solid var(--line); border-radius:.7rem; background:color-mix(in srgb, var(--panel) 85%, transparent);
  color:var(--fg-soft); font-size:.85rem; line-height:1.5; padding:.7rem .95rem .7rem 1.15rem; overflow:hidden; }
.ygg-banner::before { content:""; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--accent); }
.ygg-banner.ok::before { background:var(--ok); }
.ygg-banner.err::before { background:#e5484d; }
.rail { width:196px; background:color-mix(in srgb, #000 30%, var(--bg)); border-right:1px solid var(--line-soft); border-radius:10px 0 0 10px; padding:14px 10px; }
.stage.light .rail { background:color-mix(in srgb, var(--bg) 60%, var(--panel)); }
.rail-brand { font-family:'Big Shoulders'; font-weight:700; font-size:1.1rem; letter-spacing:.09em; text-transform:uppercase; color:var(--fg); padding:0 6px 12px; }
.rail-group { font-family:'JetBrains Mono',monospace; font-size:.56rem; font-weight:600; letter-spacing:.22em; text-transform:uppercase; color:var(--fg-dim); margin:10px 6px 4px; }
.rail-link { display:flex; align-items:center; gap:.5rem; font-size:.8rem; font-weight:500; color:var(--fg-soft); padding:.34rem .5rem; border-radius:.5rem; }
.rail-link.on { background:color-mix(in srgb, var(--accent) 12%, transparent); box-shadow:inset 2px 0 0 var(--accent); color:var(--fg); font-weight:600; }
.rail-pod { display:flex; align-items:center; gap:.5rem; border-top:1px solid var(--line-soft); margin-top:12px; padding:10px 6px 0; }
.rail-plate { display:grid; place-items:center; width:1.8rem; height:1.8rem; border-radius:50%; border:1px solid var(--line);
  background:radial-gradient(circle at 50% 30%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 70%), color-mix(in srgb, var(--fg) 4%, transparent);
  font-family:'Big Shoulders'; font-size:.72rem; font-weight:700; color:var(--fg-soft); }
.rail-name { font-size:.76rem; font-weight:600; color:var(--fg); }
.rail-role { font-family:'JetBrains Mono',monospace; font-size:.54rem; letter-spacing:.14em; text-transform:uppercase; color:var(--fg-dim); }
.anvil-col { flex:1; min-width:0; border:1px solid var(--line); border-radius:10px; background:color-mix(in srgb, var(--panel) 80%, transparent); padding:10px; }
.anvil-card { border:1px solid var(--line); border-radius:8px; background:var(--panel); padding:.6rem .7rem; margin-bottom:8px; }
.anvil-card.run { border-color:color-mix(in srgb, var(--ember) 35%, var(--line)); box-shadow:inset 2px 0 0 var(--ember); }
.anvil-card-t { font-size:.8rem; font-weight:500; color:var(--fg); line-height:1.35; }
.anvil-card-m { font-family:'JetBrains Mono',monospace; font-size:.64rem; color:var(--fg-dim); margin-top:.3rem; }
.bubble { max-width:78%; border-radius:12px; padding:.6rem .8rem; font-size:.84rem; line-height:1.55; }
.bubble.user { background:var(--accent); color:var(--on-accent); border-bottom-right-radius:4px; margin-left:auto; }
.bubble.smith { background:color-mix(in srgb, var(--fg) 4%, transparent); border:1px solid var(--line-soft); color:var(--fg); border-bottom-left-radius:4px; }
.ghost { border-radius:.45rem; background:color-mix(in srgb, var(--fg) 5%, transparent); }
.anno { font-family:'JetBrains Mono',monospace; font-size:.6rem; letter-spacing:.12em; text-transform:uppercase; color:var(--accent); }
"""

CARDS["elements/field.html"] = card(
    '<!-- @dsCard group="Elements" name="The field" subtitle="mono label · iron input that lights on focus · form section" width="820" height="600" -->',
    """
<div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; max-width:560px;">
  <div class="forge-field"><span class="forge-field-label">Name</span><input value="forge-b"></div>
  <div class="forge-field"><span class="forge-field-label">Base branch</span><input placeholder="dev"></div>
  <div class="forge-field" style="grid-column:1/-1;"><span class="forge-field-label">Email</span><input value="vitor@coldcodelabs.com"></div>
</div>
<p class="note" style="margin-top:12px;">Label = machine truth (mono, etched). Control = quiet iron, accent ring on focus. Never a naked input.</p>
""")

CARDS["elements/skeleton.html"] = card(
    '<!-- @dsCard group="Elements" name="The skeleton" subtitle="loading = metal heating, not a grey void" width="820" height="560" -->',
    """
<div class="forge-skeleton" style="width:9rem; height:.8rem; margin-bottom:.8rem;"></div>
<div class="forge-skeleton" style="width:22rem; height:2.4rem; margin-bottom:.7rem;"></div>
<div class="forge-skeleton" style="width:15rem; height:.9rem; margin-bottom:1.4rem;"></div>
<div class="forge-skeleton" style="width:100%; height:4.6rem;"></div>
<p class="note" style="margin-top:12px;">The shimmer carries a trace of ember — the bar warming. Every route ships app/(app)/loading.tsx built from these.</p>
""")

CARDS["components/toast.html"] = card(
    '<!-- @dsCard group="Components" name="The toast" subtitle="quiet confirmation — the artifact IS the message" width="820" height="600" -->',
    """
<div style="display:flex; flex-direction:column; gap:10px; max-width:26rem;">
  <div class="forge-toast is-ok"><div>6 cards queued — to the forge.<div class="forge-toast-meta">maglink · backlog</div></div></div>
  <div class="forge-toast"><div>PR #42 opened.<div class="forge-toast-meta">brokk/fleet-empty-states</div></div></div>
  <div class="forge-toast is-err"><div>Build failed at pnpm install. Read the log, fix, and re-queue.<div class="forge-toast-meta">exit 1 · 73s</div></div></div>
</div>
<p class="note" style="margin-top:12px;">Slides in low-right, leaves on its own (errors linger). No exclamation marks, no apology theater — state what happened, name the artifact, stop.</p>
""")

CARDS["components/dialog.html"] = card(
    '<!-- @dsCard group="Components" name="The dialog" subtitle="a plate struck over the night — destructive confirmations only" width="820" height="640" -->',
    """
<div class="scrim-demo">
  <div class="forge-dialog">
    <h3 class="forge-dialog-title">Delete forge-b?</h3>
    <p class="forge-dialog-body">This deletes forge-b and its queue. The branch and its PRs are untouched.</p>
    <div class="forge-dialog-actions"><button class="btn ghost">Keep it</button><button class="btn" style="background:linear-gradient(180deg,#f16a6f,#e5484d);">Delete forge-b</button></div>
  </div>
</div>
<p class="note" style="margin-top:12px;">Reserved for interruptions that must interrupt. States the irreversible consequence flatly, repeats the object's name in the verb.</p>
""")

CARDS["components/banner.html"] = card(
    '<!-- @dsCard group="Components" name="The banner" subtitle="inline notice — hairline plate with a tone rail, never a colored slab" width="820" height="560" -->',
    """
<div style="display:grid; gap:10px;">
  <div class="ygg-banner">Preview boots in ~40s — the dev branch is building.</div>
  <div class="ygg-banner ok">Seat connected. Runs spread across 2 seats now.</div>
  <div class="ygg-banner err">Board fetch failed: 502 — retrying every 5s.</div>
</div>
""")

CARDS["patterns/sidebar.html"] = card(
    '<!-- @dsCard group="Patterns" name="The rail" subtitle="chrome joins the night: stamped brand · etched groups · lit nav · identity pod" width="820" height="760" -->',
    """
<div class="rail">
  <div class="rail-brand">Brokk</div>
  <div class="rail-group">Forge</div>
  <div class="rail-link">Fleet</div>
  <div class="rail-link on">Dashboard</div>
  <div class="rail-link">Mímir</div>
  <div class="rail-group">Anvil</div>
  <div class="rail-link">Board</div>
  <div class="rail-link">Sindri</div>
  <div class="rail-pod"><span class="rail-plate">VA</span><span><span class="rail-name">Vitor Alves</span><br><span class="rail-role">proprietário</span></span></div>
</div>
""")

CARDS["patterns/board.html"] = card(
    '<!-- @dsCard group="Patterns" name="The anvil board" subtitle="kanban columns; the running card carries the ember rail" width="820" height="640" -->',
    """
<div style="display:flex; gap:10px;">
  <div class="anvil-col"><div class="forge-h"><span class="forge-h-title">Queued</span><span class="forge-h-meta">2</span></div>
    <div class="anvil-card"><div class="anvil-card-t">add a /health endpoint</div><div class="anvil-card-m">Eitri · queued</div></div>
    <div class="anvil-card"><div class="anvil-card-t">fleet empty-state polish</div><div class="anvil-card-m">backlog → queued</div></div></div>
  <div class="anvil-col"><div class="forge-h"><span class="forge-h-title">Forging</span><span class="forge-h-meta">1</span></div>
    <div class="anvil-card run"><div class="anvil-card-t">rate-limit the public API</div><div class="anvil-card-m">Brokkr · 3m in the fire</div></div></div>
  <div class="anvil-col"><div class="forge-h"><span class="forge-h-title">Shipped</span><span class="forge-h-meta">1</span></div>
    <div class="anvil-card"><div class="anvil-card-t">port the consultas flow</div><div class="anvil-card-m">PR #218 · merged</div></div></div>
</div>
""")

CARDS["patterns/chat.html"] = card(
    '<!-- @dsCard group="Patterns" name="The cockpit" subtitle="Sindri at the anvil — human turns in accent, the smith on iron" width="820" height="640" -->',
    """
<div style="display:flex; flex-direction:column; gap:10px; max-width:560px;">
  <div class="bubble user">Fix the flaky auth test and open a PR.</div>
  <div class="bubble smith">Cloning maglink, branch <span class="spec-mono">sindri/auth-flake</span>. The test races the token refresh — pinning the clock. Forging…</div>
  <div class="bubble smith">PR #43 opened — <span class="spec-mono">maglink/auth-flake-fix</span>. 2 files, +18 −4.</div>
</div>
<div class="forge-bar" style="margin-top:14px; max-width:560px;"><input placeholder="What should Sindri forge in maglink?"><button class="forge-bar-send">Send</button></div>
""")

CARDS["pages/anatomy.html"] = card(
    '<!-- @dsCard group="Pages" name="Page anatomy" subtitle="the canonical room: nameplate → vitals → primary act → ledger" width="820" height="760" -->',
    """
<div style="display:grid; gap:12px;">
  <div><span class="anno">1 · nameplate</span>
    <div style="margin-top:4px;"><span class="forge-eyebrow">Brokk · the forge floor</span>
    <div class="forge-title" style="font-size:1.9rem;">Maglink</div><div class="forge-head-rule"></div></div></div>
  <div><span class="anno">2 · vitals</span>
    <div class="forge-tiles" style="margin-top:4px;"><div class="forge-tile is-live"><div class="forge-tile-num" style="font-size:1.8rem;">2</div><div class="forge-tile-label">Running</div><span class="forge-tile-spark"></span></div>
    <div class="forge-tile"><div class="forge-tile-num" style="font-size:1.8rem;">5</div><div class="forge-tile-label">Queued</div></div>
    <div class="forge-tile"><div class="forge-tile-num" style="font-size:1.8rem;">61</div><div class="forge-tile-label">Forged</div></div>
    <div class="forge-tile"><div class="forge-tile-num" style="font-size:1.8rem;">1</div><div class="forge-tile-label">PR</div></div></div></div>
  <div><span class="anno">3 · the primary act (exactly once)</span>
    <div class="forge-bar" style="margin-top:4px;"><input placeholder="Describe a task and queue it to the forge…"><button class="forge-bar-send">Queue →</button></div></div>
  <div><span class="anno">4 · the ledger</span>
    <div class="forge-ledger" style="margin-top:4px;"><div class="forge-row is-running"><span class="dot" style="background:var(--ember);"></span><span class="forge-row-title">rate-limit the public API</span><span class="forge-row-meta">forging</span></div>
    <div class="forge-row"><span class="dot" style="background:var(--accent);"></span><span class="forge-row-title">add a /health endpoint</span><span class="forge-row-meta">queued</span></div></div></div>
</div>
""")

for path, html in CARDS.items():
    full = os.path.join(ROOT, "out", path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    open(full, "w").write(html)
    print(f"{path}  {len(html)//1024} KiB")
print("cards:", len(CARDS))
