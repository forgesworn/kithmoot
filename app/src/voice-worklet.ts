import {
  IDENTITY_VOICE_SETTINGS,
  VoiceMasker,
  clampVoiceSettings,
  type VoiceSettings,
} from '../../src/voice-effects.js'

/**
 * The audio thread half of voice masking.
 *
 * This file is bundled on its own into a single self-contained script (see
 * the `audioWorklet` plugin in `app/vite.config.ts`) because an
 * `AudioWorkletGlobalScope` has no module loader: a bare `import` inside a
 * worklet does not resolve in any shipping browser. Everything it needs is
 * inlined, which is also why `src/voice-effects.ts` has no dependencies.
 *
 * Nothing here allocates once it is running. A garbage collection on the
 * audio thread is a dropout, and a dropout on a masked voice is
 * indistinguishable from the masking having broken.
 */

// The `AudioWorkletGlobalScope` is not in lib.dom, so its three globals are
// named here rather than pulling in a types package for them.
declare const sampleRate: number
declare const AudioWorkletProcessor: {
  new (): { readonly port: MessagePort }
  prototype: { readonly port: MessagePort }
}
declare function registerProcessor(name: string, processor: unknown): void

export const VOICE_WORKLET_NAME = 'kithmoot-voice-mask'

interface SettingsMessage {
  type: 'settings'
  settings: VoiceSettings
}

interface StopMessage {
  type: 'stop'
}

type WorkletMessage = SettingsMessage | StopMessage

class VoiceMaskProcessor extends AudioWorkletProcessor {
  /** One masker per channel. A conference microphone is mono and this is
   *  almost always an array of one, but a stereo interface would otherwise
   *  get channel 0 duplicated across both ears, which is a different sound
   *  from the one the person previewed. */
  readonly #maskers: VoiceMasker[] = []
  #settings: VoiceSettings = IDENTITY_VOICE_SETTINGS
  #alive = true

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
      const message = event.data
      if (message.type === 'settings') {
        this.#settings = clampVoiceSettings(message.settings)
        for (const masker of this.#maskers) masker.setSettings(this.#settings)
      } else if (message.type === 'stop') {
        this.#alive = false
      }
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]
    const output = outputs[0]
    if (!input || !output) return this.#alive
    for (let channel = 0; channel < output.length; channel += 1) {
      const source = input[channel] ?? input[0]
      const target = output[channel]
      if (!target) continue
      if (!source) {
        target.fill(0)
        continue
      }
      let masker = this.#maskers[channel]
      if (!masker) {
        masker = new VoiceMasker({ sampleRate, settings: this.#settings })
        this.#maskers[channel] = masker
      }
      masker.process(source, target)
    }
    return this.#alive
  }
}

registerProcessor(VOICE_WORKLET_NAME, VoiceMaskProcessor)
