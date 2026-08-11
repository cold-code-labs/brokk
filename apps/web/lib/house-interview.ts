// House objective round — per-project, not a global questionnaire.
// Flow: recap (what recently happened) → next objective → micro-questions → lock → work + document.

import type { HouseObjective } from "@brokk/core";
import type { Task } from "@brokk/sdk";

export type InterviewOption = { id: string; label: string };
export type InterviewQuestion = {
  id: string;
  prompt: string;
  options?: InterviewOption[];
  allowCustom?: boolean;
  multi?: boolean;
};

export type ProjectRecap = {
  mission: string | null;
  missing: string[];
  recentDone: string[];
  recentRunning: string[];
  recentReview: string[];
  lastObjectiveSummary: string | null;
  lastLockedAt: string | null;
  hasSignal: boolean;
};

export function buildRecap(input: {
  tasks: Task[];
  mission: string | null;
  missing: string[];
  objective: HouseObjective | null;
}): ProjectRecap {
  const byUpdated = [...input.tasks].sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : -1,
  );
  const take = (status: string, n: number) =>
    byUpdated
      .filter((t) => t.status === status)
      .slice(0, n)
      .map((t) => t.title);

  const recentDone = take("done", 5);
  const recentRunning = take("running", 4);
  const recentReview = take("review", 4);
  const hasSignal =
    recentDone.length +
      recentRunning.length +
      recentReview.length +
      input.missing.length +
      (input.mission ? 1 : 0) +
      (input.objective?.summary ? 1 : 0) >
    0;

  return {
    mission: input.mission,
    missing: input.missing.slice(0, 6),
    recentDone,
    recentRunning,
    recentReview,
    lastObjectiveSummary: input.objective?.summary ?? null,
    lastLockedAt: input.objective?.lockedAt ?? null,
    hasSignal,
  };
}

/** Micro-questions derived from THIS project's objective + signals — not a global pack. */
export function buildMicroQuestions(input: {
  projectName: string;
  nextObjective: string;
  recap: ProjectRecap;
}): InterviewQuestion[] {
  const obj = input.nextObjective.trim().toLowerCase();
  const qs: InterviewQuestion[] = [];

  // Always: slice the objective into delivery shape for this round.
  qs.push({
    id: "round_outcome",
    prompt: `Para “${input.nextObjective.trim().slice(0, 80)}”, o que fecha esta rodada?`,
    options: [
      { id: "preview_demo", label: "Preview demoável do happy path" },
      { id: "pr_merged", label: "PR na dev com Eitri ok" },
      { id: "assurance", label: "assurance/ atualizado + proofs" },
      { id: "doc_only", label: "Só documentar / mapear — ainda sem forge" },
    ],
    allowCustom: true,
    multi: true,
  });

  qs.push({
    id: "scope_cut",
    prompt: "O que fica DE FORA desta rodada?",
    options: [
      { id: "polish", label: "Polish visual fino" },
      { id: "edge", label: "Edge cases / raros" },
      { id: "perf", label: "Performance / escala" },
      { id: "integrations", label: "Integrações externas novas" },
      { id: "nothing", label: "Nada óbvio — digito abaixo" },
    ],
    allowCustom: true,
    multi: true,
  });

  // Contextual chips from Huginn missing.
  if (input.recap.missing.length > 0) {
    qs.push({
      id: "pick_gaps",
      prompt: "Quais gaps do projeto entram nesta rodada?",
      options: input.recap.missing.slice(0, 6).map((m, i) => ({
        id: `gap_${i}`,
        label: m.length > 90 ? `${m.slice(0, 88)}…` : m,
      })),
      allowCustom: true,
      multi: true,
    });
  }

  // Keyword-triggered deep questions (only if the objective mentions them).
  if (/\b(user|usu[aá]rio|rbac|papel|permiss|auth|login|acesso)\b/i.test(obj)) {
    qs.push({
      id: "auth_depth",
      prompt: "Auth / usuários nesta rodada — até onde?",
      options: [
        { id: "login_only", label: "Só login / sessão" },
        { id: "roles_read", label: "Papéis leitura vs escrita" },
        { id: "roles_ui", label: "UI pra editar papéis e permissões" },
        { id: "archive_user", label: "Arquivar/excluir contato ou usuário" },
      ],
      multi: true,
      allowCustom: true,
    });
  }

  if (/\b(log|observab|otel|trace|metric|alerta)\b/i.test(obj) || /logcheck/i.test(input.projectName)) {
    qs.push({
      id: "obs_depth",
      prompt: "Observability nesta rodada — o que entra?",
      options: [
        { id: "list_filter", label: "Lista + filtro de eventos" },
        { id: "detail", label: "Detalhe de evento / trace" },
        { id: "alerts", label: "Severidade / alertas" },
        { id: "synthetic", label: "Dados sintéticos bastam" },
        { id: "real_pipe", label: "Ligar pipe real (OTel/Coolify)" },
      ],
      multi: true,
      allowCustom: true,
    });
  }

  if (/\b(ui|tela|p[aá]gina|dashboard|layout|design)\b/i.test(obj)) {
    qs.push({
      id: "ui_depth",
      prompt: "UI nesta rodada — prioridade?",
      options: [
        { id: "one_screen", label: "Uma tela hero completa" },
        { id: "flow", label: "Fluxo de 2–3 telas" },
        { id: "reuse", label: "Reusar componentes do app" },
        { id: "litr", label: "Pass Litr / visual gate" },
      ],
      multi: true,
      allowCustom: true,
    });
  }

  qs.push({
    id: "srh",
    prompt: "Spec Rails Horse nesta rodada?",
    options: [
      { id: "seed", label: "Seed/atualizar assurance/ junto com o código" },
      { id: "after_preview", label: "Primeiro preview; mapa na sequência" },
      { id: "full_proofs", label: "Já com proofs no DoD" },
    ],
  });

  qs.push({
    id: "micro_steps",
    prompt: "Liste as micro-etapas (uma por linha) — a esteira ataca nessa ordem.",
    allowCustom: true,
  });

  return qs;
}

export function composeObjectiveSummary(
  nextObjective: string,
  answers: Record<string, string | string[]>,
  questions: InterviewQuestion[],
): string {
  const lines: string[] = [`Próximo objetivo: ${nextObjective.trim()}`];
  for (const q of questions) {
    const raw = answers[q.id];
    if (raw == null || (Array.isArray(raw) && !raw.length) || raw === "") continue;
    const labelOf = (id: string) => {
      if (id.startsWith("custom:")) return id.slice(7);
      return q.options?.find((o) => o.id === id)?.label ?? id;
    };
    const rendered = Array.isArray(raw) ? raw.map(labelOf).join("; ") : labelOf(String(raw));
    lines.push(`${q.prompt} → ${rendered}`);
  }
  return lines.join("\n");
}

export function composeChatBrief(input: {
  projectName: string;
  nextObjective: string;
  recap: ProjectRecap;
  answers: Record<string, string | string[]>;
  questions: InterviewQuestion[];
  summary: string;
}): string {
  const recapLines: string[] = [];
  if (input.recap.mission) recapLines.push(`Missão (Huginn): ${input.recap.mission}`);
  if (input.recap.lastObjectiveSummary) {
    recapLines.push(`Objetivo anterior:\n${input.recap.lastObjectiveSummary}`);
  }
  if (input.recap.recentDone.length) {
    recapLines.push(`Feito recente:\n${input.recap.recentDone.map((t) => `- ${t}`).join("\n")}`);
  }
  if (input.recap.recentRunning.length || input.recap.recentReview.length) {
    recapLines.push(
      `Em voo:\n${[...input.recap.recentRunning, ...input.recap.recentReview].map((t) => `- ${t}`).join("\n")}`,
    );
  }

  return [
    `# House round — ${input.projectName}`,
    "",
    "O operador definiu a próxima rodada deste projeto (não um template genérico).",
    "Leia o recap, ataque as micro-etapas, documente (assurance/ Spec Rails quando couber).",
    "Só volte ao humano se faltar decisão de produto.",
    "",
    "## Recap do projeto",
    recapLines.length ? recapLines.join("\n\n") : "(Sem sinal recente — rodada começa do objetivo.)",
    "",
    "## Esta rodada",
    input.summary,
    "",
    "## Como operar",
    "1. Quebrar micro-etapas em Plan → Forge (ou documentar se a rodada for só mapa).",
    "2. Manter Preview vivo para validar.",
    "3. Atualizar assurance/ conforme a escolha Spec Rails.",
    "4. Não pedir prompt genérico — usar este brief.",
  ].join("\n");
}

export const HOUSE_PENDING_BRIEF_KEY = "brokk.house.pendingBrief";
