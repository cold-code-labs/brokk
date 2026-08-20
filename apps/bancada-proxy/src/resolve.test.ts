import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RuntimeSpec } from "@brokk/core";
import { alvoDe, subdomainOf, type BancadaRow } from "./resolve.js";

const SUF = "preview.coldcodelabs.com";

describe("subdomínio", () => {
  it("lê o rótulo da bancada", () => {
    assert.equal(subdomainOf("arte-one-dev.preview.coldcodelabs.com", SUF), "arte-one-dev");
    assert.equal(subdomainOf("ARTE-ONE-DEV.Preview.ColdCodeLabs.com", SUF), "arte-one-dev");
    assert.equal(subdomainOf("arte-one-dev.preview.coldcodelabs.com:443", SUF), "arte-one-dev");
  });

  it("recusa host de fora e rótulo composto", () => {
    assert.equal(subdomainOf("brokk.coldcodelabs.com", SUF), null);
    // `a.b.preview.dominio` não é bancada de ninguém — aceitar isso seria deixar
    // um host inventado escolher o alvo.
    assert.equal(subdomainOf("a.b.preview.coldcodelabs.com", SUF), null);
    assert.equal(subdomainOf("", SUF), null);
  });
});

const row = (over: Partial<BancadaRow> = {}): BancadaRow => ({
  id: "b-1",
  status: "ready",
  ownerName: "ccladmin",
  workspaceName: "arte-one-dev",
  runtimeId: "vite",
  ...over,
});

const vite = { id: "vite" } as RuntimeSpec;
const next = { id: "nextjs" } as RuntimeSpec;

describe("alvo", () => {
  it("aponta para o CONTAINER da bancada, com o nome que o template cria", () => {
    // Se o nome mudar no template, é este teste que grita — não o usuário
    // olhando uma tela em branco.
    assert.deepEqual(alvoDe(row(), vite), {
      host: "bancada-ccladmin-arte-one-dev",
      port: 5173,
    });
  });

  it("usa a porta do runtime", () => {
    assert.equal(alvoDe(row(), next)?.port, 3000);
  });

  it("não serve bancada que não está pronta", () => {
    for (const status of ["provisioning", "stopped", "failed", "deleting"]) {
      assert.equal(alvoDe(row({ status }), vite), null, status);
    }
  });

  it("não inventa dono", () => {
    assert.equal(alvoDe(row({ ownerName: null }), vite), null);
  });
});
