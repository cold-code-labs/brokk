// ─────────────────────────────────────────────────────────────────────────────
// Brokk Skills (ADR 0039) — the skill primitive, mirroring Claude Code's own:
// a Skill is a package of { name, description (its trigger), instructions body }
// that Brokk (the chat agent) loads on demand to do a kind of work. The old
// codename features — Discovery (Huginn) and Enhance (Mímir) — stop being their
// own destinations and become the first two skills, invoked from the chat.
//
// Two flavors, both expressed by the same shape:
//   • capability skills carry a `run()` — they execute (Discovery scouts the
//     repo; Enhance rewrites a prompt) and return a result to the turn.
//   • instruction skills carry only `instructions` — invoking one injects that
//     guidance into the turn (the pure Claude Code primitive: prose the model
//     then acts on with its normal tools).
//
// The model reaches every skill through ONE tool, `invoke_skill`, and knows the
// catalogue because buildSystemPrompt lists it (name + trigger). This matches the
// host-injected bridge pattern already used by `plan_work` — the Sindri app binds
// the concrete handlers (which need the checkout + Mímir/Huginn config) per turn.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolDef, ToolResult } from "@brokk/afl";

/** A Brokk Skill. `run` OR `instructions` (or both — run wins) must be present. */
export interface Skill {
  /** Stable id the model passes to `invoke_skill` (kebab/lowercase, no spaces). */
  name: string;
  /** The trigger: one line telling the model WHEN to reach for this skill. Shown
   *  in the system-prompt catalogue and used as the skill's self-description. */
  description: string;
  /** Optional prose injected into the turn when the skill is invoked and has no
   *  `run` (the pure instruction primitive). */
  instructions?: string;
  /** Optional executor: performs the skill's work and returns a tool-result. */
  run?: (input: Record<string, unknown>) => Promise<ToolResult>;
}

/** The single tool through which the model reaches every registered skill. The
 *  catalogue itself lives in the system prompt (dynamic), so this stays generic. */
export const INVOKE_SKILL_TOOL: ToolDef = {
  name: "invoke_skill",
  description:
    "Invoke a Brokk Skill by name to do a specialized kind of work. The available skills (name + when to use each) are listed in the 'Brokk Skills' section of your instructions. Use a skill when the request matches its trigger instead of doing the work by hand.",
  input_schema: {
    type: "object",
    properties: {
      skill: { type: "string", description: "the skill's name, exactly as listed in the catalogue" },
      input: {
        type: "object",
        description: "skill-specific arguments (see the skill's trigger for what it expects)",
      },
    },
    required: ["skill"],
  },
};

/** Render the catalogue for the system prompt — one line per skill. Empty string
 *  when no skills are registered, so the section is simply omitted. */
export function skillCatalogue(skills: Skill[] | undefined): string {
  if (!skills || skills.length === 0) return "";
  return [
    "## Brokk Skills",
    "Reach these with the `invoke_skill` tool (pass the skill's name). Use one when the request matches its trigger:",
    ...skills.map((s) => `- **${s.name}** — ${s.description}`),
  ].join("\n");
}

/** Pin an instruction skill for the whole session (composer "Skill" chip). */
export function pinnedSkillBlock(skill: Skill | undefined): string {
  if (!skill?.instructions) return "";
  return [
    `## Active skill (pinned): ${skill.name}`,
    "This session is pinned to this skill. Follow it for the whole conversation unless the user explicitly releases it. Prefer this over improvising a parallel method.",
    "",
    skill.instructions,
  ].join("\n");
}

/** Dispatch one `invoke_skill` call against the registry. */
export async function dispatchSkill(
  skills: Skill[] | undefined,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  if (!skills || skills.length === 0) {
    return { ok: false, content: "no skills are available in this context" };
  }
  const skill = skills.find((s) => s.name === name);
  if (!skill) {
    const known = skills.map((s) => s.name).join(", ");
    return { ok: false, content: `unknown skill "${name}". Available: ${known}` };
  }
  if (skill.run) return skill.run(input);
  if (skill.instructions) {
    return { ok: true, content: `Skill "${skill.name}" — follow these instructions:\n\n${skill.instructions}` };
  }
  return { ok: false, content: `skill "${skill.name}" has no handler` };
}
