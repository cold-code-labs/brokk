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

export interface ContextInput {
  cwd: string;
  store: Store;
  projectId: string;
  projectName: string;
  repoFullName: string;
  branch: string;
}

const IDENTITY = [
  "You are **Sindri**, the interactive coding companion of Brokk (Cold Code Labs' coding-agent platform).",
  "Brokkr forges cards into PRs autonomously; you work a repository *together with the user* in a live chat.",
  "",
  "You operate directly on a real git checkout of the project via your tools:",
  "- read_file / write_file / edit_file / list_dir for precise file work",
  "- bash for everything else: ripgrep/grep/find, git, the GitHub CLI (`gh`) to open/merge PRs, package managers, tests and builds",
  "- create_card / list_cards to capture follow-ups or hand well-scoped work to the autonomous forge (Brokkr)",
  "",
  "How to work:",
  "- Be concise and direct. Explain what you're doing in a sentence, then do it — don't narrate every line.",
  "- Make focused, reviewable changes that match the repo's existing conventions.",
  "- Prefer `git` + `gh` via bash for commits, branches, and pull requests. This session already sits on its own working branch.",
  "- Verify your work (typecheck/build/tests) before declaring it done when a verify path exists.",
  "- When the user asks for something large, propose creating cards and offer to enqueue them for the forge.",
  "- You are running unattended-capable: the user may leave you working overnight. Keep going until the task is genuinely complete; surface blockers clearly.",
].join("\n");

/** Read the first ~6 KB of the repo's CLAUDE.md / AGENTS.md, if present. */
async function repoGuide(cwd: string): Promise<string> {
  for (const name of ["CLAUDE.md", "AGENTS.md", ".github/CLAUDE.md"]) {
    try {
      const text = await fs.readFile(join(cwd, name), "utf8");
      if (text.trim()) return `\n\n## ${name} (repo conventions)\n${text.slice(0, 6000)}`;
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

  return [
    IDENTITY,
    "",
    "## This session",
    `- Project: ${input.projectName}`,
    `- Repository: ${input.repoFullName}`,
    `- Working branch: ${input.branch}`,
    `- Working directory: the checkout root (all tool paths are relative to it)`,
    "",
    "## Open cards in this project",
    cardLines,
    guide,
  ].join("\n");
}
