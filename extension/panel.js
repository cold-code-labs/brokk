const $ = (id) => document.getElementById(id);
async function send(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...extra });
  if (!result?.ok)
    throw new Error(result?.error || "Não foi possível concluir.");
  return result.data;
}
async function action(fn) {
  $("error").textContent = "";
  $("message").textContent = "";
  try {
    await fn();
  } catch (error) {
    $("error").textContent = error.message;
  }
  await refresh();
}
async function load() {
  const session = await send("SESSION");
  const { connection } = await chrome.storage.local.get("connection");
  $("pairing").hidden = true;
  $("workspace").hidden = false;
  $("project").textContent = session.project.name;
  $("call").textContent = session.call.title;
  $("review-link").href =
    `${connection.origin}/projects/${session.project.id}/calls`;
  $("start").dataset.configured = String(
    session.speechConfigured && session.analysisConfigured,
  );
  if (!session.speechConfigured || !session.analysisConfigured)
    $("error").textContent =
      "A administração precisa conectar transcrição e análise. Observações manuais estão disponíveis.";
}
async function refresh() {
  const { captureState = "idle" } =
    await chrome.storage.session.get("captureState");
  const { queue = [], error = "" } = await chrome.storage.local.get([
    "queue",
    "error",
  ]);
  $("state").textContent = {
    idle: "Pronto para a review.",
    starting: "Conectando áudio…",
    recording: "Captura e transcrição em andamento",
    stopping: "Captura parada · sincronizando observações",
  }[captureState];
  $("queue").textContent = queue.length
    ? `${queue.length} observações aguardando sincronização.`
    : "Todas as observações recebidas foram sincronizadas.";
  $("start").disabled =
    captureState !== "idle" ||
    !$("consent").checked ||
    $("start").dataset.configured !== "true";
  $("stop").disabled = captureState === "idle" || captureState === "starting";
  if (error) $("error").textContent = error;
}
$("connect").onclick = () =>
  action(async () => {
    await send("CONNECT", { value: $("connection").value });
    $("connection").value = "";
    await load();
  });
$("start").onclick = () =>
  action(async () => {
    // Request microphone permission in a visible extension page before the offscreen capture.
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    mic.getTracks().forEach((track) => {
      track.stop();
    });
    await send("START");
  });
$("stop").onclick = () => action(() => send("STOP"));
$("sync").onclick = () => action(() => send("FLUSH"));
$("consent").onchange = refresh;
$("change").onclick = () => {
  $("pairing").hidden = false;
  $("connection").focus();
};
$("note-form").onsubmit = (event) => {
  event.preventDefault();
  void action(async () => {
    const path = $("path").value.trim();
    const note = {
      body: $("note").value.trim(),
      category: $("category").value,
      source: "manual",
      ...(path
        ? { codeReference: { path, line: Number($("line").value) } }
        : {}),
    };
    if (
      path &&
      (path.startsWith("/") ||
        path.split("/").includes("..") ||
        !Number.isInteger(Number($("line").value)))
    )
      throw new Error("Informe um caminho relativo e uma linha válida.");
    await send("NOTE", { note });
    $("note").value = "";
    $("message").textContent =
      "Ponto salvo. Ele será proposto para confirmação ao encerrar a review.";
    await send("FLUSH");
  });
};
chrome.storage.onChanged.addListener(() => {
  void refresh();
});
void action(async () => {
  const { connection } = await chrome.storage.local.get("connection");
  if (connection) await load();
});
