/**
 * The ranked repo map (ADR 0027 §4.2) — Aider's repo-map technique ported to
 * our stack, replacing the cheap `git ls-files` histogram in apps/forge.
 *
 * The idea (from Aider): instead of shipping the LLM a raw file tree, ship the
 * repo's *interface* — every file's exported symbols with one-line signatures —
 * ordered by how central each file is in the import graph. Centrality is plain
 * PageRank over "b.ts imports a.ts" edges: a file imported by many important
 * files ranks high, so under a char budget the model always sees the load-
 * bearing modules first and the leaf pages last.
 *
 * The fleet is TypeScript/Next-heavy, so the parser is the TypeScript compiler
 * API itself in syntax-only mode (`ts.createSourceFile`, no type checker, no
 * program) — fast, and per NORTH-STAR §9(8) "adopt OSS below the loop": zero
 * new parser dependencies, `typescript` is the one dep and it parses
 * .ts/.tsx/.js/.jsx alike.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", "vendor", ".next"]);
const MAX_FILE_BYTES = 400 * 1024;
const MAX_LINE = 110;
const MAX_CLASS_METHODS = 8;
const DAMPING = 0.85;
const ITERATIONS = 20;

export interface RepoMapOptions {
  /** Output budget in characters (default 8000). Cut at a file boundary. */
  maxChars?: number;
  /** Max code files parsed (default 2000). */
  maxFiles?: number;
}

export interface FileSymbols {
  /** One-line renderings of the file's exported symbols. */
  symbols: string[];
  /** Raw import/re-export specifiers found at the top level. */
  imports: string[];
}

// ── tree walk ────────────────────────────────────────────────────────────────

/** Top-level `.gitignore` parse, trivially: bare directory names only. */
function gitignoreDirs(rootDir: string): Set<string> {
  const out = new Set<string>();
  try {
    for (const raw of readFileSync(join(rootDir, ".gitignore"), "utf8").split("\n")) {
      const line = raw.trim().replace(/\/$/, "");
      if (line && /^[\w.-]+$/.test(line) && !line.startsWith("#")) out.add(line);
    }
  } catch {
    // No .gitignore — the fixed skip list is enough.
  }
  return out;
}

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i);
}

/** Collect repo-relative (posix) paths of code files, bounded by maxFiles. */
function walk(rootDir: string, maxFiles: number): string[] {
  const ignored = gitignoreDirs(rootDir);
  const files: string[] = [];
  const stack = [""];
  while (stack.length && files.length < maxFiles) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(join(rootDir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name) || ignored.has(e.name)) continue;
        stack.push(childRel);
      } else if (e.isFile() && CODE_EXTS.has(ext(e.name))) {
        if (files.length >= maxFiles) break;
        try {
          if (statSync(join(rootDir, childRel)).size > MAX_FILE_BYTES) continue;
        } catch {
          continue;
        }
        files.push(childRel);
      }
    }
  }
  return files;
}

// ── symbol + import extraction (syntax-only TS compiler API) ────────────────

function clean(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > MAX_LINE ? `${s.slice(0, MAX_LINE - 1)}…` : s;
}

function hasMod(node: ts.HasModifiers, kind: ts.SyntaxKind): boolean {
  return ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false;
}

function params(node: ts.SignatureDeclarationBase, sf: ts.SourceFile): string {
  return node.parameters.map((p) => p.getText(sf)).join(", ");
}

function fnLine(node: ts.FunctionDeclaration, sf: ts.SourceFile): string {
  const isDefault = hasMod(node, ts.SyntaxKind.DefaultKeyword);
  const name = node.name?.text ?? "";
  const ret = node.type ? `: ${node.type.getText(sf)}` : "";
  return clean(`export ${isDefault ? "default " : ""}function ${name}(${params(node, sf)})${ret}`);
}

function classLine(node: ts.ClassDeclaration, sf: ts.SourceFile): string {
  const isDefault = hasMod(node, ts.SyntaxKind.DefaultKeyword);
  const heritage = node.heritageClauses?.map((h) => h.getText(sf)).join(" ") ?? "";
  const methods: string[] = [];
  for (const m of node.members) {
    if (!ts.isMethodDeclaration(m) || !ts.isIdentifier(m.name)) continue;
    const kinds = ts.getModifiers(m)?.map((mod) => mod.kind) ?? [];
    if (kinds.includes(ts.SyntaxKind.PrivateKeyword) || kinds.includes(ts.SyntaxKind.ProtectedKeyword)) continue;
    if (methods.length >= MAX_CLASS_METHODS) {
      methods.push("…");
      break;
    }
    methods.push(`${m.name.text}()`);
  }
  const body = methods.length ? ` { ${methods.join(", ")} }` : "";
  return clean(
    `export ${isDefault ? "default " : ""}class ${node.name?.text ?? ""}${heritage ? ` ${heritage}` : ""}${body}`,
  );
}

function constLines(node: ts.VariableStatement, sf: ts.SourceFile): string[] {
  const keyword = node.declarationList.flags & ts.NodeFlags.Let ? "let" : "const";
  return node.declarationList.declarations.map((d) => {
    const name = d.name.getText(sf);
    const init = d.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
      const ret = init.type ? `: ${init.type.getText(sf)}` : "";
      return clean(`export ${keyword} ${name} = (${params(init, sf)}) =>${ret ? ret : " …"}`);
    }
    const type = d.type ? `: ${d.type.getText(sf)}` : "";
    return clean(`export ${keyword} ${name}${type}`);
  });
}

/**
 * Parse one source text (no type checker, no filesystem) and pull out the
 * exported surface plus the top-level import specifiers. Exported for tests.
 */
export function extractSymbols(sourceText: string, fileName: string): FileSymbols {
  const kind =
    ext(fileName) === ".tsx" ? ts.ScriptKind.TSX : ext(fileName) === ".jsx" ? ts.ScriptKind.JSX : undefined;
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false, kind);
  const symbols: string[] = [];
  const imports: string[] = [];

  for (const node of sf.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
      continue;
    }
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        const names = node.exportClause.elements.map((e) => e.name.text);
        symbols.push(clean(`export { ${names.join(", ")} }`));
      } else if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        symbols.push(clean(`export * from "${node.moduleSpecifier.text}"`));
      }
      continue;
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const expr = ts.isIdentifier(node.expression) ? node.expression.text : node.expression.getText(sf);
      symbols.push(clean(`export default ${expr}`));
      continue;
    }
    if (!ts.canHaveModifiers(node) || !hasMod(node, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(node)) symbols.push(fnLine(node, sf));
    else if (ts.isClassDeclaration(node)) symbols.push(classLine(node, sf));
    else if (ts.isInterfaceDeclaration(node)) symbols.push(clean(`export interface ${node.name.text}`));
    else if (ts.isTypeAliasDeclaration(node)) symbols.push(clean(`export type ${node.name.text}`));
    else if (ts.isEnumDeclaration(node)) symbols.push(clean(`export enum ${node.name.text}`));
    else if (ts.isVariableStatement(node)) symbols.push(...constLines(node, sf));
  }
  return { symbols, imports };
}

// ── import graph ────────────────────────────────────────────────────────────

/** Join + normalize a relative specifier against a repo-relative posix dir. */
function joinPosix(dir: string, spec: string): string | null {
  const parts = dir ? dir.split("/") : [];
  for (const seg of spec.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null; // escapes the repo
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

/** Resolve a relative import to one of the walked files, or null. */
function resolveImport(fromFile: string, spec: string, known: Set<string>): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null; // bare package import
  const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
  const base = joinPosix(dir, spec);
  if (base === null) return null;
  const candidates = [base];
  // NodeNext-style `./x.js` specifiers point at `./x.ts(x)` on disk.
  const m = /\.(m|c)?jsx?$/.exec(base);
  if (m) {
    const stem = base.slice(0, base.length - m[0].length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`);
  }
  for (const e of CODE_EXTS) candidates.push(`${base}${e}`);
  for (const e of CODE_EXTS) candidates.push(`${base}/index${e}`);
  for (const c of candidates) if (known.has(c)) return c;
  return null;
}

/**
 * PageRank (damping 0.85, 20 iterations, uniform seed) over the file graph.
 * `edges` maps importer → imported files. Nodes with exports but no inbound
 * edges keep the base (1−d)/N rank, so they still appear — just last.
 * Exported for tests.
 */
export function rankGraph(edges: Map<string, string[]>, nodes: string[]): Map<string, number> {
  const n = nodes.length;
  if (n === 0) return new Map();
  const index = new Map(nodes.map((f, i) => [f, i]));
  const out: number[][] = nodes.map(() => []);
  for (const [from, tos] of edges) {
    const fi = index.get(from);
    if (fi === undefined) continue;
    for (const to of new Set(tos)) {
      const ti = index.get(to);
      if (ti !== undefined && ti !== fi) out[fi].push(ti);
    }
  }
  let rank = new Array<number>(n).fill(1 / n);
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const next = new Array<number>(n).fill((1 - DAMPING) / n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (out[i].length === 0) {
        dangling += rank[i];
        continue;
      }
      const share = (DAMPING * rank[i]) / out[i].length;
      for (const t of out[i]) next[t] += share;
    }
    for (let i = 0; i < n; i++) next[i] += (DAMPING * dangling) / n;
    rank = next;
  }
  return new Map(nodes.map((f, i) => [f, rank[i]]));
}

// ── build + serialize ───────────────────────────────────────────────────────

/**
 * Build the prompt-ready ranked repo map. Never throws — unreadable files are
 * skipped; an empty/absent tree yields "".
 */
export function buildRepoMap(rootDir: string, opts: RepoMapOptions = {}): string {
  const maxChars = opts.maxChars ?? 8_000;
  const files = walk(rootDir, opts.maxFiles ?? 2_000);
  if (!files.length) return "";

  const known = new Set(files);
  const symbolsByFile = new Map<string, string[]>();
  const edges = new Map<string, string[]>();
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(rootDir, file), "utf8");
    } catch {
      continue;
    }
    const { symbols, imports } = extractSymbols(text, file);
    if (symbols.length) symbolsByFile.set(file, symbols);
    const resolved = imports
      .map((s) => resolveImport(file, s, known))
      .filter((t): t is string => t !== null);
    if (resolved.length) edges.set(file, resolved);
  }

  const rank = rankGraph(edges, files);
  const ranked = [...symbolsByFile.keys()].sort(
    (a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0) || a.localeCompare(b),
  );
  if (!ranked.length) return "";

  const header = `# Repo map · ${ranked.length} code files with exports, ranked by import centrality`;
  const blocks = ranked.map((f) => `${f}:\n${symbolsByFile.get(f)!.map((s) => `  ${s}`).join("\n")}`);
  let outText = header;
  let included = 0;
  for (let i = 0; i < blocks.length; i++) {
    const candidate = `${outText}\n\n${blocks[i]}`;
    // Reserve room for the trailer unless this is the final block.
    const reserve = i === blocks.length - 1 ? 0 : 26;
    if (candidate.length + reserve > maxChars) break;
    outText = candidate;
    included++;
  }
  const omitted = ranked.length - included;
  return omitted > 0 ? `${outText}\n\n… (+${omitted} more files)` : outText;
}
