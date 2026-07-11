// Deterministic pre-heal bench (#2). Proves the autofix pass resolves a real
// compiler "Did you mean" error WITHOUT a model heal, and unit-checks the
// parser/applier across the common tsc diagnostic shapes.
//
//   node --experimental-transform-types scripts/autofix-bench.ts
//
// Exit 0 = the deterministic pass fixed a red tsc verify to green + all unit
// asserts pass. The headline number is "model heal avoided" (0 model tokens vs a
// full forge pass, ~10–40× the latency).

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyTscSuggestions, parseTscSuggestions, makeAutofix } from "../apps/forge/src/autofix.ts";

const here = dirname(fileURLToPath(import.meta.url));
const TSC = join(here, "..", "node_modules", ".bin", "tsc");
let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  got=${JSON.stringify(got)}`}`);
  if (!cond) fail++;
};

// ── Unit: parser + applier across the common tsc diagnostic shapes ────────────
function unitCase(name: string, fileBody: string, diag: (f: string) => string, expectAfter: string) {
  const dir = mkdtempSync(join(tmpdir(), "afix-unit-"));
  const f = join(dir, "x.ts");
  writeFileSync(f, fileBody);
  const applied = applyTscSuggestions(parseTscSuggestions(diag(f), dir));
  const after = readFileSync(f, "utf8");
  ok(`${name} (applied=${applied})`, after === expectAfter, after);
  rmSync(dir, { recursive: true, force: true });
}

// TS2552 Cannot find name 'X'. Did you mean 'Y'?  (col points at usrName)
unitCase(
  "TS2552 name typo",
  `const userName = "a";\nconsole.log(usrName);\n`,
  (f) => `${f}(2,13): error TS2552: Cannot find name 'usrName'. Did you mean 'userName'?`,
  `const userName = "a";\nconsole.log(userName);\n`,
);
// TS2724 module has no exported member named 'X'. Did you mean 'Y'? (2nd quote wrong)
unitCase(
  "TS2724 exported member typo",
  `import { userNam } from "./u";\n`,
  (f) => `${f}(1,10): error TS2724: '"./u"' has no exported member named 'userNam'. Did you mean 'userName'?`,
  `import { userName } from "./u";\n`,
);
// NEGATIVE: col points at a token tsc did NOT quote → must NOT edit.
unitCase(
  "negative: unquoted token untouched",
  `const foo = bar;\n`,
  (f) => `${f}(1,7): error TS2552: Cannot find name 'baz'. Did you mean 'qux'?`,
  `const foo = bar;\n`,
);

// ── End-to-end: real tsc red → autofix → real tsc green ───────────────────────
const proj = mkdtempSync(join(tmpdir(), "afix-e2e-"));
mkdirSync(join(proj, "src"), { recursive: true });
writeFileSync(join(proj, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "esnext", moduleResolution: "bundler", target: "es2022" }, include: ["src"] }));
writeFileSync(join(proj, "src", "util.ts"), `export const greeting = "hi";\n`);
// A typo the compiler will diagnose with "Did you mean 'greeting'?"
writeFileSync(join(proj, "src", "main.ts"), `import { greeting } from "./util.js";\nexport const out = gretting.toUpperCase();\n`);

function runTsc(): { ok: boolean; output: string } {
  try {
    const o = execFileSync(TSC, ["--noEmit", "-p", "tsconfig.json"], { cwd: proj, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output: o };
  } catch (e: any) {
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const before = runTsc();
ok("e2e: tsc starts RED (has a Did-you-mean error)", !before.ok && /Did you mean 'greeting'/.test(before.output), before.output.trim().split("\n")[0]);

const t0 = Date.now();
const fix = await makeAutofix({ cwd: proj })(before.output);
const fixMs = Date.now() - t0;
ok("e2e: autofix reports a change", fix.changed === true, fix);

const after = runTsc();
ok("e2e: tsc is GREEN after deterministic autofix (model heal AVOIDED)", after.ok, after.output.trim());
rmSync(proj, { recursive: true, force: true });

console.log(
  fail === 0
    ? `\nALL PASS — deterministic pre-heal resolved a red verify in ${fixMs}ms with 0 model tokens (a model heal = a full forge pass avoided).`
    : `\n${fail} FAIL`,
);
process.exit(fail ? 1 : 0);
