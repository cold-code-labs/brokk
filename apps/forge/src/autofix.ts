// ─────────────────────────────────────────────────────────────────────────────
// Deterministic pre-heal (#2, the v0-autofixer lesson). v0/Lovable/Bolt front
// their expensive model with a cheap, deterministic corrector for the errors the
// model most often makes — a typo'd import member, a wrong identifier — 10–40×
// faster than re-running the model. Brokk's model heal (engine.ts) re-drives the
// whole conversation; this pass tries to make verify green BEFORE that, for free.
//
// It applies ONLY corrections the TypeScript compiler itself authored: tsc emits
// "Did you mean 'X'?" with a precise (line,col). We replace the identifier AT that
// column, and only when tsc quoted it in the message — a double guard so we can
// never rewrite the wrong token. Anything we can't resolve unambiguously we skip
// (a monorepo path we can't map, a non-identifier). The engine re-verifies after,
// so a mistaken edit can only fail to help — it can never mask a red verify.
//
// Optionally also runs a project fixer (BROKK_AUTOFIX_CMD, e.g. "pnpm lint --fix")
// which handles the eslint-autofixable class (unused imports, ordering).
// ─────────────────────────────────────────────────────────────────────────────

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AutofixResult } from "@brokk/core";

/** One applicable compiler suggestion, already resolved to a real file. */
export interface TscSuggestion {
  file: string; // absolute path
  line: number; // 1-based
  col: number; // 1-based
  suggestion: string; // the replacement tsc proposed
  quoted: string[]; // identifiers tsc quoted in the message (the apply-time guard)
}

// tsc diagnostic line: `path/to/file.ts(12,7): error TS2551: <message>`
// (pnpm may prefix the package name; we tolerate leading noise before the path).
const DIAG = /(?<file>(?:[A-Za-z]:)?[^\s()]+)\((?<line>\d+),(?<col>\d+)\):\s*error TS\d+:\s*(?<msg>.*)$/;
const IDENT = /^[A-Za-z_$][\w$]*$/;

/** Parse tsc output for applicable "Did you mean" suggestions, resolving each to
 *  a real file under `cwd`. Unresolvable / non-identifier suggestions are dropped. */
export function parseTscSuggestions(output: string, cwd: string): TscSuggestion[] {
  const out: TscSuggestion[] = [];
  for (const raw of output.split("\n")) {
    const m = DIAG.exec(raw);
    if (!m?.groups) continue;
    const msg = m.groups.msg!;
    const mean = /Did you mean '([^']+)'\?/.exec(msg);
    if (!mean) continue;
    const suggestion = mean[1]!;
    if (!IDENT.test(suggestion)) continue;
    const file = resolveFile(cwd, m.groups.file!);
    if (!file) continue;
    // The token we replace must be one tsc explicitly quoted (not the type name,
    // not the module path) AND a plain identifier — resolved against the file at
    // apply time. Carry the quoted set as the guard.
    const quoted = [...msg.matchAll(/'([^']+)'/g)].map((q) => q[1]!).filter((t) => IDENT.test(t));
    out.push({ file, line: Number(m.groups.line), col: Number(m.groups.col), suggestion, quoted });
  }
  return out;
}

function resolveFile(cwd: string, p: string): string | null {
  const candidates = isAbsolute(p) ? [p] : [join(cwd, p)];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** Apply the suggestions to disk. Returns how many were actually applied (an edit
 *  only lands when the identifier at (line,col) matches a tsc-quoted token). */
export function applyTscSuggestions(suggestions: TscSuggestion[]): number {
  const byFile = new Map<string, TscSuggestion[]>();
  for (const s of suggestions) {
    const arr = byFile.get(s.file) ?? [];
    arr.push(s);
    byFile.set(s.file, arr);
  }
  let applied = 0;
  for (const [file, edits] of byFile) {
    const lines = readFileSync(file, "utf8").split("\n");
    let touched = false;
    // Apply latest position first so earlier columns stay valid.
    edits.sort((a, b) => b.line - a.line || b.col - a.col);
    for (const e of edits) {
      const src = lines[e.line - 1];
      if (src === undefined) continue;
      const start = e.col - 1;
      const tok = /[A-Za-z_$][\w$]*/y;
      tok.lastIndex = start;
      const mm = tok.exec(src);
      if (!mm || mm.index !== start) continue;
      const found = mm[0];
      // Guard: the token at this column must be one tsc quoted, and not already
      // the fix. This is what makes the edit safe without parsing TS ourselves.
      if (!e.quoted.includes(found) || found === e.suggestion) continue;
      lines[e.line - 1] = src.slice(0, start) + e.suggestion + src.slice(start + found.length);
      applied++;
      touched = true;
    }
    if (touched) writeFileSync(file, lines.join("\n"));
  }
  return applied;
}

function gitState(cwd: string): string {
  try {
    return execSync("git status --porcelain", { cwd, encoding: "utf8" });
  } catch {
    return "";
  }
}

/** Build the `autofix` capability the ForgeEngine calls. `cmd` (BROKK_AUTOFIX_CMD)
 *  is an optional project fixer run after the compiler-suggestion pass. */
export function makeAutofix(opts: { cwd: string; cmd?: string }): (verifyOutput: string) => Promise<AutofixResult> {
  const home = process.env.HOME && process.env.HOME !== "/" ? process.env.HOME : "/home/brokk";
  return async (verifyOutput: string): Promise<AutofixResult> => {
    const applied = applyTscSuggestions(parseTscSuggestions(verifyOutput, opts.cwd));
    const notes: string[] = [];
    if (applied) notes.push(`${applied} tsc suggestion${applied === 1 ? "" : "s"}`);

    let cmdChanged = false;
    if (opts.cmd) {
      const before = gitState(opts.cwd);
      try {
        execSync(opts.cmd, {
          cwd: opts.cwd,
          stdio: "ignore",
          timeout: 3 * 60 * 1000,
          env: { ...process.env, NODE_ENV: "development", CI: "true", HOME: home, COREPACK_HOME: `${home}/.cache/corepack` },
        });
      } catch {
        // A non-zero fixer exit is fine — it may still have fixed some files.
      }
      cmdChanged = gitState(opts.cwd) !== before;
      if (cmdChanged) notes.push(`project fixer (${opts.cmd.split(" ")[0]})`);
    }

    const changed = applied > 0 || cmdChanged;
    return { changed, note: changed ? notes.join(" + ") : undefined };
  };
}
