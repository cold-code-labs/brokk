/**
 * BROKK-45 acceptance — Review→Done close loop is reachable on the API.
 *
 * Checks:
 *   1. /health is up
 *   2. POST /webhooks/github accepts pull_request closed+merged (unsigned when
 *      BROKK_GITHUB_WEBHOOK_SECRET is empty) and returns JSON with ok:true
 *   3. closed-without-merge does NOT claim a done status (status closed_unmerged)
 *
 * Env (injected by Brokk verify):
 *   BROKK_ACCEPTANCE_URL, BROKK_CHROMIUM, BROKK_ACCEPTANCE_SHOT
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const base = (process.env.BROKK_ACCEPTANCE_URL || "http://127.0.0.1:8789").replace(/\/$/, "");
const chromium = process.env.BROKK_CHROMIUM || "chromium";
const shot = process.env.BROKK_ACCEPTANCE_SHOT || "/tmp/brokk-acceptance.png";

function fail(msg) {
  console.error("ACCEPTANCE FAIL:", msg);
  process.exit(1);
}

async function main() {
  const health = await fetch(`${base}/health`);
  if (!health.ok) fail(`/health → ${health.status}`);
  const healthBody = await health.json();
  console.log("checked /health", healthBody);

  const mergedPayload = {
    action: "closed",
    repository: { full_name: "acme/acceptance" },
    pull_request: {
      number: 42,
      merged: true,
      html_url: "https://github.com/acme/acceptance/pull/42",
      body: "acceptance probe — no matching card expected",
    },
  };
  const mergedRes = await fetch(`${base}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
    },
    body: JSON.stringify(mergedPayload),
  });
  if (mergedRes.status === 401) {
    fail(
      "webhook rejected signature — acceptance expects empty BROKK_GITHUB_WEBHOOK_SECRET in verify",
    );
  }
  if (!mergedRes.ok) fail(`/webhooks/github merged → ${mergedRes.status}`);
  const mergedJson = await mergedRes.json();
  if (!mergedJson.ok) fail(`merged response not ok: ${JSON.stringify(mergedJson)}`);
  if (mergedJson.status !== "not_found" && mergedJson.status !== "done") {
    fail(`unexpected merged status: ${JSON.stringify(mergedJson)}`);
  }
  console.log("checked merged webhook →", mergedJson.status);

  const closedPayload = {
    action: "closed",
    repository: { full_name: "acme/acceptance" },
    pull_request: {
      number: 43,
      merged: false,
      html_url: "https://github.com/acme/acceptance/pull/43",
      body: "closed without merge",
    },
  };
  const closedRes = await fetch(`${base}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
    },
    body: JSON.stringify(closedPayload),
  });
  if (!closedRes.ok) fail(`/webhooks/github closed → ${closedRes.status}`);
  const closedJson = await closedRes.json();
  if (closedJson.status !== "closed_unmerged" && closedJson.status !== "ignored") {
    // applyMergedPr returns ignored when !merged; webhook maps to closed_unmerged
    fail(`closed-unmerged should not close a card: ${JSON.stringify(closedJson)}`);
  }
  console.log("checked closed-unmerged webhook →", closedJson.status);

  // Receipt screenshot of /health (API has no HTML UI).
  await new Promise((resolve, reject) => {
    const child = spawn(
      chromium,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        `--screenshot=${shot}`,
        "--window-size=800,600",
        `${base}/health`,
      ],
      { stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`chromium exit ${code}`))));
  });
  writeFileSync(shot.replace(/\.png$/, ".txt"), "brokk-45 webhook close loop ok\n");
  console.log("screenshot →", shot);
  console.log("ACCEPTANCE OK");
  process.exit(0);
}

main().catch((err) => fail(String(err?.stack || err)));
