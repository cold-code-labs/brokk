// ─────────────────────────────────────────────────────────────────────────────
// The CLI engine lane for a Sindri session (claude-cli | cursor-cli).
// Continuity is the CLI's own session id (--resume), not chat_messages replay.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChatSession } from "@brokk/core";
import type { Store } from "@brokk/db";
import {
  type AflConfig,
  type AgentEvent,
  type CliTurnInput,
  type ContentBlock,
  attachmentContextBlock,
  loadInstructionSkills,
  resolveModel,
  runClaudeCliTurn,
  runCursorCliTurn,
} from "@brokk/chat";

/** Cross-session cap on concurrent CLI turns — the one real cost on the shared
 *  seat is concurrency (NORTH-STAR §9), and this lane bypasses Ratatoskr's gate. */
const MAX_CONCURRENT = Math.max(1, Number(process.env.BROKK_CLI_MAX_CONCURRENT ?? 2) || 2);
let inFlight = 0;

export type CliKind = "claude" | "cursor";

export interface CliSessionTurnInput {
  session: ChatSession;
  userText: string;
  cfg: AflConfig;
  /** The session owner's own Max seat token (unsealed). When set, it overrides the
   *  container's shared CLAUDE_CODE_OAUTH_TOKEN so the CLI turn bills to the owner's
   *  seat — the CLI lane's half of per-user seat routing. Absent → shared seat. */
  seatToken?: string;
  store: Store;
  /** The session checkout (worktree) the CLI works in. */
  cwd: string;
  repoFullName: string;
  /** Relative `.brokk/inbox/` paths attached this turn (composer). */
  attachments?: string[];
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
  /** Claude Code vs Cursor Agent CLI. Default claude. */
  kind?: CliKind;
}

function deriveTitle(text: string): string {
  const t = text.replace(/\s+/g, " ").trim().slice(0, 60);
  return t.length ? t : "New chat";
}

/** A compact text transcript of prior turns, to hand the CLI when it has NO
 *  session of its own to resume (e.g. the conversation started on the afl lane,
 *  then switched to cli — the CLI keeps context in $HOME/.claude, not our DB, so
 *  without this it starts blind). Text blocks only; tool noise dropped; tail-capped. */
function historyPreamble(msgs: { role: string; blocks: unknown[] }[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    const text = (Array.isArray(m.blocks) ? m.blocks : [])
      .filter((b): b is { type: string; text: string } =>
        !!b && typeof b === "object" && (b as { type?: string }).type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (text) lines.push(`${m.role === "user" ? "User" : "Assistant"}: ${text}`);
  }
  if (!lines.length) return "";
  return `Prior conversation in this session (context — continue it, don't restart):\n${lines.join("\n").slice(-6000)}`;
}

export async function runCliSessionTurn(input: CliSessionTurnInput): Promise<void> {
  const { session, cfg, store, emit, signal } = input;
  const kind: CliKind = input.kind ?? "claude";
  const engineLabel = kind === "cursor" ? "cursor-cli" : "claude-cli";
  if (inFlight >= MAX_CONCURRENT) {
    throw new Error(`CLI lane at capacity (${MAX_CONCURRENT} concurrent turns) — try again shortly`);
  }

  const model =
    kind === "cursor"
      ? process.env.BROKK_CURSOR_MODEL ||
        (session.model === "opus" ? "composer-2.5" : "auto")
      : resolveModel(cfg, session.model);
  emit({ type: "status", phase: "turn_start", detail: { model, engine: engineLabel } });

  // Context bridge: if there's no CLI session to resume (fresh, or switched over
  // from the afl lane), the CLI has no memory of prior turns — feed it a compact
  // transcript so it continues instead of starting blind. Read BEFORE we append
  // this turn's user message below.
  const preamble = session.cliSessionId
    ? ""
    : historyPreamble(await store.listChatMessages(session.id));

  // Persist the user's message + first-turn title, mirroring the afl lane so the
  // workbench transcript looks identical regardless of engine.
  const userMsg = await store.appendChatMessage(session.id, {
    role: "user",
    blocks: [{ type: "text", text: input.userText }],
  });
  emit({ type: "message", seq: userMsg.seq, role: "user", blocks: userMsg.blocks as ContentBlock[] });
  if (session.title === "New chat" || !session.title) {
    const title = deriveTitle(input.userText);
    await store.updateChatSession(session.id, { title }).catch(() => {});
    emit({ type: "title", title });
  }

  const pinned = session.skill
    ? loadInstructionSkills().find((s) => s.name === session.skill)
    : undefined;
  const attachBlock = attachmentContextBlock(input.attachments ?? []);

  const appendSystem = [
    `You are Sindri, the session agent inside Brokk (CCL's coding pillar), working on repo ${input.repoFullName}.`,
    `Your checkout is a dedicated git worktree on branch \`${session.branch}\`. Do NOT switch branches or reset history — stay here.`,
    `CLOSE THE LOOP: editing files is not finishing. When the user wants to SEE a change, you are done ONLY after you commit and PUSH it (following this repo's CLAUDE.md publishing convention, e.g. \`git push origin HEAD:dev\`) so the preview updates. Run typecheck first. Never leave a wanted change uncommitted/unpublished; state clearly whether you published.`,
    attachBlock,
    pinned?.instructions
      ? `\n## Active skill (pinned): ${pinned.name}\nFollow this skill for the whole conversation unless the user releases it.\n\n${pinned.instructions}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  inFlight++;
  try {
    const promptText = preamble ? `${preamble}\n\n---\n\nCurrent request:\n${input.userText}` : input.userText;
    const runTurn = kind === "cursor" ? runCursorCliTurn : runClaudeCliTurn;
    const turnOpts = (resume: string | undefined): CliTurnInput => ({
      cwd: input.cwd,
      prompt: promptText,
      model,
      resume,
      appendSystem,
      gh: true,
      // Per-user seat (Claude only): override shared OAT with the owner's when set.
      env:
        kind === "claude" && input.seatToken
          ? { CLAUDE_CODE_OAUTH_TOKEN: input.seatToken }
          : undefined,
      timeoutMs: Math.max(0, Number(process.env.BROKK_CLI_TURN_TIMEOUT_MS ?? 3_600_000) || 0),
      emit,
      signal,
      hooks: {
        onAssistant: async (blocks, meta) => {
          const msg = await store.appendChatMessage(session.id, {
            role: "assistant",
            blocks,
            meta: { model, engine: engineLabel, stopReason: meta.stopReason, usage: meta.usage },
          });
          emit({ type: "message", seq: msg.seq, role: "assistant", blocks });
        },
        onToolResults: async (blocks) => {
          const msg = await store.appendChatMessage(session.id, { role: "user", blocks });
          emit({ type: "message", seq: msg.seq, role: "user", blocks });
        },
      },
    });

    let outcome = await runTurn(turnOpts(session.cliSessionId ?? undefined));
    // Stored CLI session lost (e.g. transcript never persisted, volume reset):
    // fall back to a FRESH CLI session once instead of bricking the chat. The
    // conversation context is gone, but the turn proceeds and re-anchors.
    if (
      !outcome.ok &&
      session.cliSessionId &&
      /no conversation found/i.test(outcome.resultText)
    ) {
      emit({ type: "status", phase: "cli_resume_lost", detail: { lost: session.cliSessionId } });
      outcome = await runTurn(turnOpts(undefined));
    }

    // Store the CLI session id the first time (and if the CLI ever rotates it).
    if (outcome.cliSessionId && outcome.cliSessionId !== session.cliSessionId) {
      await store.updateChatSession(session.id, { cliSessionId: outcome.cliSessionId }).catch(() => {});
    }
    emit({ type: "usage", usage: outcome.usage });

    switch (outcome.stop) {
      case "aborted":
        emit({ type: "status", phase: "aborted" });
        return;
      case "max_turns":
        emit({ type: "status", phase: "max_rounds" });
        emit({ type: "done" });
        return;
      case "error":
        emit({
          type: "error",
          message: outcome.resultText || `${kind} CLI turn failed`,
        });
        return;
      default:
        emit({ type: "status", phase: "turn_done" });
        emit({ type: "done" });
    }
  } finally {
    inFlight--;
  }
}
