/** Diagnostic only: observe real browser media without changing routing. */
export const AUDIO_SINK_DIAGNOSTIC = () => {
  const state = { events: [] as unknown[], samples: [] as unknown[] }
  const contexts: AudioContext[] = []
  const scope = window as unknown as { __audioSinkDiagnostics: typeof state; __pcs?: RTCPeerConnection[] }
  scope.__audioSinkDiagnostics = state
  const record = (event: unknown) => { if (state.events.length < 1200) state.events.push({ at: performance.now(), event }) }
  const NativeContext = window.AudioContext
  window.AudioContext = class extends NativeContext {
    constructor(...args: ConstructorParameters<typeof AudioContext>) {
      super(...args); contexts.push(this)
      record({ context: contexts.length - 1, state: this.state, event: 'created' })
      this.addEventListener('statechange', () => record({ context: contexts.indexOf(this), state: this.state, event: 'statechange' }))
    }
  }
  const track = (t: MediaStreamTrack) => ({ id: t.id, kind: t.kind, enabled: t.enabled, muted: t.muted, state: t.readyState })
  const element = (el: HTMLMediaElement) => ({ tag: el.tagName, id: el.dataset.track, connected: el.isConnected, paused: el.paused, muted: el.muted, volume: el.volume, time: el.currentTime, readyState: el.readyState, networkState: el.networkState, error: el.error?.message, tracks: el.srcObject instanceof MediaStream ? el.srcObject.getTracks().map(track) : [] })
  const nativePlay = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function () {
    const at = performance.now(); record({ event: 'play-request', at, element: element(this) })
    const pending = nativePlay.call(this)
    pending.then(() => record({ event: 'play-resolved', at, element: element(this) }), error => record({ event: 'play-rejected', at, error: String(error), element: element(this) }))
    return pending
  }
  setInterval(() => {
    void (async () => {
      const pcs = []
      for (const [index, pc] of (scope.__pcs ?? []).entries()) {
        const stats: unknown[] = []
        ;(await pc.getStats()).forEach(s => { if ((s.kind === 'audio' || s.mediaType === 'audio') && ['inbound-rtp', 'outbound-rtp', 'media-source', 'media-playout'].includes(s.type)) stats.push(s) })
        pcs.push({ index, state: pc.connectionState, receivers: pc.getReceivers().filter(r => r.track.kind === 'audio').map(r => ({ track: track(r.track), transform: Boolean((r as RTCRtpReceiver & { transform?: unknown }).transform) })), stats })
      }
      state.samples.push({ at: performance.now(), contexts: contexts.map(ctx => ({ state: ctx.state, time: ctx.currentTime, sampleRate: ctx.sampleRate })), elements: [...document.querySelectorAll('audio')].map(element), pcs })
      if (state.samples.length > 150) state.samples.shift()
    })().catch(error => record({ event: 'sample-error', error: String(error) }))
  }, 1000)
}
