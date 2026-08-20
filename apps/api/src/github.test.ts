import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { findInstallationForOwner, loadAppAuth } from "./github.js";

import { generateKeyPairSync } from "node:crypto";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n";
/** Chave real: `findInstallationForOwner` ASSINA um JWT antes de chamar. */
const PEM_VALID = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

describe("loadAppAuth", () => {
  it("aceita a chave inline, que é como ela chega num campo de env", () => {
    const auth = loadAppAuth({ EITRI_APP_ID: "1", EITRI_APP_PRIVATE_KEY: PEM } as NodeJS.ProcessEnv);
    assert.equal(auth?.appId, "1");
    assert.match(auth!.privateKey, /BEGIN RSA PRIVATE KEY/);
  });

  it("desescapa o \\n que um campo de env de uma linha carrega", () => {
    const oneLine = PEM.replaceAll("\n", "\\n");
    const auth = loadAppAuth({ EITRI_APP_ID: "1", EITRI_APP_PRIVATE_KEY: oneLine } as NodeJS.ProcessEnv);
    assert.ok(auth!.privateKey.includes("\n"), "a chave precisa voltar a ter quebras de linha reais");
    assert.ok(!auth!.privateKey.includes("\\n"));
  });

  it("prefere o app dedicado ao do Eitri quando os dois existem", () => {
    const auth = loadAppAuth({
      EITRI_APP_ID: "1",
      EITRI_APP_PRIVATE_KEY: PEM,
      BROKK_GITHUB_APP_ID: "2",
      BROKK_GITHUB_APP_PRIVATE_KEY: PEM,
    } as NodeJS.ProcessEnv);
    assert.equal(auth?.appId, "2");
  });

  it("recusa um valor que não é chave em vez de assinar com lixo", () => {
    assert.equal(
      loadAppAuth({ EITRI_APP_ID: "1", EITRI_APP_PRIVATE_KEY: "coloque-a-chave-aqui" } as NodeJS.ProcessEnv),
      null,
    );
  });
});

describe("findInstallationForOwner", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const auth = { appId: "1", privateKey: PEM_VALID };

  it("acha a instalação pelo dono, sem cair no primeiro da lista", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          { id: 111, account: { login: "outra-org" } },
          { id: 222, account: { login: "Cold-Code-Labs" } },
        ]),
      )) as typeof fetch;
    // Casa sem ligar para maiúscula: o GitHub devolve o login com a grafia do dono.
    assert.equal(await findInstallationForOwner(auth, "cold-code-labs"), "222");
  });

  it("devolve null quando nenhuma instalação cobre o dono", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ id: 111, account: { login: "outra-org" } }]))) as typeof fetch;
    assert.equal(await findInstallationForOwner(auth, "cold-code-labs"), null);
  });
});
