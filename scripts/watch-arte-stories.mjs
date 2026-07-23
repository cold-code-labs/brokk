#!/usr/bin/env node
/**
 * Watch Arte One QA Stories until done (or max rounds).
 * Runs inside brokk-api container.
 */
const port = process.env.BROKK_API_PORT || "8789";
const secret = process.env.BROKK_API_SECRET;
const h = {
  Authorization: "Bearer " + secret,
  "x-brokk-is-staff": "1",
  "x-brokk-actor-email": "valvesss@coldcodelabs.com",
  "Content-Type": "application/json",
};
const base = "http://127.0.0.1:" + port;
const pid = "045c165b-03d8-4ba9-8d97-3968294814d4";
const maxMs = Number(process.env.WATCH_MS || 3 * 60 * 60 * 1000);
const every = Number(process.env.WATCH_EVERY_MS || 120_000);
const started = Date.now();

async function snap() {
  const plans = ((await (await fetch(base + "/plans?projectId=" + pid, { headers: h })).json()).plans || []).filter(
    (p) => p.storyModule,
  );
  const roll = {};
  for (const p of plans) {
    const k = p.status + "|val=" + (p.validationStatus ?? "null") + "|pr=" + (p.prUrl ? "yes" : "no");
    roll[k] = (roll[k] || 0) + 1;
  }
  console.log(new Date().toISOString(), "stories", plans.length, JSON.stringify(roll));
  for (const p of plans) {
    if (p.status === "done") continue;
    const d = await (await fetch(base + "/plans/" + p.id, { headers: h })).json();
    const st = {};
    for (const t of d.tasks || []) st[t.status] = (st[t.status] || 0) + 1;
    console.log(" ", p.storyModule, "plan=" + p.status, "val=" + p.validationStatus, JSON.stringify(st), p.prUrl || "");
    if (p.validationStatus === "pass" && !p.prUrl) {
      const r = await fetch(base + "/plans/" + p.id + "/open-pr", { method: "POST", headers: h, body: "{}" });
      console.log("  open-pr", p.storyModule, r.status, (await r.text()).slice(0, 160));
    }
    if (p.status === "failed") {
      const failed = (d.tasks || []).filter((t) => t.status === "failed");
      if (failed.length) {
        const r = await fetch(base + "/plans/" + p.id + "/retry", { method: "POST", headers: h, body: "{}" });
        console.log("  re-retry", p.storyModule, r.status, (await r.text()).slice(0, 120));
      }
    }
  }
  return plans.every((p) => p.status === "done" && p.prUrl);
}

(async () => {
  while (Date.now() - started < maxMs) {
    try {
      if (await snap()) {
        console.log("ALL_DONE");
        process.exit(0);
      }
    } catch (e) {
      console.error("watch err", e);
    }
    await new Promise((r) => setTimeout(r, every));
  }
  console.log("TIMEOUT");
  process.exit(2);
})();
