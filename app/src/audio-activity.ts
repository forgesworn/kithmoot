import './audio-activity.css'

export type AudioSignal = number | 'Muted' | 'Off' | null

/** A short history of measured RMS, never an audio recording. */
export class AudioActivity {
  readonly #hosts: HTMLElement[]
  #scope = ''
  #last = -Infinity
  #history: number[][] = [[], []]

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

  update(scope: string, signals: readonly [AudioSignal, AudioSignal], now = performance.now(), force = false): void {
    if (scope !== this.#scope) {
      this.#history = [[], []]
      this.#scope = scope
      this.#last = -Infinity
    }
    for (const host of this.#hosts) host.hidden = !scope
    if (!scope || (!force && now - this.#last < 200)) return
    const sample = now - this.#last >= 200
    if (sample) this.#last = now
    signals.forEach((signal, index) => {
      const value = typeof signal === 'number' && Number.isFinite(signal) ? Math.max(0, Math.min(1, signal)) : 0
      const state = typeof signal === 'string' ? signal : signal === null ? 'Waiting' : value >= 0.005 ? 'Sound' : 'Quiet'
      const height = Math.min(1, Math.sqrt(value) * 2)
      const history = this.#history[index]!
      if (typeof signal !== 'number') history.length = 0
      if (sample) { history.push(height); if (history.length > 32) history.shift() }
      const values = [...Array<number>(32 - history.length).fill(0), ...history]
      const upper = values.map((level, i) => `${i * 128 / 31},${12 - level * 11}`)
      const lower = values.map((level, i) => `${i * 128 / 31},${12 + level * 11}`).reverse()
      for (const host of this.#hosts) {
        const row = host.children[index] as HTMLElement
        const text = row.querySelector('.audioSignalState')!
        if (text.textContent !== state) text.textContent = state
        row.dataset.state = state.toLowerCase()
        row.querySelector('.audioEnvelope')!.setAttribute('d', `M${upper.join('L')}L${lower.join('L')}Z`)
        ;(row.querySelector('.audioLevel > span') as HTMLElement).style.width = `${height * 100}%`
      }
    })
  }
}
