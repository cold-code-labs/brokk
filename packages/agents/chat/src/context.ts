// ─────────────────────────────────────────────────────────────────────────────
// The system prompt Sindri runs with. Ratatoskr PREPENDS the genuine
// "You are Claude Code, Anthropic's official CLI for Claude." marker upstream, so
// what we author here is the SECOND half of the envelope — exactly the shape a
// real Claude Code session has (CLI identity, then a CLAUDE.md). That keeps us in
// the grey-LIGHT lane: the leading identity is authentic; ours is project framing.
//
// We ground the turn in the actual checkout: repo, branch, the repo's CLAUDE.md /
// AGENTS.md, and the project's open cards — so Sindri opens with the whole-project
// context the user asked for, without burning a tool round to discover it.
// ─────────────────────────────────────────────────────────────────────────────

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Store } from "@brokk/db";
import { pinnedSkillBlock, skillCatalogue, type Skill } from "./skills.js";

export interface ContextInput {
  cwd: string;
  store: Store;
  projectId: string;
  projectName: string;
  repoFullName: string;
  branch: string;
  /** Brokk Skills available this turn (ADR 0039) — advertised so the model knows
   *  the catalogue it can reach via `invoke_skill`. */
  skills?: Skill[];
  /** When set, inject that skill's instructions as a pinned session block. */
  pinnedSkill?: Skill;
}

const IDENTITY = [
  "You are **Brokk** — Cold Code Labs' coding agent — here in your interactive chat, working a repository *together with the user* in a live conversation. (Your autonomous forge runs cards into PRs on its own; in chat you build side by side with the user.)",
  "",
  "You operate directly on a real git checkout of the project via your tools:",
  "- read_file / write_file / edit_file / list_dir for precise file work",
  "- bash for everything else: ripgrep/grep/find, git, the GitHub CLI (`gh`) to open/merge PRs, package managers, tests and builds",
  "- create_card / list_cards to capture follow-ups or hand well-scoped work to the autonomous forge",
  "- invoke_skill to reach a Brokk Skill (see the catalogue below) when the request matches its trigger",
  "",
  "How to work:",
  "- Be concise and direct. Explain what you're doing in a sentence, then do it — don't narrate every line.",
  "- Make focused, reviewable changes that match the repo's existing conventions.",
  "- Prefer `git` + `gh` via bash for commits, branches, and pull requests. This session already sits on its own working branch. Run network commands — `git push`/`git fetch`/`git pull` and `gh` — as their OWN bash call (don't chain them after `&&`/`;`) so they execute with your credentials.",
  "- Verify your work (typecheck/build/tests) before declaring it done when a verify path exists.",
  "- COMMIT POLICY: Do NOT `git commit` or `git push` unless the user explicitly asks. Live preview / HMR already shows file edits. Leave the working tree dirty — the operator lands them on `dev` via the Commit button in the preview toolbar. If they ask you to commit, run typecheck when available, then commit + `git push origin HEAD:dev` (never force-push). Do not declare \"published\" just because files were edited.",
  "- If a push is REJECTED (non-fast-forward — someone else pushed to the branch meanwhile), do NOT force-push. Run `git pull --rebase origin <branch>` as its own bash call, resolve any conflicts, re-run typecheck, then push again. If a conflict is beyond a clean auto-resolve, stop and tell the user exactly which files conflict.",
  "- If `bash` reports the execution environment is unavailable, that's an infra fault: you cannot verify, test, or commit anything. Stop and tell the user plainly — never present unverified edits as ready or offer to open a PR.",
  "- When the user asks for something large, propose creating cards and offer to enqueue them for the forge.",
  "- You are running unattended-capable: the user may leave you working overnight. Keep going until the task is genuinely complete; surface blockers clearly.",
].join("\n");

/** Read the first ~6 KB of the repo's CLAUDE.md / AGENTS.md, if present. */
async function repoGuide(cwd: string): Promise<string> {
  for (const name of ["CLAUDE.md", "AGENTS.md", ".github/CLAUDE.md"]) {
    try {
      const text = await fs.readFile(join(cwd, name), "utf8");
      if (text.trim()) return `\n\n## ${name} (repo conventions)\n${text.slice(0, 4000)}`;
    } catch {
      // not present — try the next
    }
  }
  return "";
}

export async function buildSystemPrompt(input: ContextInput): Promise<string> {
  const cards = await input.store
    .listTasks({ projectId: input.projectId })
    .then((all) => all.filter((c) => c.status !== "done" && c.status !== "cancelled").slice(0, 20))
    .catch(() => []);

  const cardLines = cards.length
    ? cards.map((c) => `- [${c.status}] ${c.title} (${c.id.slice(0, 8)})`).join("\n")
    : "- (none open)";

  const guide = await repoGuide(input.cwd);
  const catalogue = skillCatalogue(input.skills);
  const pinned = pinnedSkillBlock(input.pinnedSkill);

  return [
    IDENTITY,
    "",
    "## This session",
    `- Project: ${input.projectName}`,
    `- Repository: ${input.repoFullName}`,
    `- Working branch: ${input.branch}`,
    `- Working directory: the checkout root (all tool paths are relative to it)`,
    "",
    ...(pinned ? [pinned, ""] : []),
    ...(catalogue ? [catalogue, ""] : []),
    "## Open cards in this project",
    cardLines,
    guide,
  ].join("\n");
}
