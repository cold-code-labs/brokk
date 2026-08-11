#!/usr/bin/env node
/**
 * Litr visual-verify harness — reproducible screenshots of a Brokk surface in
 * both themes, on the *real* design-language CSS.
 *
 * Why this exists: Tailwind preflight is OFF and entrance animations use
 * `animation: … both` with stagger delays, so a naive screenshot captures
 * elements mid-fade at opacity:0 and reads as "missing". This harness inlines
 * the real token + surface CSS, renders canonical states, and drives
 * chrome-headless-shell past the longest entrance with --virtual-time-budget.
 *
 * Usage:
 *   node tools/litr-verify/render.mjs            # all states, both themes
 *   node tools/litr-verify/render.mjs --html     # write HTML only (no chrome)
 *   LITR_CHROME=/path/to/chrome-headless-shell node tools/litr-verify/render.mjs
 *
 * Output: tools/litr-verify/out/<state>-<theme>.png (+ .html)
 *
 * This is the dogfood surface for the `Litr` design skill. The CSS is read from
 * disk every run, so it always verifies *current* source — never a stale copy.
 * The sample markup below mirrors FleetView's canonical states; when FleetView's
 * structure changes, update the SAMPLES here so the verify loop stays honest.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const webDir = resolve(repoRoot, "apps", "web");
const outDir = resolve(here, "out");

// Resolve the real CSS from apps/web's module graph (pnpm-safe).
const webRequire = createRequire(pathToFileURL(resolve(webDir, "package.json")));
const tokensCss = readFileSync(webRequire.resolve("@cold-code-labs/yggdrasil-tokens/css"), "utf8");
const fleetCss = readFileSync(resolve(webDir, "app", "fleet.css"), "utf8");
const globalsCss = readFileSync(resolve(webDir, "app", "globals.css"), "utf8");

// Pull just the forge-nav block out of globals.css so the sidebar verifies too.
const navBlock = globalsCss.slice(
  Math.max(0, globalsCss.indexOf("/* ── Forge sidebar")),
  globalsCss.indexOf("/* ── Sindri")
);

// ── inline icons (lucide path data) ─────────────────────────────────────────
const icon = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const FLAME = icon('<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>');
const FOLDER = icon('<path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v3"/><circle cx="13" cy="17" r="3"/><path d="M13 14v-1.5M13 23v-2M19 17h2.5M5 17h2.5"/>');

// ── canonical states (mirror of FleetView / House list markup) ──────────────
const BAR = (running) => `
<header class="house-bar">
  <div class="house-bar-brand">
    <span class="fleet-eyebrow">Brokk · CCL</span>
    <h1 class="house-bar-title">House</h1>
    <span class="fleet-pulse${running ? "" : " is-quiet"}"><span class="fleet-ember"></span>${
      running ? `${running} forging · 3 queued · 1 PR` : "quiet · 0 projects · 2 seats"
    }</span>
  </div>
  <div class="house-bar-actions">
    <div class="fleet-pin-strip house-bar-pins">
      <button type="button" class="fleet-pin-chip is-running"><kbd class="fleet-pin-key">1</kbd><span class="fleet-pin-name">dekaprint</span><span class="fleet-run-dot"></span></button>
      <button type="button" class="fleet-pin-chip is-active"><kbd class="fleet-pin-key">2</kbd><span class="fleet-pin-name">viken</span></button>
      <button type="button" class="fleet-pin-chip"><kbd class="fleet-pin-key">3</kbd><span class="fleet-pin-name">arte-one</span></button>
    </div>
    <a class="ygg-btn ygg-btn-solid">+ Connect</a>
  </div>
</header>`;

const BAR_EMPTY = `
<header class="house-bar">
  <div class="house-bar-brand">
    <span class="fleet-eyebrow">Brokk · CCL</span>
    <h1 class="house-bar-title">House</h1>
    <span class="fleet-pulse is-quiet"><span class="fleet-ember"></span>quiet · 0 projects · 2 seats</span>
  </div>
  <div class="house-bar-actions">
    <span class="house-bar-hint">Pin clients in the list · keys 1–9</span>
    <a class="ygg-btn ygg-btn-solid">+ Connect</a>
  </div>
</header>`;

const LIST_ROW = (name, repo, running, counts, gap) => `
<div class="house-row${running ? " is-running" : ""} is-hot" role="row">
  <div class="house-cell house-cell-pin"><button type="button" class="fleet-pin-btn is-on">◆<span class="house-pin-idx">1</span></button></div>
  <div class="house-cell house-cell-name"><a class="house-name">${name}</a><span class="house-repo">${repo}</span></div>
  <div class="house-cell house-cell-state">${
    running
      ? `<span class="fleet-card-state running"><span class="fleet-run-dot"></span>${running} run</span>`
      : '<span class="fleet-card-state idle">idle</span>'
  }</div>
  <div class="house-cell house-cell-counts">${counts}</div>
  <div class="house-cell house-cell-gap">${
    gap
      ? `<button type="button" class="house-gap"><span class="house-gap-mark">+</span><span class="house-gap-text">${gap}</span></button>`
      : '<span class="house-gap-empty">—</span>'
  }</div>
  <div class="house-cell house-cell-cta">
    <button type="button" class="house-ico" aria-label="Chat">💬</button>
    <button type="button" class="house-ico" aria-label="Board">▦</button>
    <button type="button" class="house-ico" aria-label="Preview">◉</button>
  </div>
</div>`;

const COUNTS = (bk, q, pr, gap) => `
<span class="house-count">${bk}<em>bk</em></span>
<span class="house-count${q ? " is-warn" : ""}">${q}<em>q</em></span>
<span class="house-count${pr ? " is-info" : ""}">${pr}<em>pr</em></span>
${gap ? `<span class="house-count is-warn">${gap}<em>gap</em></span>` : ""}`;

const EMPTY_REPOS = `
<div class="fleet-empty is-panel"><span class="fleet-empty-mark">${FOLDER}</span>
  <span class="fleet-empty-title">No repos at the house yet</span>
  <p class="fleet-empty-sub">Connect a repository and Brokk can pick up tasks, open PRs, and forge previews.</p>
  <span class="fleet-empty-action"><a class="ygg-btn ygg-btn-solid">+ Connect a repo</a></span></div>`;

const FOOTER = `
<footer class="house-footer">
  <div class="house-footer-dock">
    <span class="house-footer-label">Sessions</span>
    <div class="fleet-dock-strip">
      <button type="button" class="fleet-dock-chip is-running"><span class="fleet-dock-proj">dekaprint</span><span class="fleet-dock-title">Checkout flow polish</span><span class="fleet-run-dot"></span></button>
      <button type="button" class="fleet-dock-chip"><span class="fleet-dock-proj">viken</span><span class="fleet-dock-title">Reset senha edge</span></button>
    </div>
  </div>
  <div class="house-footer-queue">
    <span class="house-footer-label">Queue<em>2</em></span>
    <div class="house-queue-strip">
      <a class="house-queue-chip is-running"><span class="fleet-row-dot" style="background:var(--ember)"></span><span class="house-queue-proj">dekaprint</span><span class="house-queue-title">Wire Vindi delinquency</span></a>
      <a class="house-queue-chip"><span class="fleet-row-dot" style="background:var(--accent)"></span><span class="house-queue-proj">brokk</span><span class="house-queue-title">House list polish</span></a>
    </div>
  </div>
</footer>`;

const SAMPLES = {
  populated: `
    ${BAR(2)}${COMPOSER}
    <section class="house-list-wrap">
      <div class="house-list-head" role="row">
        <span class="house-cell house-cell-pin"></span>
        <span class="house-cell house-cell-name">Project<em class="house-list-meta">3 · by need</em></span>
        <span class="house-cell house-cell-state">State</span>
        <span class="house-cell house-cell-counts">bk / q / pr</span>
        <span class="house-cell house-cell-gap">Next gap</span>
        <span class="house-cell house-cell-cta"></span>
      </div>
      <div class="house-list" role="table">
        ${LIST_ROW("dekaprint", "cold-code-labs/dekaprint · main", 2, COUNTS(4, 3, 1, 2), "Wire Vindi delinquency banner", false)}
        ${LIST_ROW("viken", "cold-code-labs/viken · main", 0, COUNTS(2, 0, 1, 1), "Unit-level slot interval", true)}
        ${LIST_ROW("arte-one", "cold-code-labs/arte-one · main", 0, COUNTS(1, 0, 0, 0), null, false)}
      </div>
    </section>
    ${FOOTER}`,
  empty: `
    ${BAR_EMPTY}${COMPOSER}
    <section class="house-list-wrap">${EMPTY_REPOS}</section>
    <footer class="house-footer">
      <div class="house-footer-dock"><span class="house-footer-label">Sessions</span><span class="house-footer-empty">open a chat — it lands here</span></div>
      <div class="house-footer-queue"><span class="house-footer-label">Queue</span><span class="house-footer-empty">${FLAME} forge quiet</span></div>
    </footer>`,
};

// Mini sidebar so the nav polish verifies in the same frame.
const SIDEBAR = `
<aside class="ygg-nav" style="width:220px;flex:0 0 auto;padding:1rem .5rem;border-right:1px solid var(--line)">
  <div class="ygg-nav-group"><div class="ygg-nav-group-label">Forge</div>
    <a class="ygg-nav-link" data-active="true">${FOLDER}House</a>
    <a class="ygg-nav-link">${FLAME}Dashboard</a>
    <a class="ygg-nav-link">${FLAME}Chat</a>
  </div></aside>`;

function page(theme, body) {
  return `<!doctype html><html lang="en"${theme === "dark" ? ' class="dark"' : ""}><head><meta charset="utf8">
<style>${tokensCss}\n${fleetCss}\n${navBlock}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,sans-serif}
  .ygg-btn{display:inline-flex;align-items:center;gap:.4rem;border-radius:var(--radius);padding:.5rem .9rem;font-weight:600;font-size:.86rem;text-decoration:none;cursor:pointer;border:1px solid var(--line)}
  .ygg-btn-solid{background:var(--accent);color:var(--primary-foreground);border-color:transparent}
  .ygg-btn-outline{background:transparent;color:var(--fg)} .ygg-btn-sm{padding:.35rem .7rem;font-size:.8rem}
  .ygg-badge{display:inline-flex;align-items:center;padding:.18rem .5rem;border-radius:999px;border:1px solid var(--line);background:color-mix(in srgb,var(--fg) 5%,transparent);font-size:.72rem;color:var(--fg-soft)}
  .shell{display:flex;align-items:flex-start;min-height:100vh}
  /* shell.css constrains nav icons in-app; mirror it so the harness is honest */
  .ygg-nav-group{display:flex;flex-direction:column;gap:.15rem}
  .ygg-nav-group-label{margin:0 0 .35rem;padding:0 .6rem;font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--fg-dim)}
  .ygg-nav-link{display:flex;align-items:center;gap:.65rem;padding:.55rem .6rem;border-radius:.55rem;color:var(--fg-soft);font-size:.92rem;text-decoration:none}
  .ygg-nav-link[data-active="true"]{box-shadow:inset 2px 0 0 var(--accent);color:var(--fg)}
  .ygg-nav-link svg{width:1.05rem;height:1.05rem;opacity:.85;flex:0 0 auto}</style></head>
<body><div class="shell">${SIDEBAR}<main class="fleet forge-room is-house" style="flex:1;margin:0;width:100%">${body}</main></div></body></html>`;
}

mkdirSync(outDir, { recursive: true });
const htmlOnly = process.argv.includes("--html");
const chrome =
  process.env.LITR_CHROME ||
  [
    resolve(process.env.HOME || "", ".cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell"),
  ].find((p) => existsSync(p));

const jobs = [];
for (const [state, body] of Object.entries(SAMPLES)) {
  for (const theme of ["dark", "light"]) {
    const html = page(theme, body);
    const htmlPath = resolve(outDir, `${state}-${theme}.html`);
    writeFileSync(htmlPath, html);
    jobs.push({ state, theme, htmlPath, pngPath: resolve(outDir, `${state}-${theme}.png`) });
  }
}

if (htmlOnly || !chrome) {
  if (!chrome && !htmlOnly) console.warn("⚠ no chrome-headless-shell found — wrote HTML only. Set LITR_CHROME=…");
  console.log(`Wrote ${jobs.length} HTML files to ${outDir}`);
  process.exit(0);
}

for (const j of jobs) {
  execFileSync(chrome, [
    "--headless", "--no-sandbox", "--hide-scrollbars",
    "--window-size=1280,1700",
    "--virtual-time-budget=4000", // MANDATORY: advance past the longest entrance
    "--default-background-color=00000000",
    `--screenshot=${j.pngPath}`,
    pathToFileURL(j.htmlPath).href,
  ], { stdio: "ignore" });
  console.log(`✓ ${j.state}-${j.theme}.png`);
}
console.log(`\nDone — ${jobs.length} shots in ${outDir}`);
