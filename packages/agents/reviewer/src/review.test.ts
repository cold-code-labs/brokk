import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFindings, stripFindingsBlock } from "./review.js";

const REVIEW = `VERDICT: REQUEST_CHANGES

A policy lets a member escalate to owner.

## Findings
- db/0025.sql:12 — usuarios_update has no column guard

\`\`\`json
{"findings":[
  {"title":"Member can self-promote to Owner","file":"db/0025.sql","line":12,
   "severity":"critical","body":"policy allows role UPDATE",
   "proof":"RLS test: member UPDATE role=owner must fail"},
  {"title":"Reinvite misses users past page 1","file":"api/server.mjs","severity":"low"}
]}
\`\`\``;

describe("Eitri structured findings (ADR 0087)", () => {
  it("parses the machine block and keeps the defect as identity", () => {
    const f = parseFindings(REVIEW);
    assert.equal(f.length, 2);
    assert.equal(f[0]!.title, "Member can self-promote to Owner");
    assert.equal(f[0]!.severity, "critical");
    assert.equal(f[0]!.line, 12);
    assert.ok(f[0]!.proof);
  });

  it("a finding with no named test stays advisory (proof is null, not invented)", () => {
    const f = parseFindings(REVIEW);
    assert.equal(f[1]!.proof, null);
    assert.equal(f[1]!.line, null);
  });

  it("unknown severity degrades to medium instead of throwing", () => {
    const f = parseFindings('```json\n{"findings":[{"title":"x","severity":"apocalyptic"}]}\n```');
    assert.equal(f[0]!.severity, "medium");
  });

  it("drops entries with no title — an untitled finding has no identity", () => {
    const f = parseFindings('```json\n{"findings":[{"severity":"high"},{"title":"real"}]}\n```');
    assert.equal(f.length, 1);
    assert.equal(f[0]!.title, "real");
  });

  // The review is what humans read; it must survive a malformed machine block.
  it("malformed JSON costs the findings, never the review", () => {
    assert.deepEqual(parseFindings("VERDICT: APPROVE\n```json\n{nope\n```"), []);
    assert.deepEqual(parseFindings("VERDICT: APPROVE\n\nAll good."), []);
  });

  it("strips the machine block from the posted comment", () => {
    const body = stripFindingsBlock(REVIEW);
    assert.ok(!body.includes("```json"));
    assert.ok(body.includes("## Findings"));
    assert.ok(body.startsWith("VERDICT: REQUEST_CHANGES"));
  });
});
