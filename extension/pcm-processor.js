class BrokkPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = [];
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const value of input) this.samples.push(value);
    if (this.samples.length >= 1600) {
      const pcm = new Int16Array(this.samples.length);
      for (let i = 0; i < pcm.length; i++)
        pcm[i] = Math.max(-1, Math.min(1, this.samples[i])) * 32767;
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
      this.samples = [];
    }
    return true;
  }
}
registerProcessor("brokk-pcm", BrokkPCM);
