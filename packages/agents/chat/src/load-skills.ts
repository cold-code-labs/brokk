// Load instruction skills from the Brokk repo's skills/ tree (SKILL.md + YAML
// frontmatter). Capability skills (discovery, enhance) stay code-bound in Sindri.
// Source of truth is INSIDE Brokk — not Yggdrasil (tokens/UI packages stay there).

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Skill } from "./skills.js";

export interface SkillMeta {
  name: string;
  description: string;
  kind: "instruction" | "capability";
}

/** Resolve the on-disk skills directory (prod: BROKK_SKILLS_DIR=/app/skills). */
export function resolveSkillsDir(): string {
  const fromEnv = process.env.BROKK_SKILLS_DIR?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  // Dev: walk up from cwd looking for skills/<name>/SKILL.md
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "skills");
    if (existsSync(join(candidate, "litr", "SKILL.md")) || existsSync(candidate)) {
      try {
        if (statSync(candidate).isDirectory()) return candidate;
      } catch {
        /* continue */
      }
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), "skills");
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  let key = "";
  let buf: string[] = [];
  const flush = () => {
    if (!key) return;
    meta[key] = buf.join("\n").trim().replace(/^['"]|['"]$/g, "");
    key = "";
    buf = [];
  };
  for (const line of lines) {
    const folded = line.match(/^(\w[\w-]*)\s*:\s*>-\s*$/);
    const simple = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (folded) {
      flush();
      key = folded[1]!;
      buf = [];
      continue;
    }
    if (simple && !line.startsWith(" ") && !line.startsWith("\t")) {
      flush();
      key = simple[1]!;
      const rest = simple[2]!.trim();
      if (rest === ">" || rest === ">-" || rest === "|") {
        buf = [];
      } else {
        meta[key] = rest.replace(/^['"]|['"]$/g, "");
        key = "";
        buf = [];
      }
      continue;
    }
    if (key) buf.push(line.replace(/^\s{2}/, ""));
  }
  flush();
  return { meta, body: m[2]!.trim() };
}

/** Instruction skills from skills/<id>/SKILL.md. Safe to call every turn (small tree). */
export function loadInstructionSkills(dir = resolveSkillsDir()): Skill[] {
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of entries) {
    const skillFile = join(dir, name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    let raw: string;
    try {
      raw = readFileSync(skillFile, "utf8");
    } catch {
      continue;
    }
    const { meta, body } = parseFrontmatter(raw);
    const id = (meta.name || name).trim();
    const description = (meta.description || "").trim() || `Instruction skill ${id}`;
    if (!body) continue;
    out.push({ name: id, description, instructions: body });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Catalogue entries for UI + GET /skills (capabilities passed in separately). */
export function skillMetaList(capabilities: SkillMeta[] = []): SkillMeta[] {
  const instr = loadInstructionSkills().map(
    (s): SkillMeta => ({ name: s.name, description: s.description, kind: "instruction" }),
  );
  const seen = new Set(capabilities.map((c) => c.name));
  return [...capabilities, ...instr.filter((s) => !seen.has(s.name))];
}
