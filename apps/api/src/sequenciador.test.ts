import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Passada, Store } from "@brokk/db";
import { estourouTeto, ordenarCandidatos, passo } from "./sequenciador.js";
import { venceu } from "./oficios/tipos.js";
import type { EstadoPassada, Oficio } from "./oficios/tipos.js";

const H = 3_600_000;

function passada(p: Partial<Passada> = {}): Passada {
  return {
    id: "p1", oficio: "sec", alvo: "maglink", estado: "pendente", prioridade: 0,
    passRef: null, artefato: null, erro: null, iniciadaEm: null, terminadaEm: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...p,
  };
}

/** Store de mentira que só sabe o que o sequenciador usa — e grava as chamadas
 *  para o teste afirmar sobre elas. */
function fakeStore(inicial: {
  emVoo?: Passada | null;
  proxima?: Passada | null;
  ultima?: Passada | null;
}) {
  const chamadas: string[] = [];
  const enfileiradas: { oficio: string; alvo: string }[] = [];
  const abertas = new Set<string>();
  const store = {
    async passadaEmVoo() { return inicial.emVoo ?? null; },
    async proximaPassadaPendente() { return inicial.proxima ?? null; },
    async ultimaPassadaTerminal() { return inicial.ultima ?? null; },
    async enfileirarPassada(i: { oficio: string; alvo: string }) {
      const k = `${i.oficio}/${i.alvo}`;
      if (abertas.has(k)) return null;          // já há uma aberta para o par
      abertas.add(k);
      enfileiradas.push({ oficio: i.oficio, alvo: i.alvo });
      return passada(i);
    },
    async marcarPassadaRodando(id: string, ref: string) {
      chamadas.push(`rodando:${id}:${ref}`);
      return passada({ id, estado: "rodando", passRef: ref });
    },
    async fecharPassada(id: string, estado: string, d?: { erro?: string }) {
      chamadas.push(`fechar:${id}:${estado}${d?.erro ? `:${d.erro}` : ""}`);
      return passada({ id, estado: estado as Passada["estado"] });
    },
  } as unknown as Store;
  return { store, chamadas, enfileiradas };
}

function fakeOficio(over: Partial<Oficio> & { estadoDevolve?: EstadoPassada } = {}) {
  const log: string[] = [];
  const o: Oficio = {
    id: "sec",
    cadenciaHoras: 168,
    async alvos() { log.push("alvos"); return [{ alvo: "maglink", prioridade: 1 }]; },
    async iniciar(alvo) { log.push(`iniciar:${alvo}`); return "ref-1"; },
    async estado() { log.push("estado"); return over.estadoDevolve ?? "rodando"; },
    async colher() { log.push("colher"); return { ok: true }; },
    ...over,
  };
  return { oficio: o, log };
}

describe("venceu", () => {
  const agora = Date.parse("2026-08-22T12:00:00Z");
  const ok = (h: number) => ({ estado: "concluida", terminadaEm: new Date(agora - h * H).toISOString() });
  const falha = (h: number) => ({ estado: "falhou", terminadaEm: new Date(agora - h * H).toISOString() });

  it("par que nunca rodou está vencido — é assim que a frota entra na 1ª noite", () => {
    assert.equal(venceu(null, 168, agora), true);
    assert.equal(venceu(undefined, 168, agora), true);
    assert.equal(venceu({ estado: "concluida", terminadaEm: null }, 168, agora), true);
  });
  it("dentro da cadência não volta para a fila", () => {
    assert.equal(venceu(ok(10), 168, agora), false);
  });
  it("passada a cadência, volta", () => {
    assert.equal(venceu(ok(169), 168, agora), true);
  });
  it("data podre não trava o par para sempre", () => {
    assert.equal(venceu({ estado: "concluida", terminadaEm: "nao-e-data" }, 168, agora), true);
  });

  // 🔴 A regressão que aconteceu em produção: o portifolio-lp (repo vazio)
  // falhava instantaneamente, voltava para a fila no tick seguinte, e em 10
  // minutos tinha 7 tentativas com o resto da fila parado atrás.
  it("🔴 falha NÃO volta no tick seguinte — é o storm de retry", () => {
    assert.equal(venceu(falha(0.01), 168, agora), false, "1 minuto depois não pode voltar");
    assert.equal(venceu(falha(1), 168, agora), false);
  });
  it("falha espera menos que a cadência — problema transitório se resolve no mesmo dia", () => {
    assert.equal(venceu(falha(7), 168, agora), true, "6h de backoff, então 7h já volta");
    assert.equal(venceu(ok(7), 168, agora), false, "sucesso ainda espera a cadência inteira");
  });
  it("cadência curta manda no backoff — nunca espera mais que a própria cadência", () => {
    assert.equal(venceu(falha(3), 2, agora), true);
  });
});

describe("estourouTeto", () => {
  const agora = Date.parse("2026-08-22T12:00:00Z");
  it("passada recém-iniciada não estourou", () => {
    assert.equal(estourouTeto(new Date(agora - 60_000).toISOString(), 4 * H, agora), false);
  });
  it("sem iniciadaEm nunca estourou", () => {
    assert.equal(estourouTeto(null, 4 * H, agora), false);
  });
  it("acima do teto, estourou", () => {
    assert.equal(estourouTeto(new Date(agora - 5 * H).toISOString(), 4 * H, agora), true);
  });
});

describe("ordenarCandidatos", () => {
  it("maior prioridade primeiro, empate estável pelo nome", () => {
    const r = ordenarCandidatos([
      { alvo: "zyramed", prioridade: 1 },
      { alvo: "arte", prioridade: 9 },
      { alvo: "bragi", prioridade: 1 },
    ]);
    assert.deepEqual(r.map((x) => x.alvo), ["arte", "bragi", "zyramed"]);
  });
  it("não muda o array de entrada", () => {
    const entrada = [{ alvo: "b", prioridade: 1 }, { alvo: "a", prioridade: 2 }];
    ordenarCandidatos(entrada);
    assert.equal(entrada[0].alvo, "b");
  });
});

describe("o passo do sequenciador", () => {
  it("🔴 com uma passada em voo, NÃO começa outra — é a trava do serial", async () => {
    const { store, chamadas } = fakeStore({
      emVoo: passada({ id: "voando", estado: "rodando", passRef: "ref-1", iniciadaEm: new Date().toISOString() }),
      proxima: passada({ id: "esperando" }),
    });
    const { oficio, log } = fakeOficio({ estadoDevolve: "rodando" });
    await passo({ store, oficios: [oficio] });

    assert.ok(log.includes("estado"), "devia ter perguntado o estado da que está em voo");
    assert.ok(!log.some((l) => l.startsWith("iniciar")), "NÃO podia ter iniciado outra");
    assert.deepEqual(chamadas, [], "nada foi fechado nem marcado");
  });

  it("quando a de voo conclui, colhe o artefato e fecha", async () => {
    const { store, chamadas } = fakeStore({
      emVoo: passada({ id: "voando", estado: "rodando", passRef: "ref-1", iniciadaEm: new Date().toISOString() }),
    });
    const { oficio, log } = fakeOficio({ estadoDevolve: "concluida" });
    await passo({ store, oficios: [oficio] });

    assert.ok(log.includes("colher"), "colher precisa rodar antes de fechar");
    assert.deepEqual(chamadas, ["fechar:voando:concluida"]);
  });

  it("estado terminal de falha fecha dizendo qual foi", async () => {
    const { store, chamadas } = fakeStore({
      emVoo: passada({ id: "voando", estado: "rodando", passRef: "ref-1", iniciadaEm: new Date().toISOString() }),
    });
    const { oficio } = fakeOficio({ estadoDevolve: "falhou" });
    await passo({ store, oficios: [oficio] });
    assert.deepEqual(chamadas, ["fechar:voando:falhou:estado falhou"]);
  });

  it("estourar o teto fecha a passada em vez de segurar a fila para sempre", async () => {
    const antiga = new Date(Date.now() - 9 * H).toISOString();
    const { store, chamadas } = fakeStore({
      emVoo: passada({ id: "presa", estado: "rodando", passRef: "ref-1", iniciadaEm: antiga }),
    });
    const { oficio, log } = fakeOficio({ estadoDevolve: "rodando" });
    await passo({ store, oficios: [oficio], timeoutMs: 4 * H });

    assert.ok(!log.includes("estado"), "nem pergunta: o teto já decidiu");
    assert.match(chamadas[0], /^fechar:presa:falhou:estourou o teto/);
  });

  it("fila livre: gera, enfileira e inicia a próxima", async () => {
    const { store, chamadas, enfileiradas } = fakeStore({
      emVoo: null,
      proxima: passada({ id: "p1", alvo: "maglink" }),
      ultima: null,
    });
    const { oficio, log } = fakeOficio();
    await passo({ store, oficios: [oficio] });

    assert.deepEqual(enfileiradas, [{ oficio: "sec", alvo: "maglink" }]);
    assert.ok(log.includes("iniciar:maglink"));
    assert.deepEqual(chamadas, ["rodando:p1:ref-1"]);
  });

  it("🔴 falha ao INICIAR fecha a linha — fila travada num alvo recusado é pior", async () => {
    const { store, chamadas } = fakeStore({
      emVoo: null,
      proxima: passada({ id: "p1", alvo: "affine" }),
    });
    const { oficio } = fakeOficio({
      async iniciar() { throw new Error("alvo untrusted"); },
    });
    await passo({ store, oficios: [oficio] });
    assert.deepEqual(chamadas, ["fechar:p1:falhou:alvo untrusted"]);
  });

  it("gerador cego não derruba o turno — o que já está na fila continua", async () => {
    const { store, chamadas } = fakeStore({
      emVoo: null,
      proxima: passada({ id: "p1", alvo: "maglink" }),
    });
    const { oficio } = fakeOficio({
      async alvos() { throw new Error("svalinn board 503"); },
    });
    await passo({ store, oficios: [oficio] });
    assert.deepEqual(chamadas, ["rodando:p1:ref-1"], "a pendente ainda foi iniciada");
  });

  it("passada de ofício desligado é fechada, não fica em voo para sempre", async () => {
    const { store, chamadas } = fakeStore({
      emVoo: passada({ id: "orfa", oficio: "qa", estado: "rodando", passRef: "x", iniciadaEm: new Date().toISOString() }),
    });
    const { oficio } = fakeOficio();
    await passo({ store, oficios: [oficio] });
    assert.deepEqual(chamadas, ["fechar:orfa:falhou:ofício desligado: qa"]);
  });
});
