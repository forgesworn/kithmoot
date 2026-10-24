/** A bounded PCM bridge. It sends at most one 20 ms block until acknowledged. */
export const REALTIME_PCM_WORKLET_NAME = 'kithmoot-realtime-pcm-v1'

// Kept self-contained: AudioWorklet cannot import the application's modules.
export const REALTIME_PCM_WORKLET_SOURCE = `
class RealtimePcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.alive = true;
    this.waiting = false;
    this.size = Math.round(sampleRate / 50);
    this.block = new Float32Array(this.size);
    this.used = 0;
    this.started = 0;
    this.port.onmessage = event => {
      if (event.data === 'ack') this.waiting = false;
      if (event.data === 'stop') this.alive = false;
    };
  }
  process(inputs, outputs) {
    for (const channel of outputs[0] || []) channel.fill(0);
    if (!this.alive) return false;
    const input = inputs[0] && inputs[0][0];
    if (!input) { this.used = 0; return true; }
    let offset = 0;
    while (offset < input.length) {
      if (!this.used) this.started = currentFrame + offset;
      const count = Math.min(this.size - this.used, input.length - offset);
      this.block.set(input.subarray(offset, offset + count), this.used);
      this.used += count; offset += count;
      if (this.used === this.size) {
        if (!this.waiting) {
          const samples = this.block.slice();
          this.waiting = true;
          this.port.postMessage({ pcm: samples.buffer, frame: this.started }, [samples.buffer]);
        }
        this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor('${REALTIME_PCM_WORKLET_NAME}', RealtimePcm);
`
