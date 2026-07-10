// ─────────────────────────────────────────────────────────────────────────────
// Sindri config. The model path is the same one Brokkr's forge already uses: the
// CCL AI gateway (LiteLLM → Ratatoskr → headroom → Anthropic). Ratatoskr injects
// the subscription OAuth credential, the `oauth-2025-04-20` beta flag, AND the
// "You are Claude Code" system marker the subscription path requires — so from
// here we just POST a plain Messages request and the envelope is grey-light by
// construction. We never hold the seat token; only a LiteLLM virtual key.
// ─────────────────────────────────────────────────────────────────────────────

export interface AflConfig {
  /** Gateway base URL (ANTHROPIC_BASE_URL) — e.g. http://127.0.0.1:4000. We POST
   *  `${gatewayUrl}/v1/messages`. */
  gatewayUrl: string;
  /** Credential: a gateway bearer (ANTHROPIC_AUTH_TOKEN, LiteLLM virtual key) or
   *  a direct Anthropic API key (ANTHROPIC_API_KEY) — see authKind. */
  authToken: string;
  /** How the credential is presented: "bearer" (Authorization header, the CCL
   *  gateway/seat path — the default) or "apikey" (x-api-key, direct Anthropic).
   *  ADR 0027 §3.1: ANTHROPIC_AUTH_TOKEN wins when both are set, so the fleet's
   *  seat mode is untouched; an operator with only an API key just works. */
  authKind: "bearer" | "apikey";
  /** anthropic-version header — mirrors what Claude Code sends. */
  anthropicVersion: string;
  /** alias → concrete model id, from the ANTHROPIC_DEFAULT_*_MODEL env. */
  models: { haiku: string; sonnet: string; opus: string };
  /** Max tokens per assistant turn. */
  maxTokens: number;
  /** Hard ceiling on tool-use rounds in one turn (runaway guard). */
  maxRounds: number;
  /** Compact the transcript when the API reports this many input tokens for a
   *  round (older rounds fold into a summary — see compact.ts). 0 = off. */
  compactInputTokens: number;
  /** Optional cumulative token budget per turn (input+output). 0 = unlimited.
   *  Consumers pass it to runAgentLoop's maxTotalTokens. */
  turnTokenBudget: number;
}

export function loadAflConfig(env: NodeJS.ProcessEnv = process.env): AflConfig {
  const bearer = env.ANTHROPIC_AUTH_TOKEN ?? "";
  const apiKey = env.ANTHROPIC_API_KEY ?? "";
  const authKind: AflConfig["authKind"] = bearer ? "bearer" : apiKey ? "apikey" : "bearer";
  const defaultBase = authKind === "apikey" ? "https://api.anthropic.com" : "http://127.0.0.1:4000";
  return {
    gatewayUrl: (env.ANTHROPIC_BASE_URL ?? defaultBase).replace(/\/$/, ""),
    authToken: bearer || apiKey,
    authKind,
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
    compactInputTokens: Number(env.BROKK_COMPACT_INPUT_TOKENS ?? 120_000),
    turnTokenBudget: Number(env.BROKK_TURN_TOKEN_BUDGET ?? 0),
  };
}

/** Resolve a session's model alias to the concrete id the gateway expects. An
 *  already-concrete id (contains "-") passes through untouched. */
export function resolveModel(cfg: AflConfig, alias: string): string {
  const a = (alias || "haiku").toLowerCase();
  if (a === "haiku" || a === "sonnet" || a === "opus") return cfg.models[a];
  return alias; // already a concrete model id
}
