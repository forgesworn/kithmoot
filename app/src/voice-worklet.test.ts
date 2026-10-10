import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { VOICE_PRESETS, type VoiceSettings } from '../../src/voice-effects.js'

interface Processor {
  port: { postMessage: ReturnType<typeof vi.fn>; onmessage: (event: { data: { type: string } }) => void }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean
}
let Processor: new (options?: { processorOptions?: { settings?: VoiceSettings } }) => Processor
beforeEach(async () => {
  vi.resetModules()
  vi.stubGlobal('sampleRate', 48000)
  vi.stubGlobal('AudioWorkletProcessor', class { port = { postMessage: vi.fn(), onmessage: null } })
  vi.stubGlobal('registerProcessor', (_name: string, constructor: typeof Processor) => { Processor = constructor })
  await import('./voice-worklet.js')
})
afterEach(() => { vi.unstubAllGlobals() })

it('starts the first block with the selected mask instead of raw identity settings', () => {
  const processor = new Processor({ processorOptions: { settings: VOICE_PRESETS.deep } })
  const input = new Float32Array(128).fill(0.25)
  const output = new Float32Array(128).fill(1)
  processor.process([[input]], [[output]])
  expect([...output]).toEqual(Array(128).fill(0)) // Mask latency, before any raw block can escape.
})

it('permits passthrough only with explicitly supplied Off settings', () => {
  const processor = new Processor({ processorOptions: { settings: VOICE_PRESETS.off } })
  const input = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i / 5) * 0.25)
  const output = new Float32Array(128)
  processor.process([[input]], [[output]])
  expect(output).toEqual(input)
})

it.each([undefined, { semitones: NaN, formantRatio: 1 }, { semitones: 2, formantRatio: Infinity }])(
  'keeps missing or invalid processor settings silent: %s', settings => {
    const processor = new Processor({ processorOptions: { settings } })
    const output = new Float32Array(128).fill(1)
    processor.process([[new Float32Array(128).fill(0.25)]], [[output]])
    expect([...output]).toEqual(Array(128).fill(0))
    expect(processor.port.postMessage).not.toHaveBeenCalled()
  },
)

it('reports actual rendered progress rather than merely trusting the context clock', () => {
  const processor = new Processor({ processorOptions: { settings: VOICE_PRESETS.deep } })
  for (let i = 0; i < 188; i++) processor.process([[new Float32Array(128)]], [[new Float32Array(128)]])
  expect(processor.port.postMessage).toHaveBeenCalledWith({ type: 'rendered', frames: 24064 })
})

it('clears every output channel after stopping', () => {
  const processor = new Processor({ processorOptions: { settings: VOICE_PRESETS.off } })
  processor.port.onmessage({ data: { type: 'stop' } })
  const output = [new Float32Array(128).fill(1), new Float32Array(128).fill(1)]
  expect(processor.process([[new Float32Array(128).fill(0.25)]], [output])).toBe(false)
  expect(output.every(channel => channel.every(sample => sample === 0))).toBe(true)
})
