// ─────────────────────────────────────────────────────────────────────────────
// MÍMIR PLANNER — turns ONE human intent into a forge plan: a single atomic card
// or a feature decomposed into an ordered DAG of cards that compose into ONE PR.
//
// This is the highest-leverage reasoning in the forge (a bad plan wastes N
// forges), so it runs on the STRONG model. It does TWO jobs the old triador
// only hinted at: decide the card count + dependency order, AND assign each card
// a complexity (forca) → which resolves to the model/effort that card forges with.
//
// `repoContext` is the seam for the warm index (#5): today it's a cheap blob
// (conventions / file list); tomorrow it's a query against the per-repo index.
// ─────────────────────────────────────────────────────────────────────────────

import {
  type ClarifyQuestion,
  FORCA_LEVELS,
  type ForcaLevel,
  forcaToModel,
  type PlanDraft,
  type PlannedCard,
  type PlanMode,
} from "@brokk/core";

import { extractJson, mimirComplete } from "./client.js";
import type { MimirConfig } from "./config.js";
import { MimirError } from "./errors.js";

const SYSTEM = `Você é o PLANEJADOR de Mímir, na Cold Code Labs. Recebe um pedido humano destinado a um agente autônomo de codificação (o Brokk, que forja código e abre Pull Requests). Seu trabalho é transformar o pedido num PLANO de execução. Não escreva código — planeje.

Decida primeiro o MODO:
- "atomic": o pedido é UMA mudança coesa e pequena → 1 card só. Use isto sempre que decompor for exagero (ex.: "conserte esse typo", "adicione uma rota GET /health").
- "feature": o pedido é maior → quebre em 2 a 8 cards ORDENADOS por dependência, que serão forjados na MESMA branch e compostos em UM ÚNICO PR.

Para cada card defina:
- "key": id curto e estável (ex.: "db", "api", "web", "runner") referenciado por dependentes.
- "title": título curto e imperativo do card.
- "body": o prompt de forja AUTOSSUFICIENTE desse card — claro o bastante para um agente executar sozinho, descrevendo o que mudar e onde. Preserve o idioma do pedido (PT-BR continua PT-BR).
- "forca": complexidade/risco DO CARD → "low" (trivial/isolado), "medium" (escopo moderado), "high" (toca código compartilhado, exige cuidado), "extra" (arquitetural/ambíguo). Isso decide o modelo que vai forjar o card; seja honesto, não infle.
- "dependsOn": lista de "key"s que precisam estar prontos ANTES deste card (o DAG). Camadas de baixo (schema/db) normalmente vêm antes das de cima (api/web).
- "touches": arquivos ou áreas que o card deve tocar (ex.: "packages/db/src/schema.ts", "apps/web/"). Use o contexto do repo quando houver.

DÚVIDAS (como o Claude faz naturalmente): se o pedido for ambíguo, incompleto ou tiver decisões em aberto que mudariam o plano, levante de 1 a 3 PERGUNTAS curtas em "questions" — NÃO invente a resposta. Mesmo com dúvidas, ainda produza seu MELHOR PALPITE de cards (assumindo o caminho mais provável), para a pessoa ter de onde partir. Se o pedido já estiver claro, deixe "questions" como lista vazia. Cada pergunta tem:
- "question": a dúvida em si, no idioma do pedido.
- "why": o que a resposta muda no plano (por que vale perguntar).
Pergunte só o que de fato altera o plano — não encha de perguntas triviais.

Princípios:
- Cada card deve ser uma unidade testável e coerente — nem fino demais (1 linha), nem grosso demais (a feature inteira).
- Ordene por dependência real; cards independentes podem não ter dependsOn.
- Não invente requisitos que mudem a tarefa.`;

const OUTPUT_CONTRACT = `Responda SOMENTE com um objeto JSON válido, sem markdown, neste formato exato:
{"mode":"atomic|feature","summary":"<nome curto da feature>","rationale":"<1-3 frases em PT-BR justificando a decomposição>","targetBranch":"dev","questions":[{"question":"...","why":"..."}],"cards":[{"key":"db","title":"...","body":"...","forca":"low|medium|high|extra","dependsOn":[],"touches":[]}]}`;

type RawCard = {
  key?: unknown;
  title?: unknown;
  body?: unknown;
  forca?: unknown;
  dependsOn?: unknown;
  touches?: unknown;
};
type RawQuestion = { question?: unknown; why?: unknown };
type RawPlan = {
  mode?: unknown;
  summary?: unknown;
  rationale?: unknown;
  targetBranch?: unknown;
  questions?: unknown;
  cards?: unknown;
};

const asStr = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const asStrArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const asForca = (v: unknown): ForcaLevel =>
  FORCA_LEVELS.includes(v as ForcaLevel) ? (v as ForcaLevel) : "medium";

/** Sanitize the planner's questions: keep only well-formed ones, cap at 3, and
 *  assign each a stable local id the UI threads answers back through. */
function asQuestions(v: unknown): ClarifyQuestion[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((q): ClarifyQuestion | null => {
      const r = q as RawQuestion;
      const question = asStr(r.question).trim();
      if (!question) return null;
      return { id: "", question, why: asStr(r.why).trim() };
    })
    .filter((q): q is ClarifyQuestion => q !== null)
    .slice(0, 3)
    .map((q, i) => ({ ...q, id: `q${i + 1}` }));
}

/** Plan one human prompt into cards. Throws MimirError on AI failure; sanitizes
 *  the model output and never returns an empty plan (falls back to one card). */
export async function planJob(
  input: string,
  config: MimirConfig,
  repoContext?: string,
): Promise<PlanDraft> {
  const clean = input.trim();
  if (!clean) throw new MimirError("Pedido vazio", 400);

  const user = repoContext
    ? `CONTEXTO DO REPOSITÓRIO (use para escolher keys/touches realistas):\n${repoContext}\n\n---\n\nPEDIDO:\n${clean}`
    : clean;

  const { text } = await mimirComplete(config, {
    system: `${SYSTEM}\n\n${OUTPUT_CONTRACT}`,
    user,
    model: config.plannerModel,
    json: true,
    maxTokens: 6000,
  });

  const raw = extractJson<RawPlan>(text);
  const rawCards = Array.isArray(raw?.cards) ? (raw!.cards as RawCard[]) : [];

  // Dedup keys + resolve model/effort per card.
  const seen = new Set<string>();
  const cards: PlannedCard[] = rawCards
    .map((c, i): PlannedCard => {
      let key = asStr(c.key, `card-${i + 1}`).trim() || `card-${i + 1}`;
      while (seen.has(key)) key = `${key}-${i + 1}`;
      seen.add(key);
      const forca = asForca(c.forca);
      const { model, effort } = forcaToModel(forca);
      return {
        key,
        title: asStr(c.title, `Card ${i + 1}`).trim(),
        body: asStr(c.body).trim(),
        forca,
        model,
        effort,
        dependsOn: asStrArr(c.dependsOn).filter((k) => k !== key),
        touches: asStrArr(c.touches),
      };
    })
    .filter((c) => c.body.length > 0);

  // Fallback: never return an empty plan — treat the whole prompt as one card.
  if (cards.length === 0) {
    const { model, effort } = forcaToModel("medium");
    cards.push({
      key: "card-1",
      title: clean.slice(0, 60),
      body: clean,
      forca: "medium",
      model,
      effort,
      dependsOn: [],
      touches: [],
    });
  }

  // Drop dangling dependsOn references (keys that aren't in the plan).
  const keys = new Set(cards.map((c) => c.key));
  for (const c of cards) c.dependsOn = c.dependsOn.filter((k) => keys.has(k));

  const mode: PlanMode = raw?.mode === "atomic" || cards.length === 1 ? "atomic" : "feature";

  return {
    mode,
    summary: asStr(raw?.summary, clean.slice(0, 60)).trim() || clean.slice(0, 60),
    rationale: asStr(raw?.rationale).trim(),
    targetBranch: asStr(raw?.targetBranch, "dev").trim() || "dev",
    questions: asQuestions(raw?.questions),
    cards,
    model: config.plannerModel,
  };
}
