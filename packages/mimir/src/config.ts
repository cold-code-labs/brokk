// ─────────────────────────────────────────────────────────────────────────────
// MÍMIR config. Mímir's three model calls — triador (router), enhancer (rewrite)
// and planner (decompose) — go through ONE client that speaks either:
//   • claude  — the CCL Max seat via `claude -p`, routed through headroom (the
//               default: same auth path the runner uses, no extra API key/cost).
//   • openai  — an OpenAI-compatible endpoint (legacy fallback).
//
// Tier by FUNCTION, not a flat cheap model: the planner is the highest-leverage
// reasoning (a bad plan wastes N forges) → strong model; the enhancer is cosmetic
// → cheap; the triador sits in between.
// ─────────────────────────────────────────────────────────────────────────────

export type MimirProvider = "claude" | "openai";

export interface MimirConfig {
  provider: MimirProvider;
  /** Per-function models. For claude: "haiku" | "sonnet" | "opus". */
  enhanceModel: string;
  triageModel: string;
  plannerModel: string;
  // ── openai provider ──
  baseUrl: string;
  apiKey: string;
  // ── claude provider (Max subscription) ──
  claudeBin: string;
  /** CLAUDE_CODE_OAUTH_TOKEN — the Max seat token (same one the runner uses).
   *  Empty when running in gateway mode (see authToken). */
  oauthToken: string;
  /** ANTHROPIC_AUTH_TOKEN — gateway bearer (LiteLLM vkey). When set, Mímir runs
   *  `claude -p` in gateway mode: auth goes to the gateway and the seat token /
   *  API key are unset so they can't take precedence. */
  authToken: string;
  /** ANTHROPIC_BASE_URL — headroom proxy, or the LLM gateway in gateway mode. */
  anthropicBaseUrl: string;
}

/** Build Mímir config from the env. Returns undefined when no provider is usable
 *  (so enhance/triage/plan endpoints 503 cleanly instead of throwing at boot). */
export function loadMimirConfig(env: NodeJS.ProcessEnv = process.env): MimirConfig | undefined {
  const explicit = env.MIMIR_PROVIDER as MimirProvider | undefined;
  const hasClaudeAuth = !!(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN);
  const provider: MimirProvider =
    explicit ?? (hasClaudeAuth ? "claude" : env.MIMIR_API_KEY ? "openai" : "claude");

  if (provider === "openai") {
    if (!env.MIMIR_API_KEY) return undefined;
    const m = env.MIMIR_MODEL ?? "gpt-4.1-mini";
    return {
      provider,
      enhanceModel: env.MIMIR_ENHANCE_MODEL ?? m,
      triageModel: env.MIMIR_TRIAGE_MODEL ?? m,
      plannerModel: env.MIMIR_PLANNER_MODEL ?? m,
      baseUrl: env.MIMIR_BASE_URL ?? "https://api.openai.com/v1",
      apiKey: env.MIMIR_API_KEY,
      claudeBin: "",
      oauthToken: "",
      authToken: "",
      anthropicBaseUrl: "",
    };
  }

  // claude (default): reuse the Max seat — either directly (OAuth seat token) or
  // through the LLM gateway (ANTHROPIC_AUTH_TOKEN vkey). One of them is required.
  if (!hasClaudeAuth) return undefined;
  return {
    provider,
    // Cosmetic rewrite → cheap; routing → mid; planning → strong.
    enhanceModel: env.MIMIR_ENHANCE_MODEL ?? "haiku",
    triageModel: env.MIMIR_TRIAGE_MODEL ?? "sonnet",
    plannerModel: env.MIMIR_PLANNER_MODEL ?? "sonnet",
    baseUrl: "",
    apiKey: "",
    claudeBin: env.CLAUDE_BIN ?? "claude",
    oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
    authToken: env.ANTHROPIC_AUTH_TOKEN ?? "",
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL ?? "",
  };
}
