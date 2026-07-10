// ─────────────────────────────────────────────────────────────────────────────
// MÍMIR config. Mímir's three model calls — triador (router), enhancer (rewrite)
// and planner (decompose) — go through ONE client that speaks either:
//   • claude  — the Anthropic Messages API via the LLM gateway (ANTHROPIC_
//               AUTH_TOKEN + ANTHROPIC_BASE_URL — same auth path the agents
//               use, no extra API key/cost). HTTP-only since ADR 0027.
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
  // ── claude provider (Messages API via the gateway) ──
  /** ANTHROPIC_AUTH_TOKEN — gateway bearer (LiteLLM vkey). */
  authToken: string;
  /** ANTHROPIC_BASE_URL — the LLM gateway base (e.g. http://litellm:4000). */
  anthropicBaseUrl: string;
}

/** Build Mímir config from the env. Returns undefined when no provider is usable
 *  (so enhance/triage/plan endpoints 503 cleanly instead of throwing at boot). */
export function loadMimirConfig(env: NodeJS.ProcessEnv = process.env): MimirConfig | undefined {
  const explicit = env.MIMIR_PROVIDER as MimirProvider | undefined;
  const hasClaudeAuth = !!(env.ANTHROPIC_AUTH_TOKEN && env.ANTHROPIC_BASE_URL);
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
      authToken: "",
      anthropicBaseUrl: "",
    };
  }

  // claude (default): the shared seat through the LLM gateway (Messages API,
  // ANTHROPIC_AUTH_TOKEN vkey + ANTHROPIC_BASE_URL). Both required.
  if (!hasClaudeAuth) return undefined;
  return {
    provider,
    // Cosmetic rewrite → cheap; routing → mid; planning → strong.
    enhanceModel: env.MIMIR_ENHANCE_MODEL ?? "haiku",
    triageModel: env.MIMIR_TRIAGE_MODEL ?? "sonnet",
    plannerModel: env.MIMIR_PLANNER_MODEL ?? "sonnet",
    baseUrl: "",
    apiKey: "",
    authToken: env.ANTHROPIC_AUTH_TOKEN ?? "",
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL ?? "",
  };
}
