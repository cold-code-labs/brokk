import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Task } from "@brokk/core";
import { briefing, cardBranch } from "./bancada-driver.js";

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
