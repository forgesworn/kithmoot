import './audio-activity.css'

export type AudioSignal = number | 'Muted' | 'Off' | null

/** A live, bounded PCM peak trace; samples are replaced on each update. */
export class AudioActivity {
  readonly #hosts: HTMLElement[]
  #scope = ''
  #last = -Infinity

  constructor(hosts: Iterable<HTMLElement>) {
    this.#hosts = [...hosts]
    for (const host of this.#hosts) {
      host.classList.add('audioActivity')
      host.setAttribute('role', 'group')
      host.setAttribute('aria-label', 'Audio activity')
      // Ordinary navigable text, never announcements over the call.
      host.innerHTML = ['Your mic', 'Incoming audio'].map((label, index) =>
        `<div class="audioSignal" data-audio-signal="${index === 0 ? 'mic' : 'incoming'}"><span class="audioSignalLabel">${label}</span><span class="audioSignalState">Waiting</span><svg class="audioTrace" viewBox="0 0 128 24" preserveAspectRatio="none" aria-hidden="true"><path d="M0 12H128" class="audioBaseline"/><path class="audioEnvelope"/></svg><span class="audioLevel" aria-hidden="true"><span></span></span></div>`,
      ).join('')
    }
  }

  update(scope: string, signals: readonly [AudioSignal, AudioSignal], now = performance.now(), force = false, waveforms: readonly (readonly number[])[] = []): void {
    if (scope !== this.#scope) {
      this.#scope = scope
      this.#last = -Infinity
    }
    for (const host of this.#hosts) host.hidden = !scope
    if (!scope || (!force && now - this.#last < 50)) return
    this.#last = now
    signals.forEach((signal, index) => {
      const value = typeof signal === 'number' && Number.isFinite(signal) ? Math.max(0, Math.min(1, signal)) : 0
      const state = typeof signal === 'string' ? signal : signal === null ? 'Waiting' : value >= 0.005 ? 'Sound' : 'Quiet'
      const height = Math.min(1, Math.sqrt(value) * 2)
      const peaks = state === 'Sound' ? waveforms[index] ?? [] : []
      const trace = peaks.length > 1 ? peaks.slice(0, 256).map((peak, i, all) => {
        const value = Number.isFinite(peak) ? Math.max(-1, Math.min(1, peak * 4)) : 0
        return `${i === 0 ? 'M' : 'L'}${i * 128 / (all.length - 1)},${12 - value * 11}`
      }).join('') : 'M0 12H128'
      for (const host of this.#hosts) {
        const row = host.children[index] as HTMLElement
        const text = row.querySelector('.audioSignalState')!
        if (text.textContent !== state) text.textContent = state
        row.dataset.state = state.toLowerCase()
        row.querySelector('.audioEnvelope')!.setAttribute('d', trace)
        ;(row.querySelector('.audioLevel > span') as HTMLElement).style.width = `${height * 100}%`
      }
    })
  }
}
