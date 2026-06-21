// ─────────────────────────────────────────────────────────────────────────────
// MÍMIR errors. Shared across the client, triador, enhancer and planner so the
// model client can raise them without importing the enhancer (no cycle).
// ─────────────────────────────────────────────────────────────────────────────

export class MimirError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "MimirError";
    this.status = status;
  }
  userMessage(): string {
    if (this.status === 429) {
      return "Mímir está sem janela de IA no momento (rate-limit da assinatura). Tente em instantes.";
    }
    if (this.status === 401 || this.status === 403) {
      return "A credencial de IA foi recusada (401/403). Verifique o seat Max / a chave de Mímir.";
    }
    return "Não consegui pensar nisso agora. Tente de novo em instantes.";
  }
}
