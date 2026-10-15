let tabStream, micStream, context, socket, processor;
let pending = [],
  unsent = [],
  stopped = false,
  sessionId = crypto.randomUUID();
async function cleanup() {
  processor?.disconnect();
  tabStream?.getTracks().forEach((track) => {
    track.stop();
  });
  micStream?.getTracks().forEach((track) => {
    track.stop();
  });
  if (context && context.state !== "closed") await context.close();
}
async function start(message) {
  stopped = false;
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: message.streamId,
      },
    },
    video: false,
  });
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: false,
  });
  context = new AudioContext({ sampleRate: 16000 });
  await context.audioWorklet.addModule("pcm-processor.js");
  const tabSource = context.createMediaStreamSource(tabStream);
  // Capturing a tab mutes its original output; restore it without playing the microphone back.
  tabSource.connect(context.destination);
  const micSource = context.createMediaStreamSource(micStream);
  processor = new AudioWorkletNode(context, "brokk-pcm");
  const tabGain = context.createGain(),
    micGain = context.createGain();
  tabGain.gain.value = 0.5;
  micGain.gain.value = 0.5;
  tabSource.connect(tabGain);
  tabGain.connect(processor);
  micSource.connect(micGain);
  micGain.connect(processor);
  const mute = context.createGain();
  mute.gain.value = 0;
  processor.connect(mute);
  mute.connect(context.destination);
  const url = new URL("wss://streaming.assemblyai.com/v3/ws");
  url.search = new URLSearchParams({
    sample_rate: String(context.sampleRate),
    speech_model: "universal-streaming-multilingual",
    token: message.speech.token,
    format_turns: "true",
  });
  socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("A transcrição não conectou.")),
      10000,
    );
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("A transcrição não conectou."));
    };
  });
  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (
      data.type === "Turn" &&
      data.end_of_turn &&
      !data.turn_is_formatted &&
      data.transcript?.trim()
    ) {
      // The unformatted final turn is delivered once; the formatted duplicate has the same client ID.
      const text = data.transcript.trim();
      const id = `${sessionId}:${data.turn_order}`;
      const write = (async () => {
        const digest = new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)),
        );
        const hex = [...digest.slice(0, 16)]
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("");
        const clientId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
        for (let offset = 0; offset < text.length; offset += 3900) {
          const note = {
            clientId: offset
              ? `${clientId.slice(0, 24)}${offset.toString(16).padStart(12, "0")}`
              : clientId,
            body: text.slice(offset, offset + 3900),
            category: "decision",
            source: "transcript",
            at: new Date().toISOString(),
          };
          const result = await chrome.runtime.sendMessage({
            type: "NOTE",
            note,
          });
          if (!result?.ok) {
            unsent.push(note);
            throw new Error(
              result?.error ||
                "Não foi possível salvar a transcrição localmente.",
            );
          }
        }
      })();
      pending.push(write);
      void write.catch(fail);
    }
  };
  socket.onclose = () => {
    if (!stopped)
      void fail(
        new Error(
          "A transcrição desconectou. Pare e sincronize antes de iniciar novamente.",
        ),
      );
  };
  processor.port.onmessage = (event) => {
    if (socket.readyState === WebSocket.OPEN && !stopped) {
      if (socket.bufferedAmount > 1048576) {
        void fail(
          new Error(
            "A conexão de áudio está lenta. Reinicie a captura após sincronizar.",
          ),
        );
        return;
      }
      socket.send(event.data);
    }
  };
  tabStream.getAudioTracks()[0].onended = () => {
    if (!stopped)
      void fail(
        new Error("A aba da chamada encerrou a captura. Pare e sincronize."),
      );
  };
  await context.resume();
}
async function fail(error) {
  stopped = true;
  socket?.close();
  await cleanup();
  await chrome.runtime.sendMessage({
    type: "CAPTURE_ERROR",
    error: error.message,
  });
}
async function stop() {
  stopped = true;
  if (socket?.readyState === WebSocket.OPEN) {
    const closed = new Promise((resolve) => {
      socket.addEventListener("close", resolve, { once: true });
      setTimeout(resolve, 5000);
    });
    socket.send(JSON.stringify({ type: "ForceEndpoint" }));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    socket.send(JSON.stringify({ type: "Terminate" }));
    await closed;
  }
  socket?.close();
  await Promise.allSettled(pending);
  while (unsent.length) {
    const result = await chrome.runtime.sendMessage({
      type: "NOTE",
      note: unsent[0],
    });
    if (!result?.ok)
      throw new Error(
        result?.error || "Sincronize para salvar a última observação.",
      );
    unsent.shift();
  }
  pending = [];
  await cleanup();
}
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.target !== "offscreen") return;
  void (async () => {
    try {
      if (message.type === "PAUSE") {
        stopped = true;
        await cleanup();
      } else if (message.type === "START") await start(message);
      else await stop();
      reply({ ok: true });
    } catch (error) {
      await cleanup();
      socket?.close();
      reply({ ok: false, error: error.message });
    }
  })();
  return true;
});
