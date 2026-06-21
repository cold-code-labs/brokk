// ─────────────────────────────────────────────────────────────────────────────
// MÍMIR config. Both of Mímir's model calls — the triador (router) and the
// enhancer — hit one OpenAI-compatible endpoint with one cheap model. Point
// `MIMIR_BASE_URL` at the CCL AI gateway (Bifröst) in prod, or OpenAI directly.
// ─────────────────────────────────────────────────────────────────────────────

export interface MimirConfig {
  baseUrl: string;
  apiKey: string;
  /** The cheap model both the triador and the enhancer use. */
  model: string;
}

export function loadMimirConfig(env: NodeJS.ProcessEnv = process.env): MimirConfig {
  const apiKey = env.MIMIR_API_KEY ?? "";
  if (!apiKey) throw new Error("MIMIR_API_KEY is required");
  return {
    baseUrl: env.MIMIR_BASE_URL ?? "https://api.openai.com/v1",
    apiKey,
    model: env.MIMIR_MODEL ?? "gpt-4.1-mini",
  };
}
