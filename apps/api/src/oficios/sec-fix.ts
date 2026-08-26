/**
 * Ofício `sec-fix` — remediação em massa depois do `sec` (scan).
 *
 * Uma passada = um repositório × onda curta de clusters critical/high.
 * O Brokk comanda via machine API; o **Forge** (bancada-driver) executa o card.
 *
 * Receita do card (espelha o vocabulário do Svalinn: engine + agent + model):
 *   engine = forge · agent = cursor · model = auto
 * Carimbada em `labels` (`engine:forge`, `agent:cursor`, `model:auto`) pelo
 * dispatch do Svalinn; o driver escolhe template Coder `cursor` + lane `forge`.
 *
 * Isolamento: sequenciador serial global + 1 card running por projeto no driver.
 * Storm: não re-despacha cluster já em `failed`/`error` nesta passada; cadência
 * do ofício cobre o par alvo×ofício. Colher é inerte — sem merge, sem `fixed`.
 */

/** Receita Forge do sec-fix — o overnight que funcionou no Svalinn usou cursor/auto. */
export const SEC_FIX_RECIPE = {
  engine: "forge",
  agent: "cursor",
  model: "auto",
} as const;

/** Labels que o Svalinn carimba no card (e o driver lê). */
export function secFixLabels(sev?: string): string[] {
  const base = [
    "remediation",
    "svalinn",
    "sec-fix",
    `engine:${SEC_FIX_RECIPE.engine}`,
    `agent:${SEC_FIX_RECIPE.agent}`,
    `model:${SEC_FIX_RECIPE.model}`,
  ];
  if (sev) base.push(`sev:${sev}`);
  return base;
}

import {
  dispatchCluster,
  getBoard,
  getDispatch,
  getFindings,
  type MachineDispatch,
  type MachineFinding,
  type SvalinnClientOpts,
} from "../svalinn-client.js";
import type { AlvoCandidato, EstadoPassada, Oficio } from "./tipos.js";

const CADENCIA_HORAS = Number(process.env.BROKK_SEC_FIX_CADENCIA_HORAS ?? 24) || 24;
const CAP = Number(process.env.BROKK_SEC_FIX_CAP ?? 3) || 3;
const SEVS = new Set(
  (process.env.BROKK_SEC_FIX_SEVS ?? "critical,high")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

/** Status em voo no Brokk / Svalinn dispatch. */
const ATIVOS = new Set(["backlog", "queued", "running", "review", "revising"]);
/** Terminal com sucesso de forja (PR aberto) — ainda NÃO é finding `fixed`. */
const OK = new Set(["done", "merged"]);
/** Terminal com falha — não re-despachar nesta passada. */
const FALHA = new Set(["failed", "error", "cancelled"]);

export type SecFixPassRef = {
  slug: string;
  clusters: string[];
};

export type SecFixDeps = {
  getBoard: typeof getBoard;
  getFindings: typeof getFindings;
  dispatchCluster: typeof dispatchCluster;
  getDispatch: typeof getDispatch;
  /** Cap de clusters por passada. */
  cap?: number;
  sevs?: Set<string>;
};

export function encodePassRef(r: SecFixPassRef): string {
  return JSON.stringify(r);
}

export function decodePassRef(passRef: string): SecFixPassRef {
  const raw = JSON.parse(passRef) as SecFixPassRef;
  if (!raw?.slug || !Array.isArray(raw.clusters)) {
    throw new Error(`sec-fix passRef inválido: ${passRef.slice(0, 80)}`);
  }
  return raw;
}

/** Agrupa findings abertos por clusterKey, filtra sev, ordena critical→high. */
export function clustersParaFix(
  findings: MachineFinding[],
  sevs: Set<string> = SEVS,
  cap: number = CAP,
): { clusterKey: string; findingIds: string[]; severity: string }[] {
  const by = new Map<string, { ids: string[]; severity: string }>();
  for (const f of findings) {
    const sev = (f.severity ?? "").toLowerCase();
    if (!sevs.has(sev)) continue;
    const key = f.clusterKey;
    if (!key) continue;
    const cur = by.get(key);
    if (cur) cur.ids.push(f.id);
    else by.set(key, { ids: [f.id], severity: sev });
  }
  const rank = (s: string) => (s === "critical" ? 0 : s === "high" ? 1 : 9);
  return [...by.entries()]
    .map(([clusterKey, v]) => ({ clusterKey, findingIds: v.ids, severity: v.severity }))
    .sort((a, b) => rank(a.severity) - rank(b.severity) || a.clusterKey.localeCompare(b.clusterKey))
    .slice(0, Math.max(1, cap));
}

export function estadoDaOnda(dispatches: (MachineDispatch | null)[]): EstadoPassada {
  if (!dispatches.length) return "desconhecida";
  if (dispatches.some((d) => !d)) return "desconhecida";
  const statuses = dispatches.map((d) => d!.status);
  if (statuses.some((s) => ATIVOS.has(s))) return "rodando";
  if (statuses.every((s) => FALHA.has(s))) return "falhou";
  if (statuses.every((s) => OK.has(s) || FALHA.has(s))) return "concluida";
  return "rodando";
}

function clientDeps(svalinn: SvalinnClientOpts): SecFixDeps {
  return {
    getBoard: (o) => getBoard(o ?? svalinn),
    getFindings: (o, slug, status) => getFindings(o ?? svalinn, slug, status),
    dispatchCluster: (o, ck, ids) => dispatchCluster(o ?? svalinn, ck, ids),
    getDispatch: (o, ck) => getDispatch(o ?? svalinn, ck),
  };
}

/** Injeta deps tipadas (testes) ou usa o client HTTP real. */
export function oficioSecFix(
  svalinn: SvalinnClientOpts,
  over: Partial<SecFixDeps> = {},
): Oficio {
  // Bind partial overrides onto a real client — tests pass full fakes via `over`.
  const base = clientDeps(svalinn);
  const deps: SecFixDeps = { ...base, ...over };
  const cap = deps.cap ?? CAP;
  const sevs = deps.sevs ?? SEVS;

  return {
    id: "sec-fix",
    cadenciaHoras: CADENCIA_HORAS,

    async alvos(): Promise<AlvoCandidato[]> {
      // Aqui o board É a fonte certa: só quem tem dívida critical/high.
      const board = await deps.getBoard(svalinn);
      return board
        .filter((r) => (r.critical ?? 0) + (r.high ?? 0) > 0)
        .map((r) => ({
          alvo: r.slug,
          prioridade: (r.critical ?? 0) * 10 + (r.high ?? 0),
        }));
    },

    async iniciar(alvo: string): Promise<string> {
      const findings = await deps.getFindings(svalinn, alvo, "open");
      const clusters = clustersParaFix(findings, sevs, cap);
      if (!clusters.length) {
        throw new Error(`sec-fix ${alvo}: nenhum cluster ${[...sevs].join("/")} aberto`);
      }
      const feitos: string[] = [];
      for (const c of clusters) {
        const d = await deps.dispatchCluster(svalinn, c.clusterKey, c.findingIds);
        if (FALHA.has(d.status)) {
          // Não aborta a onda inteira — colher conta a falha. Continua.
        }
        feitos.push(c.clusterKey);
      }
      return encodePassRef({ slug: alvo, clusters: feitos });
    },

    async estado(passRef: string): Promise<EstadoPassada> {
      const { clusters } = decodePassRef(passRef);
      const dispatches = await Promise.all(
        clusters.map((ck) => deps.getDispatch(svalinn, ck)),
      );
      return estadoDaOnda(dispatches);
    },

    async colher(passRef: string): Promise<unknown> {
      const { slug, clusters } = decodePassRef(passRef);
      const dispatches = await Promise.all(
        clusters.map((ck) => deps.getDispatch(svalinn, ck)),
      );
      const rows = dispatches.map((d, i) => ({
        clusterKey: clusters[i],
        status: d?.status ?? "missing",
        prUrl: d?.prUrl ?? null,
        note: d?.note ?? null,
      }));
      return {
        alvo: slug,
        cards: rows.length,
        ok: rows.filter((r) => OK.has(r.status)).length,
        falhas: rows.filter((r) => FALHA.has(r.status) || r.status === "missing"),
        prs: rows.filter((r) => r.prUrl).map((r) => r.prUrl),
        // Lembrete explícito: promoção não é deste turno.
        gate: "awaiting_verification — merge/fixed ficam fora do ofício",
      };
    },
  };
}
