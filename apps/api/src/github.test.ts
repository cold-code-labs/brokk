import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadAppAuth } from "./github.js";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n";

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
