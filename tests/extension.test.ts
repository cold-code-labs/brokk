import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("extension acquires short-lived media IDs after network I/O, serializes start and bounds durable sync batches", async () => {
  const local: Record<string, unknown> = {
      connection: { origin: "https://brokk.a4.ia.br", token: "a".repeat(43) },
    },
    session: Record<string, unknown> = {
      captureState: "idle",
      targetTabId: 12,
    };
  const storage = (data: Record<string, unknown>) => ({
    get: async (keys: string | string[]) =>
      Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map((key) => [key, data[key]]),
      ),
    set: async (value: Record<string, unknown>) => {
      Object.assign(data, value);
    },
  });
  let handler: (
      message: unknown,
      sender: unknown,
      reply: (data: unknown) => void,
    ) => void = () => {},
    acquiredAt = 0,
    captures = 0;
  const batches: number[] = [];
  const locks = new Map<string, Promise<unknown>>();
  const chrome = {
    storage: { local: storage(local), session: storage(session) },
    runtime: {
      id: "brokk-test",
      getContexts: async () => [{}],
      sendMessage: async (message: { type: string }) => {
        if (message.type === "START")
          assert.ok(
            Date.now() - acquiredAt < 20,
            "media ID expired while waiting on network",
          );
        return { ok: true };
      },
      onMessage: {
        addListener: (fn: typeof handler) => {
          handler = fn;
        },
      },
      onInstalled: { addListener: () => {} },
    },
    offscreen: {
      createDocument: async () => {},
      closeDocument: async () => {},
    },
    tabs: {
      get: async () => ({ url: "https://meet.google.com/abc-defg-hij" }),
    },
    tabCapture: {
      getMediaStreamId: async () => {
        captures++;
        acquiredAt = Date.now();
        return "short-lived";
      },
    },
    sidePanel: { open: async () => {} },
    action: {
      onClicked: { addListener: () => {} },
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
    alarms: {
      create: async () => {},
      clear: async () => {},
      onAlarm: { addListener: () => {} },
    },
  };
  runInNewContext(
    await readFile(new URL("../extension/worker.js", import.meta.url), "utf8"),
    {
      chrome,
      crypto: globalThis.crypto,
      URL,
      AbortSignal,
      fetch: async (url: string, options: { body?: string }) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (url.endsWith("/notes")) {
          const notes = JSON.parse(options.body || "{}").notes;
          batches.push(notes.length);
          return Response.json({
            received: notes.map((n: { clientId: string }) => n.clientId),
          });
        }
        return Response.json({ token: "temporary-speech-token" });
      },
      navigator: {
        locks: {
          request: (name: string, fn: () => Promise<unknown>) => {
            const next = (locks.get(name) || Promise.resolve())
              .catch(() => {})
              .then(fn);
            locks.set(name, next);
            return next;
          },
        },
      },
    },
  );
  const send = (type: string, extra: Record<string, unknown> = {}) =>
    new Promise<{ ok: boolean; error?: string }>((resolve) =>
      handler({ type, ...extra }, { id: "brokk-test" }, (value) =>
        resolve(value as { ok: boolean; error?: string }),
      ),
    );
  const starts = await Promise.all([send("START"), send("START")]);
  assert.deepEqual(
    starts.map((s) => s.ok),
    [true, false],
  );
  assert.equal(captures, 1);
  assert.equal(session.captureState, "recording");
  const note = {
    clientId: randomUUID(),
    body: "A".repeat(4000),
    category: "change",
    source: "manual",
    at: new Date().toISOString(),
  };
  await send("NOTE", { note });
  await send("NOTE", { note });
  assert.equal((local.queue as unknown[]).length, 1);
  for (let i = 0; i < 16; i++)
    await send("NOTE", { note: { ...note, clientId: randomUUID() } });
  assert.equal((await send("STOP")).ok, true);
  assert.deepEqual(batches, [15, 2]);
  assert.equal(session.captureState, "idle");
  assert.equal((local.queue as unknown[]).length, 0);
});
