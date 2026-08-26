import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clustersParaFix,
  decodePassRef,
  encodePassRef,
  estadoDaOnda,
  oficioSecFix,
  SEC_FIX_RECIPE,
  secFixLabels,
  type SecFixDeps,
} from "./sec-fix.js";
import { recipeDoCard } from "../bancada-driver.js";
import type { MachineDispatch, MachineFinding, SvalinnClientOpts } from "../svalinn-client.js";

const opts: SvalinnClientOpts = { baseUrl: "http://svalinn.test", token: "x".repeat(16) };

function finding(over: Partial<MachineFinding> & { id: string; clusterKey: string }): MachineFinding {
  return {
    engine: "semgrep",
    severity: "high",
    title: "x",
    slug: "rule",
    location: null,
    body: null,
    status: "open",
    class: null,
    targetSlug: "arte",
    targetRepoUrl: "https://github.com/cold-code-labs/arte",
    ...over,
  };
}

function dispatch(over: Partial<MachineDispatch> & { clusterKey: string }): MachineDispatch {
  return {
    taskId: "t1",
    projectId: "p1",
    status: "queued",
    prUrl: null,
    title: "fix",
    note: null,
    ...over,
  };
}

function deps(over: Partial<SecFixDeps> = {}): {
  d: SecFixDeps;
  disparos: { clusterKey: string; ids: string[] }[];
  estados: Map<string, MachineDispatch>;
  oficio: () => ReturnType<typeof oficioSecFix>;
} {
  const disparos: { clusterKey: string; ids: string[] }[] = [];
  const estados = new Map<string, MachineDispatch>();
  const d: SecFixDeps = {
    async getBoard() {
      return [
        { slug: "arte", name: "Arte", repoUrl: null, defaultBranch: "main", open: 3, high: 2, critical: 1, bug: 0, medium: 0, low: 0, codeBug: 0, noise: 0, processPolicy: 0, systemicInfra: 0, awaitingVerification: 0 },
        { slug: "limpo", name: "Limpo", repoUrl: null, defaultBranch: "main", open: 1, high: 0, critical: 0, bug: 0, medium: 1, low: 0, codeBug: 0, noise: 0, processPolicy: 0, systemicInfra: 0, awaitingVerification: 0 },
      ];
    },
    async getFindings(_o, slug) {
      if (slug !== "arte") return [];
      return [
        finding({ id: "1", clusterKey: "a|crit", severity: "critical" }),
        finding({ id: "2", clusterKey: "a|high1", severity: "high" }),
        finding({ id: "3", clusterKey: "a|high1", severity: "high" }),
        finding({ id: "4", clusterKey: "a|med", severity: "medium" }),
        finding({ id: "5", clusterKey: "a|high2", severity: "high" }),
      ];
    },
    async dispatchCluster(_o, clusterKey, findingIds) {
      disparos.push({ clusterKey, ids: findingIds });
      const d0 = dispatch({ clusterKey, status: "queued" });
      estados.set(clusterKey, d0);
      return d0;
    },
    async getDispatch(_o, clusterKey) {
      return estados.get(clusterKey) ?? null;
    },
    cap: 3,
    ...over,
  };
  return { d, disparos, estados, oficio: () => oficioSecFix(opts, d) };
}

describe("clustersParaFix", () => {
  it("só critical/high, agrupa por cluster, critical primeiro, respeita cap", () => {
    const out = clustersParaFix(
      [
        finding({ id: "1", clusterKey: "h2", severity: "high" }),
        finding({ id: "2", clusterKey: "c1", severity: "critical" }),
        finding({ id: "3", clusterKey: "h2", severity: "high" }),
        finding({ id: "4", clusterKey: "m", severity: "medium" }),
        finding({ id: "5", clusterKey: "h1", severity: "high" }),
      ],
      new Set(["critical", "high"]),
      2,
    );
    assert.deepEqual(
      out.map((c) => ({ k: c.clusterKey, n: c.findingIds.length })),
      [
        { k: "c1", n: 1 },
        { k: "h1", n: 1 },
      ],
    );
  });
});

describe("estadoDaOnda", () => {
  it("qualquer ativo → rodando", () => {
    assert.equal(
      estadoDaOnda([dispatch({ clusterKey: "a", status: "done" }), dispatch({ clusterKey: "b", status: "running" })]),
      "rodando",
    );
  });
  it("todos failed → falhou", () => {
    assert.equal(
      estadoDaOnda([dispatch({ clusterKey: "a", status: "failed" }), dispatch({ clusterKey: "b", status: "error" })]),
      "falhou",
    );
  });
  it("mix done+failed → concluida (colher conta falhas)", () => {
    assert.equal(
      estadoDaOnda([dispatch({ clusterKey: "a", status: "done" }), dispatch({ clusterKey: "b", status: "failed" })]),
      "concluida",
    );
  });
  it("dispatch sumido → desconhecida", () => {
    assert.equal(estadoDaOnda([null]), "desconhecida");
  });
});

describe("ofício sec-fix", () => {
  it("receita Forge = engine forge · agent cursor · model auto", () => {
    assert.deepEqual(SEC_FIX_RECIPE, { engine: "forge", agent: "cursor", model: "auto" });
    const labels = secFixLabels("high");
    assert.ok(labels.includes("engine:forge"));
    assert.ok(labels.includes("agent:cursor"));
    assert.ok(labels.includes("model:auto"));
    assert.ok(labels.includes("sev:high"));
    assert.ok(labels.includes("sec-fix"));
  });

  it("alvos só do board com critical/high — limpo com medium não entra", async () => {
    const { oficio } = deps();
    const alvos = await oficio().alvos();
    assert.deepEqual(alvos.map((a) => a.alvo), ["arte"]);
    assert.ok((alvos[0]?.prioridade ?? 0) >= 12);
  });

  it("iniciar despacha até o cap e devolve passRef estável", async () => {
    const ctx = deps();
    const ref = await ctx.oficio().iniciar("arte");
    const decoded = decodePassRef(ref);
    assert.equal(decoded.slug, "arte");
    assert.equal(decoded.clusters.length, 3);
    assert.equal(ctx.disparos.length, 3);
    // critical primeiro
    assert.equal(ctx.disparos[0]?.clusterKey, "a|crit");
    // high1 agrupa 2 findings
    const h1 = ctx.disparos.find((d) => d.clusterKey === "a|high1");
    assert.deepEqual(h1?.ids, ["2", "3"]);
  });

  it("sem cluster elegível falha ao iniciar — não fica pendente", async () => {
    const { oficio } = deps({
      async getFindings() {
        return [finding({ id: "1", clusterKey: "m", severity: "medium" })];
      },
    });
    await assert.rejects(() => oficio().iniciar("arte"), /nenhum cluster/);
  });

  it("estado acompanha a onda até concluida; colher é inerte", async () => {
    const ctx = deps();
    const o = ctx.oficio();
    const ref = await o.iniciar("arte");
    assert.equal(await o.estado(ref), "rodando");

    for (const ck of decodePassRef(ref).clusters) {
      ctx.estados.set(ck, dispatch({ clusterKey: ck, status: "done", prUrl: `https://gh/${ck}` }));
    }
    assert.equal(await o.estado(ref), "concluida");
    const colhido = (await o.colher(ref)) as {
      ok: number;
      prs: string[];
      gate: string;
      falhas: unknown[];
    };
    assert.equal(colhido.ok, 3);
    assert.equal(colhido.prs.length, 3);
    assert.equal(colhido.falhas.length, 0);
    assert.match(colhido.gate, /awaiting_verification/);
  });

  it("passRef round-trip", () => {
    const raw = encodePassRef({ slug: "arte", clusters: ["a|b", "c|d"] });
    assert.deepEqual(decodePassRef(raw), { slug: "arte", clusters: ["a|b", "c|d"] });
  });

  it("driver lê labels sec-fix → template cursor + lane forge", () => {
    const r = recipeDoCard({ labels: secFixLabels("critical") });
    assert.equal(r.engine, "forge");
    assert.equal(r.agent, "cursor");
    assert.equal(r.model, "auto");
    assert.equal(r.template, "cursor");
    assert.equal(r.lane, "forge");
  });
});
