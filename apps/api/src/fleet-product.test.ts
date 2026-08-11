import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isProductHeimdallApp, isSidecarProjectName } from "./fleet-product.js";

describe("fleet-product", () => {
  it("hides hauldr sidecars", () => {
    assert.equal(isSidecarProjectName("hauldr-auth-viken"), true);
    assert.equal(isSidecarProjectName("hauldr-rest-arte_one"), true);
    assert.equal(isSidecarProjectName("hauldr"), false);
    assert.equal(isSidecarProjectName("hauldr-panel"), false);
    assert.equal(isSidecarProjectName("viken"), false);
  });

  it("requires a live product app with repo", () => {
    const base = {
      name: "viken",
      slug: "viken",
      status: "running",
      lifecycle: "active",
      repoFullName: "cold-code-labs/viken",
    };
    assert.equal(isProductHeimdallApp(base), true);
    assert.equal(isProductHeimdallApp({ ...base, status: "destroyed" }), false);
    assert.equal(isProductHeimdallApp({ ...base, lifecycle: "terminated" }), false);
    assert.equal(isProductHeimdallApp({ ...base, repoFullName: null }), false);
    assert.equal(
      isProductHeimdallApp({
        ...base,
        name: "hauldr-auth-viken",
        slug: "hauldr-auth-viken",
      }),
      false,
    );
  });
});
