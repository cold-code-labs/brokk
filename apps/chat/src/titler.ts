// Auto-naming de chats (como v0/Cursor/Claude): depois do 1º turno, um modelo
// barato (haiku, pelo gateway) resume a conversa num título de 3-5 palavras. Roda
// independente do motor do turno (afl ou cli) — sempre pela costura do gateway,
// que o daemon já tem. Best-effort: falhou = fica o título derivado da 1ª msg.
import {
  type AflConfig,
  type ContentBlock,
  resolveModel,
  streamAssistant,
} from "@brokk/chat";
import type { Store } from "@brokk/db";

const TITLE_SYSTEM = [
  "You name a coding chat thread from its first exchange.",
  "Reply with ONLY the title: 3 to 5 words, in the SAME language as the user,",
  "no surrounding quotes, no trailing punctuation, capitalized naturally.",
  "Capture the concrete task, not pleasantries.",
].join(" ");

/** Generate a concise title from the first user message + the assistant's reply.
 *  Returns null on any failure (caller keeps the derived title). */
export async function generateTitle(
  cfg: AflConfig,
  firstUserText: string,
  assistantText: string,
): Promise<string | null> {
  try {
    const model = resolveModel(cfg, "haiku");
    const user = [
      "Primeira mensagem do usuário:",
      firstUserText.slice(0, 800),
      "",
      "Início da resposta do agente:",
      assistantText.slice(0, 500),
      "",
      "Título:",
    ].join("\n");
    const res = await streamAssistant(
      cfg,
      {
        model,
        system: TITLE_SYSTEM,
        messages: [{ role: "user", content: [{ type: "text", text: user }] }],
        tools: [],
        maxTokens: 24,
      },
      () => {},
    );
    const raw = res.blocks
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    // First line, strip wrapping quotes/hashes/trailing punctuation, clamp length.
    const title = raw
      .split("\n")[0]!
      .replace(/^["'#\s]+/, "")
      .replace(/["'\s.]+$/, "")
      .slice(0, 60)
      .trim();
    return title.length >= 2 ? title : null;
  } catch {
    return null;
  }
}

/** Fire-and-forget: after the first exchange, name the session and emit a title
 *  event. Reads the freshest assistant message from the store. */
export async function autoTitle(
  store: Store,
  cfg: AflConfig,
  sessionId: string,
  firstUserText: string,
  emit: (title: string) => void,
): Promise<void> {
  const msgs = await store.listChatMessages(sessionId).catch(() => []);
  const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
  const assistantText = ((lastAssistant?.blocks ?? []) as ContentBlock[])
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!assistantText) return;
  const title = await generateTitle(cfg, firstUserText, assistantText);
  if (!title) return;
  await store.updateChatSession(sessionId, { title }).catch(() => {});
  emit(title);
}
