// House objective interview packs — clickable answers (or free text).
// Human gate only: lock objective → lifecycle advances; Brokk/SRH handle the rest.

export type InterviewOption = { id: string; label: string };
export type InterviewQuestion = {
  id: string;
  prompt: string;
  options?: InterviewOption[];
  /** Allow a free-text answer in addition to (or instead of) options. */
  allowCustom?: boolean;
  multi?: boolean;
};

export type InterviewPack = {
  id: string;
  title: string;
  blurb: string;
  questions: InterviewQuestion[];
};

/** Generic pack for any project without a specialist questionnaire. */
export const GENERIC_PACK: InterviewPack = {
  id: "generic",
  title: "Objetivo do produto",
  blurb: "Respostas clicáveis — digite só o que não couber nas opções. Isso destrava a esteira.",
  questions: [
    {
      id: "who",
      prompt: "Quem é o usuário principal?",
      options: [
        { id: "internal", label: "Time interno CCL / ops" },
        { id: "client_staff", label: "Staff do cliente" },
        { id: "end_user", label: "Usuário final (B2C)" },
        { id: "mixed", label: "Mistura (staff + usuários)" },
      ],
      allowCustom: true,
    },
    {
      id: "job",
      prompt: "Qual o trabalho principal que o produto deve fazer bem?",
      allowCustom: true,
    },
    {
      id: "stage",
      prompt: "Onde estamos agora?",
      options: [
        { id: "spike", label: "Protótipo / spike — validar ideia" },
        { id: "mvp", label: "MVP — primeiro uso real" },
        { id: "hardening", label: "Já usado — endurecer / completar" },
        { id: "maintain", label: "Manutenção / evolução contínua" },
      ],
    },
    {
      id: "done",
      prompt: "O que significa “pronto” nesta fatia?",
      options: [
        { id: "preview_ok", label: "Preview usável + happy path" },
        { id: "prod_ship", label: "Em produção com usuários reais" },
        { id: "assurance", label: "Mapa Spec Rails + proofs verdes" },
        { id: "archive", label: "Pode arquivar depois desta entrega" },
      ],
      allowCustom: true,
      multi: true,
    },
    {
      id: "out_of_scope",
      prompt: "O que explicitamente NÃO entra agora?",
      allowCustom: true,
    },
  ],
};

/** Pilot: logcheck — logging/observability instance on the light web template. */
export const LOGCHECK_PACK: InterviewPack = {
  id: "logcheck",
  title: "Logcheck — objetivo",
  blurb:
    "Instância de teste do pass de logging/observability. Trave o norte; Brokk + Spec Rails cuidam do resto.",
  questions: [
    {
      id: "mission",
      prompt: "Qual é a missão do Logcheck?",
      options: [
        {
          id: "showroom_logging",
          label: "Showroom: provar o padrão de logging CCL de ponta a ponta",
        },
        {
          id: "ops_dashboard",
          label: "Dashboard interno de saúde/logs da frota",
        },
        {
          id: "client_tool",
          label: "Ferramenta que um cliente usaria no dia a dia",
        },
        { id: "throwaway", label: "Sandbox descartável — só exercitar a esteira" },
      ],
      allowCustom: true,
    },
    {
      id: "audience",
      prompt: "Quem olha a tela?",
      options: [
        { id: "ccl_eng", label: "Engenharia CCL" },
        { id: "ccl_ops", label: "Ops / plantão" },
        { id: "client", label: "Cliente (não-eng)" },
        { id: "demo", label: "Demo / sales walkthrough" },
      ],
      multi: true,
    },
    {
      id: "data",
      prompt: "De onde vêm os logs / sinais?",
      options: [
        { id: "synthetic", label: "Dados sintéticos / seed no app" },
        { id: "otel", label: "OpenTelemetry / collectors reais" },
        { id: "coolify", label: "Coolify / containers da frota" },
        { id: "pocketbase", label: "Só o que o PocketBase/template já tem" },
      ],
      allowCustom: true,
      multi: true,
    },
    {
      id: "must_have",
      prompt: "O que precisa existir no first ship?",
      options: [
        { id: "list_filter", label: "Lista + filtro de eventos" },
        { id: "detail", label: "Detalhe de um evento / trace" },
        { id: "alerts", label: "Alertas / severidade" },
        { id: "auth_rbac", label: "Auth + papéis (RBAC)" },
        { id: "export", label: "Export / compartilhar" },
      ],
      multi: true,
      allowCustom: true,
    },
    {
      id: "rbac",
      prompt: "Precisa de RBAC agora?",
      options: [
        { id: "no", label: "Não — single admin basta" },
        { id: "roles_read", label: "Sim — papéis só leitura vs escrita" },
        { id: "roles_full", label: "Sim — editar papéis e permissões na UI" },
      ],
    },
    {
      id: "assurance",
      prompt: "Spec Rails Horse nesta fatia?",
      options: [
        { id: "seed_map", label: "Sim — seed assurance/ e features iniciais" },
        { id: "later", label: "Depois — primeiro o happy path no preview" },
        { id: "full", label: "Já quero proofs (QA/sec/logging rails) no DoD" },
      ],
    },
    {
      id: "done",
      prompt: "Quando arquivamos / damos como “esteira validada”?",
      options: [
        { id: "preview_demo", label: "Preview demoável em 1 clique" },
        { id: "eitri_green", label: "PR mergeado com Eitri verde" },
        { id: "rails_green", label: "STATUS Spec Rails sem gaps P0" },
      ],
      multi: true,
      allowCustom: true,
    },
    {
      id: "out_of_scope",
      prompt: "Fora de escopo agora?",
      options: [
        { id: "billing", label: "Billing / multi-tenant comercial" },
        { id: "mobile", label: "App mobile" },
        { id: "realtime", label: "Realtime pesado / streaming contínuo" },
        { id: "none", label: "Nada óbvio — digito abaixo se precisar" },
      ],
      multi: true,
      allowCustom: true,
    },
  ],
};

export function packForProject(name: string): InterviewPack {
  const n = name.trim().toLowerCase();
  if (n.includes("logcheck")) return LOGCHECK_PACK;
  return GENERIC_PACK;
}

export function composeObjectiveSummary(
  pack: InterviewPack,
  answers: Record<string, string | string[]>,
): string {
  const lines: string[] = [];
  for (const q of pack.questions) {
    const raw = answers[q.id];
    if (raw == null || (Array.isArray(raw) && raw.length === 0) || raw === "") continue;
    const labelOf = (id: string) => q.options?.find((o) => o.id === id)?.label ?? id;
    const rendered = Array.isArray(raw)
      ? raw.map(labelOf).join("; ")
      : q.options?.some((o) => o.id === raw)
        ? labelOf(raw)
        : String(raw);
    lines.push(`${q.prompt} → ${rendered}`);
  }
  return lines.join("\n") || "Objetivo travado sem detalhe.";
}

/** Prompt seed dropped into Chat after the human locks the objective. */
export function composeChatBrief(
  projectName: string,
  pack: InterviewPack,
  answers: Record<string, string | string[]>,
  summary: string,
): string {
  return [
    `# House objective — ${projectName}`,
    "",
    "O operador travou o objetivo abaixo. Sua tarefa: operar em alto nível.",
    "Use Spec Rails Horse como guia (assurance/, features, rails, proofs).",
    "Cuide de UI/UX, QA, sec e libs em cada fase — sem pedir prompts genéricos.",
    "Só volte ao humano se faltar uma decisão de produto (não de implementação).",
    "",
    "## Resumo",
    summary,
    "",
    "## Respostas da entrevista",
    composeObjectiveSummary(pack, answers),
    "",
    "## Próximos passos esperados",
    "1. Confirmar se o projeto está Pronto pra fatiar OU se ainda falta um doc/norte (já deveria estar ok).",
    "2. Se pronto: propor fases (features) e começar Plan → Forge na primeira fatia.",
    "3. Seed/atualizar assurance/ conforme a escolha de Spec Rails na entrevista.",
    "4. Manter Preview vivo para validação contínua.",
  ].join("\n");
}

export const HOUSE_PENDING_BRIEF_KEY = "brokk.house.pendingBrief";
