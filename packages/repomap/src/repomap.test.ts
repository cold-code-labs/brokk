/**
 * Regression suite for the ranked repo map. Builds a real fixture tree in a
 * tmp dir (a.ts imported by b.ts and c.tsx, plus an orphan and a node_modules
 * decoy) and asserts ranking, symbol extraction, truncation, and skip rules.
 * Run: `pnpm --filter @brokk/repomap test`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { buildRepoMap, extractSymbols, rankGraph } from "./index.js";

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "repomap-"));
  const files: Record<string, string> = {
    "a.ts": [
      `export function greet(name: string): string { return "hi " + name; }`,
      `export const VERSION = "1.0";`,
      `export interface Greeting { text: string; }`,
      `export type Mood = "happy" | "grumpy";`,
    ].join("\n"),
    "b.ts": [
      `import { greet } from "./a.js";`,
      `export class Runner {`,
      `  run() { return greet("b"); }`,
      `  stop(): void {}`,
      `  private hidden() {}`,
      `}`,
    ].join("\n"),
    "c.tsx": [
      `import { VERSION } from "./a";`,
      `export default function App() { return null; }`,
      `export const useThing = (id: string) => id + VERSION;`,
    ].join("\n"),
    "lib/orphan.ts": `export const lonely = 42;\nexport enum Shade { Light, Dark }`,
    "node_modules/junk/index.ts": `export function smuggled() {}`,
    "notes.md": `# not code`,
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const root = makeFixture();
after(() => rmSync(root, { recursive: true, force: true }));

test("ranks the widely-imported file above the orphan", () => {
  const map = buildRepoMap(root);
  const posA = map.indexOf("a.ts:");
  const posOrphan = map.indexOf("lib/orphan.ts:");
  assert.ok(posA >= 0, "a.ts listed");
  assert.ok(posOrphan >= 0, "orphan still appears (base rank)");
  assert.ok(posA < posOrphan, "a.ts (2 importers) ranks above the orphan");
});

test("extracts function/class/interface/type/const/default/enum symbols", () => {
  const map = buildRepoMap(root);
  assert.match(map, /export function greet\(name: string\): string/);
  assert.match(map, /export class Runner \{ run\(\), stop\(\) \}/);
  assert.ok(!map.includes("hidden"), "private methods omitted");
  assert.match(map, /export interface Greeting/);
  assert.match(map, /export type Mood/);
  assert.match(map, /export const VERSION/);
  assert.match(map, /export default function App\(\)/);
  assert.match(map, /export const useThing = \(id: string\) =>/);
  assert.match(map, /export enum Shade/);
});

test("skips node_modules and non-code files", () => {
  const map = buildRepoMap(root);
  assert.ok(!map.includes("smuggled"));
  assert.ok(!map.includes("node_modules"));
  assert.ok(!map.includes("notes.md"));
});

test("truncates at a file boundary within maxChars", () => {
  const map = buildRepoMap(root, { maxChars: 160 });
  assert.ok(map.length <= 160 + 30, `bounded output, got ${map.length}`);
  assert.match(map, /… \(\+\d+ more files\)$/);
  const full = buildRepoMap(root, { maxChars: 100_000 });
  assert.ok(!full.includes("more files"), "no trailer when everything fits");
});

test("extractSymbols works standalone on source text", () => {
  const { symbols, imports } = extractSymbols(
    `import x from "./x";\nimport pkg from "react";\nexport function f(a: number) {}\nexport default f;`,
    "t.ts",
  );
  assert.deepEqual(imports, ["./x", "react"]);
  assert.ok(symbols.includes("export function f(a: number)"));
  assert.ok(symbols.includes("export default f"));
});

test("rankGraph: imported node outranks orphan; ranks sum to ~1", () => {
  const nodes = ["a", "b", "c", "orphan"];
  const edges = new Map([
    ["b", ["a"]],
    ["c", ["a"]],
  ]);
  const rank = rankGraph(edges, nodes);
  assert.ok(rank.get("a")! > rank.get("orphan")!);
  const sum = [...rank.values()].reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `ranks sum to 1, got ${sum}`);
});
