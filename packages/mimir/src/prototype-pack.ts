// ─────────────────────────────────────────────────────────────────────────────
// ADR 0070 / H1 — Prototype Pack Enhance.
// Insumos (pedidos / prompt) → ranked Pack (hero_set ≤ 4). One-shot JSON via
// mimirComplete (planner tier — ranking quality matters). Pass-through coerce
// for packs already gated by a human.
// ─────────────────────────────────────────────────────────────────────────────

import {
  PROTOTYPE_PACK_MAX_HERO,
  type PrototypeDeferredItem,
  type PrototypeEvidence,
  type PrototypeHeroRoom,
  type PrototypePack,
  type PrototypePackInsumos,
} from "@brokk/core";

import { extractJson, mimirComplete } from "./client.js";
import type { MimirConfig } from "./config.js";
import { MimirError } from "./errors.js";

export type PrototypePackEnhanceResult = {
  pack: PrototypePack;
  model: string;
  enhanced: true;
};

const DEFAULT_CONSTRAINTS = [
  "Somente frontend (Vite · template-vite / Heimdall client-vite)",
  "Dados mock — sem BaaS / Hauldr / auth real nas telas Hero",
  "Um app navegável coerente (Hero), não 12 tickets soltos",
];

const SYSTEM = `Você é o Enhance do Brokk (ADR 0070): transforma insumos de discovery num Prototype Pack que vende o protótipo.

Missão: sweet spot entre criatividade, spec limpo e vetor de negócio — como v0/Lovable no primeiro paint, mas ancorado no que o cliente JÁ pediu.

Regras:
1. mission = 1 frase do que o protótipo PROVA na demo.
2. context = quem usa, em que momento, que decisão toma (estilo v0).
3. constraints = rails duras; inclua frontend-only, mock, template-vite, sem BaaS (pode enriquecer, não contradizer).
4. design_read = 1 linha Taste/Litr (page kind, audience, vibe) — sem inventar assinatura de outro produto CCL.
5. hero_set = NO MÁXIMO ${PROTOTYPE_PACK_MAX_HERO} salas que VENDEM na demo (landing + shells do core). Agrupe pedidos relacionados numa sala. Cada sala: title, route, job, fake_data, prioridade.
6. deferred = o que existe nos insumos mas NÃO entra no Hero (não some — profundidade depois).
7. evidence = trechos reais dos insumos (pedido/prompt), não invente quotes.
8. Não invente módulos que ninguém pediu. Prefira menos salas melhores.
9. Responda em português. SOMENTE JSON válido, sem markdown:

{"mission":"...","context":"...","constraints":["..."],"design_read":"...","hero_set":[{"title":"...","route":"/...","job":"...","fake_data":"...","prioridade":"alta|media|baixa"}],"deferred":[{"title":"...","why":"..."}],"evidence":[{"quote":"...","source":"..."}]}`;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function prio(v: unknown): PrototypeHeroRoom["prioridade"] {
  const s = str(v);
  if (s === "alta" || s === "media" || s === "baixa") return s;
  return "media";
}

/** Coerce + enforce hero_set ≤ MAX. Safe for pass-through packs. */
export function coercePrototypePack(raw: unknown): PrototypePack {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const heroRaw = Array.isArray(o.hero_set) ? o.hero_set : Array.isArray(o.heroSet) ? o.heroSet : [];
  const hero_set: PrototypeHeroRoom[] = (heroRaw as Record<string, unknown>[])
    .map((r) => ({
      title: str(r.title) || str(r.titulo),
      route: str(r.route) || "/",
      job: str(r.job) || str(r.o_que) || str(r.oQuePediram),
      fake_data: str(r.fake_data) || str(r.fakeData) || "Dados de exemplo",
      prioridade: prio(r.prioridade ?? r.priority),
    }))
    .filter((r) => r.title)
    .slice(0, PROTOTYPE_PACK_MAX_HERO);

  const deferred: PrototypeDeferredItem[] = (
    Array.isArray(o.deferred) ? (o.deferred as Record<string, unknown>[]) : []
  )
    .map((d) => ({ title: str(d.title) || str(d.titulo), why: str(d.why) || str(d.nota) || "fora do Hero" }))
    .filter((d) => d.title);

  const evidence: PrototypeEvidence[] = (
    Array.isArray(o.evidence) ? (o.evidence as Record<string, unknown>[]) : Array.isArray(o.evidencia) ? (o.evidencia as Record<string, unknown>[]) : []
  )
    .map((e) => ({ quote: str(e.quote), source: str(e.source) || str(e.speaker) || undefined }))
    .filter((e) => e.quote)
    .slice(0, 12);

  const constraints = (
    Array.isArray(o.constraints) ? (o.constraints as unknown[]).map(str).filter(Boolean) : []
  );
  return {
    mission: str(o.mission) || "Protótipo frontend navegável para validar a discovery.",
    context: str(o.context) || str(o.contexto),
    constraints: constraints.length ? constraints : [...DEFAULT_CONSTRAINTS],
    design_read: str(o.design_read) || str(o.designRead),
    hero_set,
    deferred,
    evidence,
  };
}

function formatInsumos(insumos: PrototypePackInsumos): string {
  const lines: string[] = [];
  if (insumos.projectName) lines.push(`Projeto: ${insumos.projectName}`);
  if (insumos.description) lines.push(`Descrição: ${insumos.description}`);
  if (insumos.prompt) lines.push(`Pedido / prompt:\n${insumos.prompt}`);
  const pedidos = insumos.pedidos ?? [];
  if (pedidos.length) {
    lines.push(`Pedidos estruturados (${pedidos.length}):`);
    for (const [i, p] of pedidos.entries()) {
      lines.push(
        `${i + 1}. [${p.prioridade ?? "media"}/${p.area ?? "outro"}/${p.tipo ?? "feature"}] ${p.titulo}` +
          (p.oQuePediram ? ` — ${p.oQuePediram}` : "") +
          (p.evidencia ? ` (evidência: ${p.evidencia})` : ""),
      );
    }
  }
  return lines.join("\n") || "(sem insumos — invente o mínimo para um Hero genérico de landing)";
}

/** Enhance: insumos → Pack. Throws MimirError on AI failure. */
export async function enhancePrototypePack(
  insumos: PrototypePackInsumos,
  config: MimirConfig,
): Promise<PrototypePackEnhanceResult> {
  const user = formatInsumos(insumos);
  const models = [config.plannerModel, config.triageModel, config.enhanceModel].filter(
    (m, i, a) => Boolean(m) && a.indexOf(m) === i,
  );
  let lastErr: unknown;
  for (const model of models) {
    try {
      const { text } = await mimirComplete(config, {
        system: SYSTEM,
        user,
        model,
        json: true,
        maxTokens: 6000,
      });
      const parsed = extractJson<unknown>(text);
      if (!parsed || typeof parsed !== "object") {
        throw new MimirError("Resposta inesperada do modelo (Pack).", 502);
      }
      const pack = coercePrototypePack(parsed);
      if (!pack.hero_set.length) {
        throw new MimirError("Pack sem hero_set — Enhance falhou em ranquear salas.", 502);
      }
      return { pack, model, enhanced: true };
    } catch (err) {
      lastErr = err;
      console.warn("[mimir] prototype-pack model failed", model, err instanceof Error ? err.message : err);
    }
  }
  if (lastErr instanceof MimirError) throw lastErr;
  throw new MimirError("Enhance Pack falhou em todos os modelos.", 502);
}
