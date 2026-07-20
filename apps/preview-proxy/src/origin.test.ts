import assert from "node:assert/strict";
import { test } from "node:test";
import { devOriginFor, isDevAssetPath, originAllowed } from "./origin.js";

const HOST = "bragi-dev.preview.coldcodelabs.com";

test("o iframe do preview (same-origin) passa", () => {
  assert.equal(originAllowed(`https://${HOST}`, HOST), true);
});

test("origem de terceiro é recusada — este é o ataque que a reescrita laundraria", () => {
  assert.equal(originAllowed("https://evil.com", HOST), false);
});

test("origem opaca (null) é recusada", () => {
  assert.equal(originAllowed("null", HOST), false);
});

test("ausência de Origin passa — dev client nativo (Expo) não manda", () => {
  assert.equal(originAllowed(undefined, HOST), true);
});

test("Origin duplicado (array) é recusado em vez de escolher um", () => {
  assert.equal(originAllowed([`https://${HOST}`, "https://evil.com"], HOST), false);
});

test("sem Host não há com o que comparar → recusa", () => {
  assert.equal(originAllowed(`https://${HOST}`, undefined), false);
});

test("prefixo de host não basta (evita bragi-dev.preview.coldcodelabs.com.evil.com)", () => {
  assert.equal(originAllowed(`https://${HOST}.evil.com`, HOST), false);
});

test("a origem reescrita é a que o Next allowlista por padrão", () => {
  assert.equal(devOriginFor(4102), "http://localhost:4102");
});

test("caminhos dev do Next e do Metro são reconhecidos", () => {
  for (const p of ["/_next/webpack-hmr", "/__nextjs_font/x", "/hot", "/message", "/index.bundle?x=1"]) {
    assert.equal(isDevAssetPath(p), true, p);
  }
});

test("rota de página NÃO é caminho dev — Server Action depende do Origin real", () => {
  for (const p of ["/", "/estudio", "/api/estudio/imagem"]) {
    assert.equal(isDevAssetPath(p), false, p);
  }
});
