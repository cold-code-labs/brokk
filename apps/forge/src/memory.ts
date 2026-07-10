// ─────────────────────────────────────────────────────────────────────────────
// Repo-memory auto-write (ADR 0027 §5.3) — the forge half of the knowledge
// loop (Eitri already records review_failure lessons). When a run's verify
// went red and the agent healed it, that failure is a REUSABLE fact about this
// repo/toolchain: distill it (one cheap haiku call) and record it as a
// "pitfall" memory. Future forges get it back via the claim's memory payload.
// Best-effort end to end — a failed distill/record never touches the run.
// ─────────────────────────────────────────────────────────────────────────────

import { loadAflConfig, resolveModel, streamAssistant } from "@brokk/afl";

const SYSTEM =
  "You distill agent post-mortems into repo memory. Given a task, a verify command and the failure output the agent later fixed, produce ONE reusable lesson about this repository/toolchain for future coding agents (what breaks and how to avoid it). Max 2 sentences, under 350 characters, plain text, no preamble.";

export async function distillHealLesson(input: {
  taskTitle: string;
  verifyCmd: string;
  failure: string;
}): Promise<string | null> {
  const cfg = loadAflConfig();
  if (!cfg.authToken) return null;
  const result = await streamAssistant(
    cfg,
    {
      model: resolveModel(cfg, "haiku"),
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Task: ${input.taskTitle}\nVerify command: ${input.verifyCmd}\nFailure the agent healed:\n${input.failure.slice(-3500)}`,
            },
          ],
        },
      ],
      tools: [],
      maxTokens: 300,
    },
    () => {},
  );
  const lesson = result.blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return lesson ? lesson.slice(0, 400) : null;
}
