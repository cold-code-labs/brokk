// ─────────────────────────────────────────────────────────────────────────────
// Sindri config. The model path is the same one Brokkr's forge already uses: the
// CCL AI gateway (LiteLLM → Ratatoskr → headroom → Anthropic). Ratatoskr injects
// the subscription OAuth credential, the `oauth-2025-04-20` beta flag, AND the
// "You are Claude Code" system marker the subscription path requires — so from
// here we just POST a plain Messages request and the envelope is grey-light by
// construction. We never hold the seat token; only a LiteLLM virtual key.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatConfig {
  /** Gateway base URL (ANTHROPIC_BASE_URL) — e.g. http://127.0.0.1:4000. We POST
   *  `${gatewayUrl}/v1/messages`. */
  gatewayUrl: string;
  /** Bearer token for the gateway (ANTHROPIC_AUTH_TOKEN) — a LiteLLM virtual key. */
  authToken: string;
  /** anthropic-version header — mirrors what Claude Code sends. */
  anthropicVersion: string;
  /** alias → concrete model id, from the ANTHROPIC_DEFAULT_*_MODEL env. */
  models: { haiku: string; sonnet: string; opus: string };
  /** Max tokens per assistant turn. */
  maxTokens: number;
  /** Hard ceiling on tool-use rounds in one turn (runaway guard). */
  maxRounds: number;
}

export function loadChatConfig(env: NodeJS.ProcessEnv = process.env): ChatConfig {
  return {
    gatewayUrl: (env.ANTHROPIC_BASE_URL ?? "http://127.0.0.1:4000").replace(/\/$/, ""),
    authToken: env.ANTHROPIC_AUTH_TOKEN ?? "",
    anthropicVersion: env.ANTHROPIC_VERSION ?? "2023-06-01",
    models: {
      haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? "claude-haiku-4-5-20251001",
      sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "claude-sonnet-4-6",
      opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? "claude-opus-4-8",
    },
    // Modest by default: max_tokens is RESERVED against the shared Max seat's
    // output-token window, so a big reservation 429s when the seat is busy. 2048
    // is plenty for chat coding rounds (the loop spans many) while staying small
    // enough to pass a tight window; the gateway client shrinks it further on 429.
    maxTokens: Number(env.SINDRI_MAX_TOKENS ?? 2048),
    maxRounds: Number(env.SINDRI_MAX_ROUNDS ?? 80),
  };
}

/** Resolve a session's model alias to the concrete id the gateway expects. An
 *  already-concrete id (contains "-") passes through untouched. */
export function resolveModel(cfg: ChatConfig, alias: string): string {
  const a = (alias || "sonnet").toLowerCase();
  if (a === "haiku" || a === "sonnet" || a === "opus") return cfg.models[a];
  return alias; // already a concrete model id
}
