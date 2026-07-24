#!/usr/bin/env node
/**
 * Static user-data-flow audit — varre rotas + pages sem browser.
 * Usage: node audit-static.mjs [checkoutRoot]
 *
 * Reads .brokk/data-flow/catalog.json when present; otherwise infers routes
 * from src/App.tsx (React Router) and docs/litr/rooms.md.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] || ".");
const VERB_PATTERNS = {
  create: /\b(\+\s*)?(Novo|Nova|Adicionar|Criar|Cadastrar)\b|rep-new|data-testid=["'][^"']*new/i,
  edit: /\bEditar\b|openEdit|setEditor/i,
  archive: /\bArquivar\b|archived\s*[:=]|is-archived/i,
  empty_cta: /empty-state|rep-empty|Nenhum .{0,40}\n[\s\S]{0,200}(Novo|Adicionar)/i,
  move_stage: /\b(Avançar|Mover|estágio|stage)\b/i,
  create_card: /\+\s*(Lead|Card|Negócio|Job)\b/i,
  save_as_entity: /Salvar (proposta|orçamento|pedido)|saveProposal/i,
  status_transition: /status.*pago|setStatus|is-pago/i,
  study: /\bestudo\b|read-only|study/i,
};

const KIND_REQUIRED = {
  entity: ["create", "edit", "archive", "empty_cta"],
  pipeline: ["move_stage"],
  tool: [],
  ledger: [],
  study: ["study"],
  brand: [],
};

function read(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function loadCatalog() {
  const raw = read(path.join(root, ".brokk/data-flow/catalog.json"));
  if (!raw) return null;
  return JSON.parse(raw);
}

function inferRoomsFromApp() {
  const app = read(path.join(root, "src/App.tsx")) || read(path.join(root, "src/App.jsx"));
  if (!app) return [];
  const rooms = [];
  const re = /path="([^"]+)"\s+element=\{[^}]*<(\w+)/g;
  let m;
  while ((m = re.exec(app))) {
    const route = m[1];
    if (route === "*" || route === "/login") continue;
    const comp = m[2];
    rooms.push({
      id: route === "/" ? "landing" : route.replace(/^\//, "").replace(/\//g, "-"),
      route,
      kind: "entity",
      entity: comp,
      priority: "p1",
      required: KIND_REQUIRED.entity,
      component: comp,
    });
  }
  return rooms;
}

function enrichKindFromRoomsMd(rooms) {
  const md = read(path.join(root, "docs/litr/rooms.md"));
  if (!md) return rooms;
  return rooms.map((r) => {
    const line = md.split("\n").find((l) => l.includes(`\`${r.route}\``) || l.includes(`| ${r.route} |`));
    if (!line) return r;
    const kindHit = line.match(/\b(entity|pipeline|tool|ledger|study|brand|gate)\b/);
    if (kindHit) {
      const kind = kindHit[1] === "gate" ? "brand" : kindHit[1];
      return { ...r, kind, required: KIND_REQUIRED[kind] || r.required };
    }
    return r;
  });
}

function findPageSource(room) {
  const candidates = [
    room.component && `src/pages/${room.component}.tsx`,
    room.component && `src/pages/${room.component}.jsx`,
    `src/pages/${cap(room.id)}.tsx`,
    `src/pages/${cap(room.id)}.jsx`,
  ].filter(Boolean);
  for (const rel of candidates) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) return { rel, src: read(full) };
  }
  // glob pages
  const dir = path.join(root, "src/pages");
  if (!fs.existsSync(dir)) return { rel: null, src: null };
  for (const f of fs.readdirSync(dir)) {
    if (!/\.tsx?$/.test(f)) continue;
    const src = read(path.join(dir, f));
    if (src && room.route !== "/" && src.includes(room.route)) {
      return { rel: `src/pages/${f}`, src };
    }
    if (room.component && f.replace(/\.\w+$/, "") === room.component) {
      return { rel: `src/pages/${f}`, src };
    }
  }
  return { rel: null, src: null };
}

function cap(s) {
  return s
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

function auditRoom(room) {
  const { rel, src } = findPageSource(room);
  const required = room.required || KIND_REQUIRED[room.kind] || [];
  if (!src) {
    return {
      id: room.id,
      kind: room.kind,
      verdict: "blocked",
      missing: required,
      note: "page source not found",
      file: null,
    };
  }
  const missing = [];
  const deferredHit = [];
  const present = [];
  const deferredSet = new Set(room.deferred || []);
  for (const verb of required) {
    const pat = VERB_PATTERNS[verb];
    if (!pat) continue;
    if (pat.test(src)) present.push(verb);
    else if (deferredSet.has(verb)) deferredHit.push(verb);
    else missing.push(verb);
  }
  let verdict = "pass";
  if (missing.length) verdict = "fail";
  else if (deferredHit.length) verdict = "deferred";
  if (room.kind === "study" && present.includes("study") && !missing.length) {
    verdict = deferredHit.length ? "deferred" : "pass";
  }
  return {
    id: room.id,
    kind: room.kind,
    route: room.route,
    verdict,
    missing,
    deferred: deferredHit,
    present,
    note: missing.length
      ? `missing: ${missing.join(", ")}`
      : deferredHit.length
        ? `deferred: ${deferredHit.join(", ")}`
        : "ok",
    file: rel,
  };
}

function main() {
  let catalog = loadCatalog();
  let rooms;
  if (catalog?.rooms?.length) {
    rooms = catalog.rooms;
  } else {
    rooms = enrichKindFromRoomsMd(inferRoomsFromApp());
    catalog = {
      version: 1,
      fingerprint: "inferred",
      discoveredAt: new Date().toISOString(),
      summary: "Inferred from App.tsx + rooms.md (no catalog.json yet)",
      rooms,
    };
  }

  const results = rooms.map(auditRoom);
  const pass = results.filter((r) => r.verdict === "pass").length;
  const fail = results.filter((r) => r.verdict === "fail").length;
  const deferred = results.filter((r) => r.verdict === "deferred").length;
  const blocked = results.filter((r) => r.verdict === "blocked").length;

  const reportDir = path.join(root, ".brokk/data-flow");
  fs.mkdirSync(reportDir, { recursive: true });
  if (!fs.existsSync(path.join(reportDir, "catalog.json"))) {
    fs.writeFileSync(path.join(reportDir, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
  }

  const lines = [
    `# Data-flow audit (static)`,
    ``,
    `**${pass} pass · ${fail} fail · ${deferred} deferred · ${blocked} blocked**`,
    ``,
    `| id | kind | verdict | missing | deferred | file |`,
    `|---|---|---|---|---|---|`,
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.kind} | ${r.verdict} | ${(r.missing || []).join(", ") || "—"} | ${(r.deferred || []).join(", ") || "—"} | ${r.file || "—"} |`,
    ),
    ``,
  ];
  fs.writeFileSync(path.join(reportDir, "last-report.md"), lines.join("\n"));

  console.log(lines.join("\n"));
  process.exit(fail || blocked ? 1 : 0);
}

main();
