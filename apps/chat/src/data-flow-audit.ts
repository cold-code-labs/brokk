/**
 * Static user-data-flow Discover + Audit — same job as
 * skills/user-data-flow/scripts/audit-static.mjs, callable from Sindri.
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export type DataFlowRoom = {
  id: string;
  route: string;
  kind: string;
  entity?: string;
  priority?: string;
  required?: string[];
  deferred?: string[];
  component?: string;
  linksTo?: string[];
  notes?: string;
};

export type DataFlowCatalog = {
  version: 1;
  fingerprint: string;
  discoveredAt: string;
  summary: string;
  rooms: DataFlowRoom[];
};

export type DataFlowResult = {
  id: string;
  kind: string;
  route?: string;
  verdict: "pass" | "fail" | "deferred" | "blocked" | "n/a";
  missing: string[];
  deferred: string[];
  note: string;
  file: string | null;
};

const VERB_PATTERNS: Record<string, RegExp> = {
  create: /\b(\+\s*)?(Novo|Nova|Adicionar|Criar|Cadastrar)\b|data-testid=["'][^"']*new/i,
  edit: /\bEditar\b|openEdit|setEditor/i,
  archive: /\bArquivar\b|archived\s*[:=]|is-archived/i,
  empty_cta: /empty-state|Nenhum .{0,40}[\s\S]{0,200}(Novo|Adicionar|\+)/i,
  move_stage: /\b(Avançar|Mover|estágio|stage)\b/i,
  create_card: /\+\s*(Lead|Card|Negócio|Job)\b/i,
  save_as_entity: /Salvar (proposta|orçamento|pedido)|saveProposal|save-proposal/i,
  status_transition: /status.*pago|setStatus|nextStatus|is-pago/i,
  study: /\bestudo\b|read-only|study/i,
};

const KIND_REQUIRED: Record<string, string[]> = {
  entity: ["create", "edit", "archive", "empty_cta"],
  pipeline: ["move_stage"],
  tool: [],
  ledger: [],
  study: ["study"],
  brand: [],
};

function read(root: string, rel: string): string | null {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return null;
  }
}

function loadCatalog(root: string): DataFlowCatalog | null {
  const raw = read(root, ".brokk/data-flow/catalog.json");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DataFlowCatalog;
  } catch {
    return null;
  }
}

function inferRooms(root: string): DataFlowRoom[] {
  const app = read(root, "src/App.tsx") || read(root, "src/App.jsx") || "";
  const rooms: DataFlowRoom[] = [];
  const re = /path="([^"]+)"\s+element=\{[^}]*<(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(app))) {
    const route = m[1]!;
    if (route === "*" || route === "/login") continue;
    const comp = m[2]!;
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
  const md = read(root, "docs/litr/rooms.md") || "";
  return rooms.map((r) => {
    const line = md.split("\n").find((l) => l.includes(`\`${r.route}\``));
    if (!line) return r;
    const kindHit = line.match(/\b(entity|pipeline|tool|ledger|study|brand|gate)\b/);
    if (!kindHit) return r;
    const kind = kindHit[1] === "gate" ? "brand" : kindHit[1]!;
    return { ...r, kind, required: KIND_REQUIRED[kind] || r.required };
  });
}

function findPage(root: string, room: DataFlowRoom): { rel: string | null; src: string | null } {
  const names = [
    room.component && `src/pages/${room.component}.tsx`,
    room.component && `src/pages/${room.component}.jsx`,
  ].filter(Boolean) as string[];
  for (const rel of names) {
    const src = read(root, rel);
    if (src) return { rel, src };
  }
  const dir = join(root, "src/pages");
  if (!existsSync(dir)) return { rel: null, src: null };
  for (const f of readdirSync(dir)) {
    if (!/\.tsx?$/.test(f)) continue;
    const rel = `src/pages/${f}`;
    const src = read(root, rel);
    if (!src) continue;
    if (room.component && f.replace(/\.\w+$/, "") === room.component) return { rel, src };
  }
  return { rel: null, src: null };
}

function auditRoom(root: string, room: DataFlowRoom): DataFlowResult {
  const required = room.required || KIND_REQUIRED[room.kind] || [];
  const { rel, src } = findPage(root, room);
  if (!src) {
    return {
      id: room.id,
      kind: room.kind,
      route: room.route,
      verdict: "blocked",
      missing: [...required],
      deferred: [],
      note: "page source not found",
      file: null,
    };
  }
  const missing: string[] = [];
  const deferredHit: string[] = [];
  const deferredSet = new Set(room.deferred || []);
  for (const verb of required) {
    const pat = VERB_PATTERNS[verb];
    if (!pat) continue;
    if (pat.test(src)) continue;
    if (deferredSet.has(verb)) deferredHit.push(verb);
    else missing.push(verb);
  }
  let verdict: DataFlowResult["verdict"] = "pass";
  if (missing.length) verdict = "fail";
  else if (deferredHit.length) verdict = "deferred";
  if (room.kind === "study" && /estudo|study/i.test(src) && !missing.length) {
    verdict = deferredHit.length ? "deferred" : "pass";
  }
  return {
    id: room.id,
    kind: room.kind,
    route: room.route,
    verdict,
    missing,
    deferred: deferredHit,
    note: missing.length
      ? `missing: ${missing.join(", ")}`
      : deferredHit.length
        ? `deferred: ${deferredHit.join(", ")}`
        : "ok",
    file: rel,
  };
}

function fingerprintOf(rooms: DataFlowRoom[]): string {
  const payload = rooms.map((r) => `${r.id}|${r.kind}|${(r.required || []).join(",")}`).join(";");
  return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}

export function runDataFlowAudit(root: string): {
  catalog: DataFlowCatalog;
  results: DataFlowResult[];
  reportMarkdown: string;
} {
  let catalog = loadCatalog(root);
  if (!catalog?.rooms?.length) {
    const rooms = inferRooms(root);
    catalog = {
      version: 1,
      fingerprint: fingerprintOf(rooms),
      discoveredAt: new Date().toISOString(),
      summary: "Inferred from App.tsx + docs/litr/rooms.md",
      rooms,
    };
  } else if (!catalog.fingerprint) {
    catalog = { ...catalog, fingerprint: fingerprintOf(catalog.rooms) };
  }

  const results = catalog.rooms.map((r) => auditRoom(root, r));
  const pass = results.filter((r) => r.verdict === "pass").length;
  const fail = results.filter((r) => r.verdict === "fail").length;
  const deferred = results.filter((r) => r.verdict === "deferred").length;
  const blocked = results.filter((r) => r.verdict === "blocked").length;

  const reportMarkdown = [
    `# Data-flow audit`,
    ``,
    `**${pass} pass · ${fail} fail · ${deferred} deferred · ${blocked} blocked**`,
    ``,
    `| id | kind | verdict | missing | deferred | file |`,
    `|---|---|---|---|---|---|`,
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.kind} | ${r.verdict} | ${r.missing.join(", ") || "—"} | ${r.deferred.join(", ") || "—"} | ${r.file || "—"} |`,
    ),
    ``,
  ].join("\n");

  const dir = join(root, ".brokk", "data-flow");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  writeFileSync(join(dir, "last-report.md"), reportMarkdown);

  return { catalog, results, reportMarkdown };
}
