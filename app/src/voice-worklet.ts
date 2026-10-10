import {
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
 * DSP uses preallocated buffers. A small progress message is sent twice a
 * second so a stopped processor cannot hide behind a running context clock.
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

interface StopMessage {
  type: 'stop'
}

type WorkletMessage = StopMessage

class VoiceMaskProcessor extends AudioWorkletProcessor {
  /** One masker per channel. A conference microphone is mono and this is
   *  almost always an array of one, but a stereo interface would otherwise
   *  get channel 0 duplicated across both ears, which is a different sound
   *  from the one the person previewed. */
  readonly #maskers: VoiceMasker[] = []
  #settings: VoiceSettings | undefined
  #alive = true
  #frames = 0
  #lastReport = 0

  constructor(options?: { processorOptions?: { settings?: VoiceSettings } }) {
    super()
    const settings = options?.processorOptions?.settings
    if (settings && Number.isFinite(settings.semitones) && Number.isFinite(settings.formantRatio)) {
      this.#settings = clampVoiceSettings(settings)
    }
    this.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
      const message = event.data
      if (message.type === 'stop') {
        this.#alive = false
      }
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]
    const output = outputs[0]
    if (!output) return this.#alive
    if (!this.#alive || !this.#settings) {
      for (const target of output) target.fill(0)
      return this.#alive
    }
    this.#frames += output[0]?.length ?? 0
    if (this.#frames - this.#lastReport >= sampleRate / 2) {
      this.#lastReport = this.#frames
      this.port.postMessage({ type: 'rendered', frames: this.#frames })
    }
    for (let channel = 0; channel < output.length; channel += 1) {
      const source = input?.[channel] ?? input?.[0]
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
