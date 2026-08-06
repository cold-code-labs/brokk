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

  // Regression for the asymmetry Eitri caught reviewing PR #92: parse read the
  // FIRST fence while strip removed the LAST, so a review that quoted JSON (e.g.
  // reviewing a package.json change) parsed the quote and stripped the real block.
  it("reads the LAST json fence, not a snippet quoted mid-review", () => {
    const withQuote = [
      "VERDICT: COMMENT",
      "",
      "The added dependency block:",
      '```json',
      '{"dependencies":{"left-pad":"^1.0.0"}}',
      "```",
      "",
      '```json',
      '{"findings":[{"title":"Real defect","severity":"high"}]}',
      "```",
    ].join("\n");
    const f = parseFindings(withQuote);
    assert.equal(f.length, 1);
    assert.equal(f[0]!.title, "Real defect");
    const body = stripFindingsBlock(withQuote);
    assert.ok(body.includes("left-pad"), "the quoted snippet must survive");
    assert.ok(!body.includes("Real defect"), "the machine block must be stripped");
  });

  it("strips the machine block from the posted comment", () => {
    const body = stripFindingsBlock(REVIEW);
    assert.ok(!body.includes("```json"));
    assert.ok(body.includes("## Findings"));
    assert.ok(body.startsWith("VERDICT: REQUEST_CHANGES"));
  });
});

describe("semantic dedupe hand-off (ADR 0087 §5, layer 2)", () => {
  it("carries same_as through as sameAs", () => {
    const f = parseFindings('```json\n{"findings":[{"title":"x","same_as":"abc-123"}]}\n```');
    assert.equal(f[0]!.sameAs, "abc-123");
  });

  it("an absent or blank same_as is null, never an empty match", () => {
    const f = parseFindings('```json\n{"findings":[{"title":"x"},{"title":"y","same_as":"  "}]}\n```');
    assert.equal(f[0]!.sameAs, null);
    assert.equal(f[1]!.sameAs, null);
  });
});
