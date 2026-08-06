import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fingerprint, normalizeTitle } from "./fingerprint.js";

const base = { lensId: "review.correctness", filePath: "src/a.ts" };

describe("finding fingerprint (ADR 0087 §5)", () => {
  // The whole point: a finding keeps its identity while the file around it moves.
  it("is stable across line moves and re-wordings of the same defect", () => {
    const a = fingerprint({ ...base, title: "Member can self-promote to Owner" });
    const b = fingerprint({ ...base, title: "Member can self-promote to owner." });
    assert.equal(a, b);
  });

  it("ignores digits — '216 inline styles' is the same defect as '42 inline styles'", () => {
    assert.equal(
      fingerprint({ ...base, title: "216 inline styles bypass the tokens" }),
      fingerprint({ ...base, title: "42 inline styles bypass the tokens" }),
    );
  });

  it("separates different defects in the same file", () => {
    assert.notEqual(
      fingerprint({ ...base, title: "Member can self-promote to Owner" }),
      fingerprint({ ...base, title: "Missing index on hot query" }),
    );
  });

  it("separates the same defect across files and across lenses", () => {
    const t = "Missing accessible name";
    assert.notEqual(
      fingerprint({ ...base, title: t }),
      fingerprint({ ...base, filePath: "src/b.ts", title: t }),
    );
    assert.notEqual(
      fingerprint({ ...base, title: t }),
      fingerprint({ lensId: "qa.a11y", filePath: base.filePath, title: t }),
    );
  });

  it("normalizes accents and quoted code out of the key", () => {
    assert.equal(normalizeTitle("Sessão `foo()` inválida"), "sessao invalida");
  });
});
