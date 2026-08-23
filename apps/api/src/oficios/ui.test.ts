import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { briefingUi, oficioUi, type UiDeps } from "./ui.js";

const bancada = { id: "b1", workspaceName: "washinn-mobile-dev" };

/** Fakes tipados como o que o ofício de fato usa. O `as unknown as UiDeps` no
 *  fim é deliberado: o Store real tem dezenas de métodos e o ofício toca dois. */
type Falso = {
  store: { listProjects(): Promise<unknown[]>; getBancada(id: string): Promise<unknown> };
  bancadas: {
    ensure(id: string): Promise<unknown>;
    agentSend(b: unknown, c: string): Promise<{ ok: boolean; reason?: string }>;
    agentMessages(b: unknown): Promise<{ content: string }[]>;
  };
  alvos: string[];
};

function deps(over: Partial<Falso> = {}) {
  const enviados: string[] = [];
  const d: Falso = {
    store: {
      async listProjects() { return [{ id: "p1", name: "washinn-mobile" }]; },
      async getBancada() { return bancada; },
    },
    bancadas: {
      async ensure() { return bancada; },
      async agentSend(_b: unknown, c: string) { enviados.push(c); return { ok: true }; },
      async agentMessages() { return [{ content: "trabalhando…" }]; },
    },
    alvos: ["washinn-mobile"],
    ...over,
  };
  return { enviados, d, ui: () => oficioUi(d as unknown as UiDeps) };
}

describe("briefing da passada de ui", () => {
  it("carrega o contrato de conclusão — é a única afirmação de fim que temos", () => {
    const b = briefingUi("washinn-mobile");
    assert.match(b, /BROKK-UI assurance\/critica-ui\.md/);
    assert.match(b, /BROKK-UI-FALHOU/);
  });
  it("manda o inventário sair do spec, não de lista à mão", () => {
    assert.match(briefingUi("x"), /assurance\/spec\.yaml/);
    assert.match(briefingUi("x"), /não monte lista de rota à mão/);
  });
  it("proíbe mexer em código de produto — a passada observa", () => {
    assert.match(briefingUi("x"), /NÃO altere código de produto/);
  });
  it("pede os dois temas, que é onde estão os achados", () => {
    assert.match(briefingUi("x"), /Compare os dois temas/);
  });
});

describe("ofício ui", () => {
  it("só enxerga alvo configurado", async () => {
    const { ui } = deps({ alvos: [] });
    assert.deepEqual(await ui().alvos(), []);
  });

  it("iniciar garante a bancada e entrega o briefing", async () => {
    const { enviados, ui } = deps();
    const ref = await ui().iniciar("washinn-mobile");
    assert.equal(ref, "b1");
    assert.equal(enviados.length, 1);
    assert.match(enviados[0], /pnpm ui:sweep/);
  });

  it("projeto desconhecido falha ao iniciar, não fica pendente", async () => {
    const { ui } = deps();
    await assert.rejects(() => ui().iniciar("nao-existe"), /projeto desconhecido/);
  });

  it("bancada que recusa o briefing falha — não fica em voo até o teto", async () => {
    const { d, ui } = deps();
    d.bancadas.agentSend = async () => ({ ok: false, reason: "stabilize" });
    await assert.rejects(() => ui().iniciar("washinn-mobile"), /bancada recusou/);
  });

  it("sem sentinela, segue rodando", async () => {
    const { ui } = deps();
    assert.equal(await ui().estado("b1"), "rodando");
  });

  it("sentinela de pronto conclui, mesmo no meio de um relatório", async () => {
    const { d, ui } = deps();
    d.bancadas.agentMessages = async () => [
      { content: "Achei 3 coisas.\n\nBROKK-UI assurance/critica-ui.md\n\nDetalhes acima." },
    ];
    const o = ui();
    assert.equal(await o.estado("b1"), "concluida");
    const colhido = (await o.colher("b1")) as { relatorio: string };
    assert.equal(colhido.relatorio, "assurance/critica-ui.md");
  });

  it("🔴 sentinela de falha é terminal — senão a fila serial espera à toa", async () => {
    const { d, ui } = deps();
    d.bancadas.agentMessages = async () => [{ content: "sem preview de pé. BROKK-UI-FALHOU" }];
    assert.equal(await ui().estado("b1"), "falhou");
  });

  it("bancada sumida é desconhecida, não rodando para sempre", async () => {
    const { d, ui } = deps();
    d.store.getBancada = async () => null;
    assert.equal(await ui().estado("b1"), "desconhecida");
  });
});
