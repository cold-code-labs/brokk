// ─────────────────────────────────────────────────────────────────────────────
// The CLI engine lane for a Sindri session (engine=cli, opt-in per session).
//
// One turn = one headless run of the genuine Claude Code CLI in the session's
// checkout (packages/afl/src/claude-cli.ts). Continuity is the CLI's own
// (--resume via chat_sessions.cli_session_id), NOT a chat_messages replay — we
// persist assistant/tool_result blocks only so the workbench renders the same
// transcript either lane. The afl lane (runTurn) stays the default; Ratatoskr
// and its callers are untouched by this file.
//
// Unlike the afl lane, the CLI brings its own tool surface (Read/Edit/Bash/...)
// and its own system prompt; we append only session grounding. The repo's
// CLAUDE.md/AGENTS.md are read by the CLI natively from the checkout.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChatSession } from "@brokk/core";
import type { Store } from "@brokk/db";
import {
  type AflConfig,
  type AgentEvent,
  type CliTurnInput,
  type ContentBlock,
  resolveModel,
  runClaudeCliTurn,
} from "@brokk/chat";

/** Cross-session cap on concurrent CLI turns — the one real cost on the shared
 *  seat is concurrency (NORTH-STAR §9), and this lane bypasses Ratatoskr's gate. */
const MAX_CONCURRENT = Math.max(1, Number(process.env.BROKK_CLI_MAX_CONCURRENT ?? 2) || 2);
let inFlight = 0;

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
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
}

function deriveTitle(text: string): string {
  const t = text.replace(/\s+/g, " ").trim().slice(0, 60);
  return t.length ? t : "New chat";
}

export async function runCliSessionTurn(input: CliSessionTurnInput): Promise<void> {
  const { session, cfg, store, emit, signal } = input;
  if (inFlight >= MAX_CONCURRENT) {
    throw new Error(`CLI lane at capacity (${MAX_CONCURRENT} concurrent turns) — try again shortly`);
  }

  const model = resolveModel(cfg, session.model);
  emit({ type: "status", phase: "turn_start", detail: { model, engine: "cli" } });

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

  const appendSystem = [
    `You are Sindri, the session agent inside Brokk (CCL's coding pillar), working on repo ${input.repoFullName}.`,
    `Your checkout is a dedicated git worktree on branch \`${session.branch}\`. Do NOT switch branches or reset history — stay here.`,
    // ⚠️ CLOSE THE LOOP. Editing files is NOT finishing. When the user asks for a
    // change they want to SEE, you are done ONLY after you PUBLISH it so the live
    // preview updates — follow THIS repo's publishing convention (read its
    // CLAUDE.md / AGENTS.md; it says where to push, e.g. `git push origin HEAD:dev`).
    // Run the repo's checks (typecheck) first, then commit and push. Never end a
    // turn with a change staged/uncommitted and unpublished — say plainly whether
    // you published. Open PRs to the base branch with `gh` only when explicitly asked.
    `CLOSE THE LOOP: editing files is not finishing. When the user wants to SEE a change, you are done ONLY after you commit and PUSH it (following this repo's CLAUDE.md publishing convention, e.g. \`git push origin HEAD:dev\`) so the preview updates. Run typecheck first. Never leave a wanted change uncommitted/unpublished; state clearly whether you published.`,
  ].join("\n");

  inFlight++;
  try {
    const turnOpts = (resume: string | undefined): CliTurnInput => ({
      cwd: input.cwd,
      prompt: input.userText,
      model,
      resume,
      appendSystem,
      gh: true,
      // Per-user seat: override the container's shared token with the owner's when
      // we have it (cliEnv layers input.env over its allowlist). Absent → shared.
      env: input.seatToken ? { CLAUDE_CODE_OAUTH_TOKEN: input.seatToken } : undefined,
      timeoutMs: Math.max(0, Number(process.env.BROKK_CLI_TURN_TIMEOUT_MS ?? 3_600_000) || 0),
      emit,
      signal,
      hooks: {
        onAssistant: async (blocks, meta) => {
          const msg = await store.appendChatMessage(session.id, {
            role: "assistant",
            blocks,
            meta: { model, engine: "cli", stopReason: meta.stopReason, usage: meta.usage },
          });
          emit({ type: "message", seq: msg.seq, role: "assistant", blocks });
        },
        onToolResults: async (blocks) => {
          const msg = await store.appendChatMessage(session.id, { role: "user", blocks });
          emit({ type: "message", seq: msg.seq, role: "user", blocks });
        },
      },
    });

    let outcome = await runClaudeCliTurn(turnOpts(session.cliSessionId ?? undefined));
    // Stored CLI session lost (e.g. transcript never persisted, volume reset):
    // fall back to a FRESH CLI session once instead of bricking the chat. The
    // conversation context is gone, but the turn proceeds and re-anchors.
    if (
      !outcome.ok &&
      session.cliSessionId &&
      /no conversation found/i.test(outcome.resultText)
    ) {
      emit({ type: "status", phase: "cli_resume_lost", detail: { lost: session.cliSessionId } });
      outcome = await runClaudeCliTurn(turnOpts(undefined));
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
        emit({ type: "error", message: outcome.resultText || "claude CLI turn failed" });
        return;
      default:
        emit({ type: "status", phase: "turn_done" });
        emit({ type: "done" });
    }
  } finally {
    inFlight--;
  }
}
