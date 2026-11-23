import './audio-activity.css'

export type AudioSignal = number | 'Muted' | 'Off' | 'Listen only' | null

export interface ParticipantSignal {
  id: string
  label: string
  self?: boolean
  signal: AudioSignal
  waveform?: readonly number[]
}

interface SignalView {
  card: HTMLElement
  label: HTMLElement
  state: HTMLElement
  envelope: SVGPathElement
  level: HTMLElement
}

function createSignal(person: ParticipantSignal): SignalView {
  const card = document.createElement('div')
  card.className = 'audioSignal'
  card.dataset.audioSignal = person.self ? 'mic' : 'participant'
  card.dataset.participant = person.id
  card.innerHTML = '<span class="audioSignalLabel"></span><span class="audioSignalState"></span>'
    + '<svg class="audioTrace" viewBox="0 0 128 24" preserveAspectRatio="none" aria-hidden="true"><path d="M0 12H128" class="audioBaseline"/><path class="audioEnvelope"/></svg>'
    + '<span class="audioLevel" aria-hidden="true"><span></span></span>'
  return {
    card,
    label: card.querySelector('.audioSignalLabel')!,
    state: card.querySelector('.audioSignalState')!,
    envelope: card.querySelector('.audioEnvelope')!,
    level: card.querySelector('.audioLevel > span')!,
  }
}

/** A stable strip of named PCM traces. No room repaint or live announcements. */
export class AudioActivity {
  readonly #hosts: { element: HTMLElement; views: Map<string, SignalView> }[]
  #scope = ''
  #last = -Infinity

  constructor(hosts: Iterable<HTMLElement>) {
    this.#hosts = Array.from(hosts, element => {
      element.classList.add('audioActivity')
      element.setAttribute('role', 'region')
      element.setAttribute('aria-label', 'Participant microphones')
      element.tabIndex = 0
      return { element, views: new Map() }
    })
  }

  update(scope: string, signals: readonly ParticipantSignal[], force = false, now = performance.now()): void {
    if (scope !== this.#scope) {
      this.#scope = scope
      this.#last = -Infinity
      for (const { element, views } of this.#hosts) {
        element.replaceChildren()
        element.scrollLeft = 0
        views.clear()
      }
    }
    for (const { element } of this.#hosts) element.hidden = !scope
    if (!scope || (!force && now - this.#last < 40)) return
    this.#last = now

    const present = new Set(signals.map(person => person.id))
    for (const { views } of this.#hosts) {
      for (const [id, view] of views) {
        if (present.has(id)) continue
        view.card.remove()
        views.delete(id)
      }
    }

    signals.forEach((person, index) => {
      const { signal, waveform } = person
      const value = typeof signal === 'number' && Number.isFinite(signal) ? Math.max(0, Math.min(1, signal)) : 0
      const state = typeof signal === 'string' ? signal : signal === null ? 'Waiting' : value >= 0.005 ? 'Speaking' : 'Quiet'
      const width = `${Math.min(1, Math.sqrt(value) * 2) * 100}%`
      const peaks = state === 'Speaking' ? waveform?.slice(0, 256) ?? [] : []
      const trace = peaks.length > 1 ? peaks.map((peak, i) => {
        const value = Number.isFinite(peak) ? Math.max(-1, Math.min(1, peak * 4)) : 0
        return `${i === 0 ? 'M' : 'L'}${(i * 128 / (peaks.length - 1)).toFixed(1)},${(12 - value * 11).toFixed(1)}`
      }).join('') : 'M0 12H128'

      for (const { element, views } of this.#hosts) {
        let view = views.get(person.id)
        if (!view) {
          view = createSignal(person)
          views.set(person.id, view)
        }
        const at = element.children[index] ?? null
        if (at !== view.card) element.insertBefore(view.card, at)
        if (view.label.textContent !== person.label) {
          view.label.textContent = person.label
          view.label.title = person.label
        }
        if (view.state.textContent !== state) {
          view.state.textContent = state
          view.card.toggleAttribute('data-speaking', state === 'Speaking')
        }
        if (view.envelope.getAttribute('d') !== trace) view.envelope.setAttribute('d', trace)
        if (view.level.style.width !== width) view.level.style.width = width
      }
    })
  }
}
