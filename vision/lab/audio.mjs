/** Local microphone level only. No recording, playback or network path. */
export class MicrophoneMeter {
  constructor(meter, status) { this.meter = meter; this.status = status }
  async prepare() {
    const Audio = globalThis.AudioContext ?? globalThis.webkitAudioContext
    if (!Audio) throw new Error('Microphone level testing needs Web Audio support; leave microphone unchecked to test video alone')
    // Called directly by the Start camera gesture, before the permission prompt.
    this.context = new Audio()
    await this.context.resume()
  }
  attach(stream) {
    if (!this.context || !stream.getAudioTracks().length) throw new Error('No microphone track was returned')
    this.source = this.context.createMediaStreamSource(stream)
    this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 512
    this.silent = this.context.createGain(); this.silent.gain.value = 0
    this.source.connect(this.analyser); this.analyser.connect(this.silent); this.silent.connect(this.context.destination)
    const values = new Float32Array(this.analyser.fftSize)
    this.status.textContent = 'Microphone on · local level only · no recording or playback'
    const tick = () => {
      this.analyser.getFloatTimeDomainData(values)
      const rms = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length)
      this.meter.value = Math.min(1, rms * 4)
      this.frame = requestAnimationFrame(tick)
    }
    tick()
  }
  close() {
    cancelAnimationFrame(this.frame)
    this.source?.disconnect(); this.analyser?.disconnect(); this.silent?.disconnect()
    void this.context?.close().catch(() => {})
    this.context = undefined
    this.meter.value = 0; this.status.textContent = 'Microphone off. Optional level test; audio is never saved with samples.'
  }
}
