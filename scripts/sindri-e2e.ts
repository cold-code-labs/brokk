#!/usr/bin/env tsx
// ─────────────────────────────────────────────────────────────────────────────
// Sindri E2E — drives the WHOLE chain against a running Brokk stack and asserts,
// all the way to a LIVE preview:
//
//   projects  → create session → stream a real turn (tool-use + done)
//             → boot preview → poll until `live` → HTTP-GET the preview URL
//
// It talks only HTTP to the public `/api` surface (same as the browser), so it
// validates the web→api→chat proxy, the gateway turn, the forge preview
// supervisor and the `*.preview.coldcodelabs.com` ingress — end to end.
//
// Usage (from the repo root):
//   pnpm dlx tsx scripts/sindri-e2e.ts [projectName]
//   BROKK_E2E_BASE=https://brokk.preview.coldcodelabs.com \
//     pnpm dlx tsx scripts/sindri-e2e.ts asgard
//
// Env / flags:
//   BROKK_E2E_BASE   origin serving /api (default the dev lane)
//   BROKK_E2E_MODEL  haiku|sonnet|opus (default haiku — cheap/fast)
//   BROKK_E2E_EFFORT low|medium|high   (default low)
//   --keep           don't delete the session/preview at the end
//   --no-preview     stop after the chat turn (skip the preview boot)
//
// Exit: 0 = all green · 1 = a step failed · 2 = misconfigured (project/base).
// NB: a preview can only go LIVE for a repo that is a bootable Next app at its
// root. A spec/docs repo (e.g. cold-code-labs/asgard) will reach `failed` — the
// harness reports that honestly rather than hanging.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = (process.env.BROKK_E2E_BASE || "https://brokk.preview.coldcodelabs.com").replace(/\/$/, "");
const PROJECT = process.argv.slice(2).find((a) => !a.startsWith("-")) || "asgard";
const MODEL = process.env.BROKK_E2E_MODEL || "haiku";
const EFFORT = process.env.BROKK_E2E_EFFORT || "low";
const KEEP = process.argv.includes("--keep");
const SKIP_PREVIEW = process.argv.includes("--no-preview");

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const TURN_TIMEOUT_MS = 240_000;
const PREVIEW_TIMEOUT_MS = 240_000;

let failures = 0;
const t0 = Date.now();
const ms = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)}s`;
function step(ok: boolean, label: string, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
}
function die(code: number, msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(code);
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "user-agent": UA, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return (await res.json()) as T;
}

// Consume the turn SSE, collecting which event types we saw + any error.
type Seen = { tools: string[]; sawEdit: boolean; gotMessage: boolean; done: boolean; error: string | null };
async function streamTurn(sessionId: string, text: string): Promise<Seen> {
  const seen: Seen = { tools: [], sawEdit: false, gotMessage: false, done: false, error: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TURN_TIMEOUT_MS);
  const EDIT = /write|edit|str_replace|create|apply|patch/i;
  try {
    const res = await fetch(`${BASE}/api/chat/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`messages → ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
        if (!data) continue;
        let e: { type: string; name?: string; message?: string; phase?: string };
        try { e = JSON.parse(data); } catch { continue; }
        if (e.type === "tool_use" && e.name) {
          seen.tools.push(e.name);
          if (EDIT.test(e.name)) seen.sawEdit = true;
          process.stdout.write(`     · tool: ${e.name}\n`);
        } else if (e.type === "message") seen.gotMessage = true;
        else if (e.type === "status" && e.phase) process.stdout.write(`     · ${e.phase}\n`);
        else if (e.type === "error") seen.error = e.message ?? "unknown";
        else if (e.type === "done") { seen.done = true; return seen; }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return seen;
}

interface Preview { id: string; url: string; status: "starting" | "live" | "stopped" | "failed" }

async function pollPreview(sessionId: string): Promise<Preview | null> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < PREVIEW_TIMEOUT_MS) {
    const { preview } = await api<{ preview: Preview | null }>("GET", `/api/chat/sessions/${sessionId}/preview`);
    const s = preview?.status ?? "(none)";
    if (s !== last) { process.stdout.write(`     · preview: ${s} (${ms(start)})\n`); last = s; }
    if (preview && (preview.status === "live" || preview.status === "failed" || preview.status === "stopped")) return preview;
    await new Promise((r) => setTimeout(r, 4000));
  }
  return null;
}

// ── run ──────────────────────────────────────────────────────────────────────
console.log(`\n🔨 Sindri E2E`);
console.log(`   base:    ${BASE}`);
console.log(`   project: ${PROJECT}   model: ${MODEL}   effort: ${EFFORT}\n`);

// 1) resolve project
let projects: { id: string; name: string }[];
try { projects = await api("GET", "/api/projects"); }
catch (e) { die(2, `GET /api/projects failed: ${(e as Error).message}`); }
const project = projects.find((p) => p.name.toLowerCase() === PROJECT.toLowerCase());
if (!project) die(2, `project "${PROJECT}" not found. Have: ${projects.map((p) => p.name).join(", ")}`);
step(true, `project resolved`, `${project.name} (${project.id.slice(0, 8)})`);

// 2) create session
let session: { id: string; branch: string | null };
try { session = (await api<{ session: typeof session }>("POST", "/api/chat/sessions", { projectId: project.id, model: MODEL, effort: EFFORT })).session; }
catch (e) { die(1, `create session failed: ${(e as Error).message}`); }
step(true, `session created`, session.id.slice(0, 8));

// 3) stream a real turn that makes a renderable edit
const tTurn = Date.now();
const prompt = "Crie (ou sobrescreva) um arquivo chamado SINDRI_E2E.md na raiz do projeto com exatamente o conteúdo: \"sindri e2e ok\". Faça apenas isso, sem mais nada.";
const seen = await streamTurn(session.id, prompt);
step(seen.done && !seen.error, `turn completed`, seen.error ? `error: ${seen.error}` : `${ms(tTurn)}, ${seen.tools.length} tool(s)`);
step(seen.gotMessage, `assistant message streamed`);
step(seen.sawEdit, `file-edit tool used`, seen.sawEdit ? seen.tools.find((t) => /write|edit|create|apply|patch|str_replace/i.test(t)) : "none seen");

// 4) preview: boot → poll → fetch
if (!SKIP_PREVIEW) {
  const tPv = Date.now();
  try { await api("POST", `/api/chat/sessions/${session.id}/preview`); }
  catch (e) { step(false, `preview boot requested`, (e as Error).message); }
  const pv = await pollPreview(session.id);
  if (!pv) step(false, `preview reached a terminal state`, `still pending after ${ms(tPv)}`);
  else if (pv.status === "live") {
    step(true, `preview LIVE`, `${ms(tPv)} → ${pv.url}`);
    // fetch the live URL (retry: next dev may still be compiling the first hit)
    let ok = false, code = 0, htmlish = false;
    for (let i = 0; i < 4 && !ok; i++) {
      try {
        const r = await fetch(pv.url, { headers: { "user-agent": UA } });
        code = r.status; const body = await r.text();
        htmlish = /<html|<!doctype|<div|__next/i.test(body);
        ok = r.ok && htmlish;
      } catch { /* retry */ }
      if (!ok) await new Promise((r) => setTimeout(r, 5000));
    }
    step(ok, `preview URL serves HTML`, `HTTP ${code}${htmlish ? ", html ✓" : ""}`);
  } else {
    step(false, `preview did not go live`, `status=${pv.status} (repo not a bootable Next app at root?)`);
  }
}

// 5) cleanup
if (!KEEP) {
  await api("DELETE", `/api/chat/sessions/${session.id}`).then(() => step(true, `cleanup (session deleted, preview reaped)`)).catch((e) => step(false, `cleanup`, (e as Error).message));
} else {
  console.log(`  · kept session ${session.id} (--keep)`);
}

console.log(`\n──────── ${failures === 0 ? "PASS" : "FAIL"} · ${ms(t0)} · ${failures} failure(s) ────────\n`);
process.exit(failures === 0 ? 0 : 1);
