import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { readConfig } from "../server/config.ts";
import { analyzeCall } from "../server/review.ts";
import type { Artifact } from "../shared/domain.ts";
import { emptyData } from "../shared/domain.ts";

test("AI review validates grounding and fails visibly without losing transcript", async () => {
  const noteId = randomUUID(),
    call: Artifact = {
      id: randomUUID(),
      projectId: randomUUID(),
      kind: "call",
      title: "Review",
      status: "active",
      version: 2,
      author: "team@example.com",
      updatedAt: new Date().toISOString(),
      data: {
        ...emptyData(),
        notes: [
          {
            id: noteId,
            body: "Adicionar botão de contato",
            category: "decision",
            source: "transcript",
            screenId: "",
            author: "team@example.com",
            at: new Date().toISOString(),
          },
        ],
      },
    };
  const cfg = readConfig({
    BROKK_DATABASE_URL: "postgresql://localhost/brokk_test",
  });
  await assert.rejects(analyzeCall(call, cfg), /análise da transcrição/);
  cfg.review = {
    speechKey: "",
    gatewayUrl: "https://ai.example.com/v1",
    gatewayKey: "test-only",
    model: "test",
  };
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Solicitado botão de contato.",
                proposals: [
                  {
                    title: "Adicionar contato",
                    body: "Adicionar botão de contato",
                    acceptance: "Botão abre contato",
                    noteIds: [noteId],
                  },
                ],
              }),
            },
          },
        ],
      });
    const result = await analyzeCall(call, cfg);
    assert.equal(result?.proposals[0].noteIds[0], noteId);
    globalThis.fetch = async () =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Resumo",
                proposals: [
                  {
                    title: "Invented",
                    body: "invented",
                    acceptance: "invented",
                    noteIds: [randomUUID()],
                  },
                ],
              }),
            },
          },
        ],
      });
    await assert.rejects(analyzeCall(call, cfg), /resultado inválido/);
    assert.equal(call.data.notes.length, 1);
    assert.equal(call.status, "active");
  } finally {
    globalThis.fetch = original;
  }
});
