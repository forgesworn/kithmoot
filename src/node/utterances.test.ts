import { describe, it, expect } from 'vitest'
import { UtteranceSplitter, downmix, downsample, rms, wavFromPcm } from './utterances.js'

const RATE = 48_000
const BLOCK = 960 // 20ms, one Opus frame

function tone(ms: number, amplitude = 0.3): Float32Array {
  const out = new Float32Array(Math.floor((RATE * ms) / 1000))
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / RATE)
  return out
}

function silence(ms: number): Float32Array {
  return new Float32Array(Math.floor((RATE * ms) / 1000))
}

/** Feed `pcm` in 20ms blocks, the way RTP delivers it, advancing a clock. */
function feed(splitter: UtteranceSplitter, pcm: Float32Array, clock: { now: number }) {
  const out = []
  for (let offset = 0; offset + BLOCK <= pcm.length; offset += BLOCK) {
    clock.now += 20
    out.push(...splitter.push(pcm.subarray(offset, offset + BLOCK), clock.now))
  }
  return out
}

describe('UtteranceSplitter', () => {
  it('releases a turn once the speaker has been quiet long enough', () => {
    const splitter = new UtteranceSplitter()
    const clock = { now: 0 }
    expect(feed(splitter, tone(1000), clock)).toHaveLength(0)
    const out = feed(splitter, silence(800), clock)
    expect(out).toHaveLength(1)
    const [u] = out
    expect(u!.sampleRate).toBe(16_000)
    // A second of speech plus the silence that ended it, at 16 kHz.
    expect(u!.pcm.length).toBeGreaterThan(16_000)
    expect(u!.endedAt - u!.startedAt).toBeGreaterThanOrEqual(1680)
  })

  it('ignores a noise too short to be words', () => {
    const splitter = new UtteranceSplitter()
    const clock = { now: 0 }
    feed(splitter, tone(100), clock)
    expect(feed(splitter, silence(1000), clock)).toHaveLength(0)
  })

  it('cuts a monologue at the ceiling rather than holding it for ever', () => {
    const splitter = new UtteranceSplitter({ maxMs: 2000 })
    const clock = { now: 0 }
    const out = feed(splitter, tone(5000), clock)
    expect(out.length).toBe(2)
    for (const u of out) expect(u.pcm.length).toBeLessThanOrEqual((16_000 * 2000) / 1000 + 16)
  })

  it('keeps a little of the silence before the first word, so it is not clipped', () => {
    const splitter = new UtteranceSplitter()
    const clock = { now: 0 }
    feed(splitter, silence(2000), clock)
    feed(splitter, tone(600), clock)
    const [u] = feed(splitter, silence(800), clock)
    // 600ms of tone + ~200ms lead-in + 700ms+ of trailing silence.
    expect(u!.startedAt).toBeLessThan(2000 + 20)
    expect(u!.startedAt).toBeGreaterThan(1700)
  })

  it('flushes what is in flight when told to', () => {
    const splitter = new UtteranceSplitter()
    const clock = { now: 0 }
    feed(splitter, tone(900), clock)
    const u = splitter.flush(clock.now)
    expect(u).toBeDefined()
    expect(splitter.flush(clock.now)).toBeUndefined()
  })

  it('refuses a rate it cannot divide down cleanly', () => {
    expect(() => new UtteranceSplitter({ sampleRate: 44_100 })).toThrow()
  })
})

describe('the arithmetic', () => {
  it('rms of silence is zero and of a tone is its amplitude over root two', () => {
    expect(rms(silence(100))).toBe(0)
    expect(rms(tone(1000, 0.5))).toBeCloseTo(0.5 / Math.SQRT2, 2)
  })

  it('downsamples by averaging, not by dropping', () => {
    const pcm = new Float32Array([0, 3, 0, 3, 6, 0])
    expect(Array.from(downsample(pcm, 3))).toEqual([1, 3])
    expect(downsample(pcm, 1)).toBe(pcm)
  })

  it('downmixes by averaging the channels', () => {
    expect(Array.from(downmix([new Float32Array([1, 0]), new Float32Array([0, 1])]))).toEqual([0.5, 0.5])
    const mono = new Float32Array([1, 2])
    expect(downmix([mono])).toBe(mono)
  })

  it('writes a well-formed 16-bit mono WAV', () => {
    const wav = wavFromPcm(new Float32Array([0, 1, -1]), 16_000)
    const text = (o: number, n: number) => String.fromCharCode(...wav.subarray(o, o + n))
    expect(text(0, 4)).toBe('RIFF')
    expect(text(8, 4)).toBe('WAVE')
    expect(text(36, 4)).toBe('data')
    const view = new DataView(wav.buffer)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(40, true)).toBe(6)
    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(0x7fff)
    expect(view.getInt16(48, true)).toBe(-0x8000)
  })
})
