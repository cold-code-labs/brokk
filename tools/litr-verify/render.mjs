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

// ── canonical states (mirror of FleetView markup) ───────────────────────────
const HERO = (running) => `
<header class="fleet-hero">
  <div class="fleet-aurora"></div><div class="fleet-grid"></div>
  <div class="fleet-hero-inner"><div>
    <span class="fleet-eyebrow">Brokk · the forge</span>
    <h1 class="fleet-title">Fleet</h1>
    <p class="fleet-subtitle">Every CCL repo, its queue, and the global forge — one board, live.</p>
    <span class="fleet-pulse${running ? "" : " is-quiet"}"><span class="fleet-ember"></span>${
      running ? `Forging now · ${running} tasks in the fire` : "The forge is quiet"
    }</span>
  </div><a class="ygg-btn ygg-btn-solid">+ Connect repos</a></div>
</header>`;

const STATS = (r, q, pr) => `
<div class="fleet-stats">
  <div class="fleet-stat${r ? " is-live" : ""}"><div class="fleet-stat-num">${r}</div><div class="fleet-stat-label">${
    r ? '<span class="fleet-stat-dot"></span>' : ""
  }Running now</div><span class="fleet-stat-spark"></span></div>
  <div class="fleet-stat"><div class="fleet-stat-num">${q}</div><div class="fleet-stat-label">Queued</div><span class="fleet-stat-spark"></span></div>
  <div class="fleet-stat${pr ? " is-live" : ""}"><div class="fleet-stat-num">${pr}</div><div class="fleet-stat-label">${
    pr ? '<span class="fleet-stat-dot"></span>' : ""
  }In review · PR</div><span class="fleet-stat-spark"></span></div>
  <div class="fleet-stat"><div class="fleet-stat-num">2</div><div class="fleet-stat-label">Max seats</div><span class="fleet-stat-spark"></span></div>
</div>`;

const COMPOSER = `
<form class="fleet-composer">
  <div class="fleet-pick"><select><option>heimdall</option></select></div>
  <input class="fleet-ask" placeholder="Describe a task and queue it to the forge…">
  <button type="button" class="fleet-send" disabled>Queue →</button>
</form>`;

const SECTION_H = (title, meta) =>
  `<div class="fleet-h"><span class="fleet-h-title">${title}</span><span class="fleet-h-meta">${meta}</span><span class="fleet-h-rule"></span></div>`;

const CARD = (name, repo, running, badges) => `
<div class="fleet-card${running ? " is-running" : ""}"><span class="fleet-card-rail"></span>
  <div class="fleet-card-head"><span class="fleet-card-name">${name}</span>${
    running
      ? `<span class="fleet-card-state running"><span class="fleet-run-dot"></span>${running} running</span>`
      : '<span class="fleet-card-state idle">idle</span>'
  }</div>
  <p class="fleet-card-repo">${repo}</p>
  <div class="fleet-card-badges">${badges
    .map((b) => `<span class="ygg-badge">${b}</span>`)
    .join("")}</div>
  <div class="fleet-card-foot"><a class="ygg-btn ygg-btn-outline ygg-btn-sm">Preview dev</a></div>
</div>`;

const ROW = (title, repo, status, running) => `
<a class="fleet-row${running ? " is-running" : ""}"><span class="fleet-row-dot" style="background:var(--accent)"></span>
  <span class="fleet-row-title">${title}</span><span class="fleet-row-repo">${repo}</span>
  <span class="fleet-row-status">${status}</span></a>`;

const EMPTY_QUEUE = `
<div class="fleet-empty"><span class="fleet-empty-mark">${FLAME}</span>
  <span class="fleet-empty-title">The forge is quiet</span>
  <p class="fleet-empty-sub">Queued and running tasks line up here, next-up first. Describe a task above to light it.</p></div>`;

const EMPTY_REPOS = `
<div class="fleet-empty is-panel"><span class="fleet-empty-mark">${FOLDER}</span>
  <span class="fleet-empty-title">No repos at the forge yet</span>
  <p class="fleet-empty-sub">Connect a repository and Brokk can pick up tasks, open PRs, and forge previews for it.</p>
  <span class="fleet-empty-action"><a class="ygg-btn ygg-btn-solid">+ Connect a repo</a></span></div>`;

const SAMPLES = {
  // The everyday board: live work in the fire.
  populated: `
    ${HERO(2)}${STATS(2, 3, 1)}${COMPOSER}
    <section style="margin-bottom:2.4rem">${SECTION_H("Projects", "3")}
      <div class="fleet-cards">
        ${CARD("heimdall", "cold-code-labs/heimdall · surtr", 2, ["4 backlog", "3 queued", "1 PR"])}
        ${CARD("hauldr", "cold-code-labs/hauldr · main", 0, ["2 backlog", "0 queued", "0 PR"])}
        <a class="fleet-card is-add">+ Connect a repo</a>
      </div></section>
    <section>${SECTION_H("Global queue", "next up across the fleet")}
      <div class="fleet-queue">
        ${ROW("Wire startRun facade into Huginn", "heimdall", "running", 1)}
        ${ROW("Fleet empty-state polish", "brokk", "queued", 0)}
      </div></section>`,
  // Both new zero states, on one page.
  empty: `
    ${HERO(0)}${STATS(0, 0, 0)}${COMPOSER}
    <section style="margin-bottom:2.4rem">${SECTION_H("Projects", "0")}${EMPTY_REPOS}</section>
    <section>${SECTION_H("Global queue", "next up across the fleet")}
      <div class="fleet-queue">${EMPTY_QUEUE}</div></section>`,
};

// Mini sidebar so the nav polish verifies in the same frame.
const SIDEBAR = `
<aside class="ygg-nav" style="width:220px;flex:0 0 auto;padding:1rem .5rem;border-right:1px solid var(--line)">
  <div class="ygg-nav-group"><div class="ygg-nav-group-label">Forge</div>
    <a class="ygg-nav-link" data-active="true">${FOLDER}Fleet</a>
    <a class="ygg-nav-link">${FLAME}Dashboard</a>
    <a class="ygg-nav-link">${FLAME}Mímir</a>
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
<body><div class="shell">${SIDEBAR}<main class="fleet" style="flex:1;max-width:74rem;margin:0 auto;padding:1.6rem 1.5rem 4rem">${body}</main></div></body></html>`;
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
