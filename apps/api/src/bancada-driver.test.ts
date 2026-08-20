import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Task } from "@brokk/core";
import { briefing, cardBranch, valeAbrir } from "./bancada-driver.js";

const task = {
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  title: "Corrigir a máscara de CPF na inscrição",
  body: "O campo aceita 12 dígitos.",
  acceptance: "Digitar 12 dígitos mostra erro.",
} as unknown as Task;

describe("briefing do card", () => {
  it("carrega o contrato de conclusão junto com o pedido", () => {
    const b = briefing(task, "brokk/x-aaaaaaaa", "dev");
    assert.match(b, /Corrigir a máscara/);
    assert.match(b, /Digitar 12 dígitos mostra erro/);
    // O sentinela precisa estar no texto: é a única afirmação explícita de
    // "terminei" que o driver tem para ler.
    assert.match(b, /BROKK-DONE brokk\/x-aaaaaaaa/);
    // E o caminho da credencial precisa ser dito, senão o agente tenta
    // configurar um token que não existe ali dentro.
    assert.match(b, /brokerada/);
  });

  it("não inventa descrição quando o card não tem", () => {
    const b = briefing({ ...task, body: "" } as Task, "brokk/y", "dev");
    assert.match(b, /\(sem descrição\)/);
  });
});

describe("branch do card", () => {
  it("é estável e derivada do id, para uma retomada achar o que já foi empurrado", () => {
    assert.equal(cardBranch(task), cardBranch(task));
    assert.match(cardBranch(task), /^brokk\/.*-aaaaaaaa$/);
  });

  it("tira acento e caractere que o git não quer no nome", () => {
    const b = cardBranch(task);
    assert.ok(!/[^\x20-\x7e]/.test(b), `branch com caractere não-ascii: ${b}`);
    assert.match(b, /^brokk\/[a-z0-9-]+$/);
  });

  it("não estoura o nome com um título quilométrico", () => {
    const longo = { ...task, title: "a".repeat(300) } as Task;
    assert.ok(cardBranch(longo).length <= 60, cardBranch(longo));
  });
});

describe("quando vale pedir a bancada", () => {
  const agora = Date.parse("2026-08-20T12:00:00Z");
  const em = (min: number) => new Date(agora - min * 60_000).toISOString();

  it("pede quando não existe nenhuma", () => {
    assert.equal(valeAbrir(null, agora), true);
  });

  it("não pede de novo enquanto uma está subindo", () => {
    assert.equal(valeAbrir({ status: "provisioning", updatedAt: em(1) }, agora), false);
  });

  it("segura a mão numa que ACABOU de falhar", () => {
    // Sem isto o laço chamaria `ensure` a cada tick: segredo novo + build novo,
    // três vezes por minuto, num projeto que já se sabe quebrado.
    assert.equal(valeAbrir({ status: "failed", updatedAt: em(2) }, agora), false);
  });

  it("tenta de novo depois do intervalo", () => {
    assert.equal(valeAbrir({ status: "failed", updatedAt: em(11) }, agora), true);
  });

  it("religa uma parada sem esperar nada", () => {
    assert.equal(valeAbrir({ status: "stopped", updatedAt: em(0) }, agora), true);
  });
});
