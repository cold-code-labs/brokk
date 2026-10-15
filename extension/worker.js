const allowedOrigins = [
  "https://brokk.a4.ia.br",
  "https://brokk.coldcodelabs.com",
];
async function api(path, body) {
  const { connection } = await chrome.storage.local.get("connection");
  if (!connection || !allowedOrigins.includes(connection.origin))
    throw new Error("Cole a conexão gerada na review do Brokk.");
  const response = await fetch(`${connection.origin}/api/extension/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${connection.token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
    credentials: "omit",
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error ||
        "A conexão falhou. As observações não enviadas estão preservadas.",
    );
  return data;
}
async function flush() {
  return navigator.locks.request("brokk-queue", async () => {
    let { queue = [] } = await chrome.storage.local.get("queue");
    while (queue.length) {
      const batch = queue.slice(0, 15);
      const result = await api("notes", { notes: batch });
      queue = queue.filter((note) => !result.received.includes(note.clientId));
      await chrome.storage.local.set({ queue, error: "" });
    }
  });
}
async function enqueue(note) {
  await navigator.locks.request("brokk-queue", async () => {
    const { queue = [] } = await chrome.storage.local.get("queue");
    if (queue.length >= 500)
      throw new Error(
        "Fila local cheia. Pare a captura e sincronize antes de continuar.",
      );
    if (!queue.some((old) => old.clientId === note.clientId))
      await chrome.storage.local.set({ queue: [...queue, note] });
  });
}
async function capture(start) {
  return navigator.locks.request("brokk-capture", async () => {
    const { captureState = "idle", targetTabId } =
      await chrome.storage.session.get(["captureState", "targetTabId"]);
    if (start) {
      if (captureState !== "idle")
        throw new Error("Já existe uma captura ou sincronização em andamento.");
      const tab = await chrome.tabs.get(targetTabId);
      if (
        !tab.url?.startsWith("https://") ||
        allowedOrigins.includes(new URL(tab.url).origin)
      )
        throw new Error(
          "Abra a aba da chamada e clique no ícone do Brokk nela.",
        );
      await chrome.storage.local.set({ error: "" });
      await chrome.storage.session.set({ captureState: "starting" });
      try {
        if (
          !(
            await chrome.runtime.getContexts({
              contextTypes: ["OFFSCREEN_DOCUMENT"],
            })
          ).length
        ) {
          await chrome.offscreen.createDocument({
            url: "offscreen.html",
            reasons: ["USER_MEDIA"],
            justification:
              "Transcrever o áudio da chamada e o microfone durante a review iniciada pelo operador.",
          });
        }
        // Media stream IDs are short-lived: finish the network request before acquiring one.
        const speech = await api("speech", {});
        const streamId = await chrome.tabCapture.getMediaStreamId({
          targetTabId,
        });
        const result = await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "START",
          streamId,
          speech,
        });
        if (!result?.ok)
          throw new Error(result?.error || "Não foi possível iniciar o áudio.");
        await chrome.storage.session.set({ captureState: "recording" });
        await chrome.action.setBadgeText({ text: "REC" });
        await chrome.action.setBadgeBackgroundColor({ color: "#bd3c29" });
        await chrome.alarms.create("brokk-duration", { delayInMinutes: 119 });
      } catch (error) {
        if (
          (
            await chrome.runtime.getContexts({
              contextTypes: ["OFFSCREEN_DOCUMENT"],
            })
          ).length
        )
          await chrome.offscreen.closeDocument();
        try {
          await api("stop", {});
        } catch {}
        await chrome.storage.session.set({ captureState: "idle" });
        throw error;
      }
    } else {
      await chrome.storage.session.set({ captureState: "stopping" });
      if (
        (
          await chrome.runtime.getContexts({
            contextTypes: ["OFFSCREEN_DOCUMENT"],
          })
        ).length
      )
        await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "PAUSE",
        });
      await flush().catch(() => {});
      if (
        (
          await chrome.runtime.getContexts({
            contextTypes: ["OFFSCREEN_DOCUMENT"],
          })
        ).length
      ) {
        const result = await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "STOP",
        });
        if (!result?.ok)
          throw new Error(result?.error || "Falha ao finalizar áudio.");
        await chrome.offscreen.closeDocument();
      }
      await chrome.action.setBadgeText({ text: "SYNC" });
      await flush();
      await api("stop", {});
      await chrome.storage.session.set({ captureState: "idle" });
      await chrome.alarms.clear("brokk-duration");
      await chrome.action.setBadgeText({ text: "" });
    }
  });
}
async function route(message) {
  if (message.type === "CONNECT") {
    const { queue = [] } = await chrome.storage.local.get("queue");
    const { captureState = "idle" } =
      await chrome.storage.session.get("captureState");
    const { connection: previous } =
      await chrome.storage.local.get("connection");
    const next = JSON.parse(message.value);
    if (
      (queue.length && next.callId !== previous?.callId) ||
      captureState !== "idle"
    )
      throw new Error(
        "Sincronize e pare a review atual antes de trocar de conexão.",
      );
    const connection = JSON.parse(message.value);
    if (
      !allowedOrigins.includes(connection.origin) ||
      !/^[A-Za-z0-9_-]{43}$/.test(connection.token)
    )
      throw new Error("Conexão inválida.");
    await chrome.storage.local.set({ connection });
    return api("session");
  }
  if (message.type === "SESSION") return api("session");
  if (message.type === "START") return capture(true);
  if (message.type === "STOP") return capture(false);
  if (message.type === "FLUSH") return flush();
  if (message.type === "NOTE") {
    await enqueue({
      ...message.note,
      clientId: message.note.clientId || crypto.randomUUID(),
      at: message.note.at || new Date().toISOString(),
    });
    return { queued: true };
  }
  if (message.type === "CAPTURE_ERROR") {
    await chrome.storage.local.set({ error: message.error });
    await chrome.action.setBadgeText({ text: "!" });
    return;
  }
  throw new Error("Ação desconhecida.");
}
chrome.action.onClicked.addListener((tab) => {
  // Opening the panel is the first call, preserving the direct user gesture.
  void chrome.sidePanel.open({ windowId: tab.windowId });
  void chrome.storage.session.set({ targetTabId: tab.id });
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.target === "offscreen" || sender.id !== chrome.runtime.id) return;
  void (async () => {
    try {
      reply({ ok: true, data: await route(message) });
    } catch (error) {
      const description =
        error instanceof Error ? error.message : "A ação falhou.";
      await chrome.storage.local.set({ error: description });
      reply({ ok: false, error: description });
    }
  })();
  return true;
});
chrome.alarms.onAlarm.addListener((alarm) => {
  void (async () => {
    try {
      if (alarm.name === "brokk-duration") await capture(false);
      else await flush();
    } catch (error) {
      await chrome.storage.local.set({ error: error.message });
    }
  })();
});
chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create("brokk-sync", { periodInMinutes: 0.5 });
});
