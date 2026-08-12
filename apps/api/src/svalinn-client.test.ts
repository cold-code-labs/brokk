import assert from "node:assert/strict"
import { test } from "node:test"

import { getBoard } from "./svalinn-client.js"

test("getBoard throws when Svalinn returns non-2xx", async () => {
  const orig = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })) as typeof fetch
  try {
    await assert.rejects(() => getBoard({ baseUrl: "http://svalinn.test", token: "x".repeat(16) }), /svalinn board 401/)
  } finally {
    globalThis.fetch = orig
  }
})

test("getBoard returns board array", async () => {
  const orig = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ board: [{ slug: "hauldr", open: 1, high: 1 }] }), { status: 200 })) as typeof fetch
  try {
    const board = await getBoard({ baseUrl: "http://svalinn.test/", token: "x".repeat(16) })
    assert.equal(board[0]?.slug, "hauldr")
  } finally {
    globalThis.fetch = orig
  }
})
