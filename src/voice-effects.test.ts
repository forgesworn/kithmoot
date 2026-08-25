import { describe, it, expect } from 'vitest'
import {
  DEFAULT_VOICE_PRESET,
  FRAME_SIZE,
  HOP_SIZE,
  IDENTITY_VOICE_SETTINGS,
  MAX_SEMITONES,
  VOICE_PRESETS,
  VoiceMasker,
  clampVoiceSettings,
  fftInPlace,
  isIdentitySettings,
  latencySamples,
  presetLatencyMs,
  semitonesToRatio,
  spectralEnvelope,
  type VoicePreset,
  type VoiceSettings,
} from './voice-effects.js'

const SAMPLE_RATE = 48_000

// ---------------------------------------------------------------------------
// Measurement helpers. Everything the DSP claims about itself is checked by
// measuring the output, not by reading the implementation back.
// ---------------------------------------------------------------------------

function sine(freq: number, seconds: number, amplitude = 0.5, rate = SAMPLE_RATE): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate))
  for (let i = 0; i < out.length; i += 1) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / rate)
  return out
}

/** A vowel-ish signal: harmonics of `f0` shaped by a resonance at `formant`,
 *  which is roughly what a voice looks like to a formant shifter. */
function vowel(f0: number, formant: number, seconds: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE))
  const partials: Array<{ f: number; a: number }> = []
  let total = 0
  for (let h = 1; h * f0 < SAMPLE_RATE / 2 - 1000; h += 1) {
    const f = h * f0
    // A single wide resonance, in log frequency so it is symmetric by ear.
    const a = Math.exp(-Math.pow(Math.log(f / formant), 2) / (2 * 0.35 * 0.35))
    partials.push({ f, a })
    total += a
  }
  for (let i = 0; i < out.length; i += 1) {
    let v = 0
    for (const p of partials) v += p.a * Math.sin((2 * Math.PI * p.f * i) / SAMPLE_RATE)
    out[i] = (amplitude * v) / total
  }
  return out
}

function rms(x: Float32Array, from = 0): number {
  let sum = 0
  for (let i = from; i < x.length; i += 1) sum += x[i]! * x[i]!
  return Math.sqrt(sum / Math.max(1, x.length - from))
}

function peak(x: Float32Array, from = 0): number {
  let p = 0
  for (let i = from; i < x.length; i += 1) p = Math.max(p, Math.abs(x[i]!))
  return p
}

/** Magnitude spectrum of a window of `signal`, Hann-windowed. */
function spectrum(signal: Float32Array, offset: number, size = 8192): Float32Array {
  const re = new Float32Array(size)
  const im = new Float32Array(size)
  for (let i = 0; i < size; i += 1) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size))
    re[i] = (signal[offset + i] ?? 0) * w
  }
  fftInPlace(re, im, false)
  const mag = new Float32Array(size / 2 + 1)
  for (let k = 0; k <= size / 2; k += 1) mag[k] = Math.hypot(re[k]!, im[k]!)
  return mag
}

/** Peak frequency, refined by parabolic interpolation so a 3% tolerance is
 *  actually testing the shifter and not the bin width. */
function dominantFrequency(signal: Float32Array, offset = 0, size = 8192): number {
  const mag = spectrum(signal, offset, size)
  let best = 1
  for (let k = 2; k < mag.length - 1; k += 1) if (mag[k]! > mag[best]!) best = k
  const a = mag[best - 1]!
  const b = mag[best]!
  const c = mag[best + 1]!
  const denom = a - 2 * b + c
  const delta = denom === 0 ? 0 : (0.5 * (a - c)) / denom
  return ((best + delta) * SAMPLE_RATE) / size
}

/** Pitch by autocorrelation, which reads the repetition rate of the waveform
 *  and so is not fooled by a formant shift moving which harmonic is loudest.
 *  Searches 96Hz to 480Hz, which covers any human speaking voice. */
function fundamentalFrequency(signal: Float32Array, offset = 0, size = 16384): number {
  const minLag = Math.floor(SAMPLE_RATE / 480)
  const maxLag = Math.floor(SAMPLE_RATE / 96)
  let bestLag = minLag
  let best = -Infinity
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0
    for (let i = 0; i < size; i += 1) sum += (signal[offset + i] ?? 0) * (signal[offset + i + lag] ?? 0)
    if (sum > best) {
      best = sum
      bestLag = lag
    }
  }
  return SAMPLE_RATE / bestLag
}

/** Where the energy sits on average. Robust to the phase vocoder smearing a
 *  single peak across two bins, which an argmax is not. */
function spectralCentroid(signal: Float32Array, offset = 0, size = 8192): number {
  const mag = spectrum(signal, offset, size)
  let num = 0
  let den = 0
  for (let k = 1; k < mag.length; k += 1) {
    const m = mag[k]! * mag[k]!
    num += m * ((k * SAMPLE_RATE) / size)
    den += m
  }
  return den === 0 ? 0 : num / den
}

function run(input: Float32Array, settings: VoiceSettings, blockSize = 128): Float32Array {
  const masker = new VoiceMasker({ sampleRate: SAMPLE_RATE, settings })
  const out = new Float32Array(input.length)
  for (let i = 0; i < input.length; i += blockSize) {
    const n = Math.min(blockSize, input.length - i)
    masker.process(input.subarray(i, i + n), out.subarray(i, i + n))
  }
  return out
}

/** Skip the pipeline fill and the first few frames, which are a fade-in by
 *  construction in any overlap-add scheme. */
const SETTLE = FRAME_SIZE * 8

// ---------------------------------------------------------------------------

describe('semitones', () => {
  it('converts to a frequency ratio', () => {
    expect(semitonesToRatio(0)).toBe(1)
    expect(semitonesToRatio(12)).toBeCloseTo(2, 10)
    expect(semitonesToRatio(-12)).toBeCloseTo(0.5, 10)
    expect(semitonesToRatio(7)).toBeCloseTo(1.4983, 4)
  })
})

describe('presets', () => {
  it('offers exactly the four the UI offers, and off is off', () => {
    expect(Object.keys(VOICE_PRESETS).sort()).toEqual(['higher', 'lower', 'neutral', 'off'])
    expect(VOICE_PRESETS.off).toEqual(IDENTITY_VOICE_SETTINGS)
    expect(DEFAULT_VOICE_PRESET).toBe('off')
  })

  it('moves pitch in the direction the name says', () => {
    expect(VOICE_PRESETS.lower.semitones).toBeLessThan(0)
    expect(VOICE_PRESETS.higher.semitones).toBeGreaterThan(0)
  })

  it('moves formants with pitch for lower and higher, and against it for neutral', () => {
    expect(VOICE_PRESETS.lower.formantRatio).toBeLessThan(1)
    expect(VOICE_PRESETS.higher.formantRatio).toBeGreaterThan(1)
    // Neutral deliberately contradicts itself: a low pitch with slightly
    // raised formants is not a size of person, which is the point.
    expect(VOICE_PRESETS.neutral.semitones).toBeLessThan(0)
    expect(VOICE_PRESETS.neutral.formantRatio).toBeGreaterThan(1)
  })

  it('stays inside a range that still sounds like speech', () => {
    for (const settings of Object.values(VOICE_PRESETS)) {
      expect(Math.abs(settings.semitones)).toBeLessThanOrEqual(MAX_SEMITONES)
      expect(settings.formantRatio).toBeGreaterThan(0.5)
      expect(settings.formantRatio).toBeLessThan(2)
    }
  })
})

describe('settings bounds', () => {
  it('clamps a wild pitch rather than producing silence', () => {
    expect(clampVoiceSettings({ semitones: 99, formantRatio: 1 }).semitones).toBe(MAX_SEMITONES)
    expect(clampVoiceSettings({ semitones: -99, formantRatio: 1 }).semitones).toBe(-MAX_SEMITONES)
  })

  it('clamps a wild formant ratio', () => {
    expect(clampVoiceSettings({ semitones: 0, formantRatio: 40 }).formantRatio).toBeLessThanOrEqual(2)
    expect(clampVoiceSettings({ semitones: 0, formantRatio: 0 }).formantRatio).toBeGreaterThanOrEqual(0.5)
  })

  it('falls back to passing the voice through when the numbers are nonsense', () => {
    expect(clampVoiceSettings({ semitones: Number.NaN, formantRatio: 1 })).toEqual(
      IDENTITY_VOICE_SETTINGS,
    )
    expect(clampVoiceSettings({ semitones: 0, formantRatio: Number.NaN })).toEqual(
      IDENTITY_VOICE_SETTINGS,
    )
  })

  it('knows what doing nothing looks like', () => {
    expect(isIdentitySettings(IDENTITY_VOICE_SETTINGS)).toBe(true)
    expect(isIdentitySettings(VOICE_PRESETS.neutral)).toBe(false)
  })
})

describe('fft', () => {
  it('round-trips a signal back to itself', () => {
    const n = 256
    const re = new Float32Array(n)
    const im = new Float32Array(n)
    const original = new Float32Array(n)
    for (let i = 0; i < n; i += 1) {
      original[i] = Math.sin(i / 3) + 0.3 * Math.cos(i / 7)
      re[i] = original[i]!
    }
    fftInPlace(re, im, false)
    fftInPlace(re, im, true)
    for (let i = 0; i < n; i += 1) expect(re[i]!).toBeCloseTo(original[i]!, 4)
  })

  it('puts a pure tone in the bin it belongs in', () => {
    const n = 512
    const re = new Float32Array(n)
    const im = new Float32Array(n)
    for (let i = 0; i < n; i += 1) re[i] = Math.sin((2 * Math.PI * 16 * i) / n)
    fftInPlace(re, im, false)
    let best = 0
    for (let k = 1; k < n / 2; k += 1) {
      if (Math.hypot(re[k]!, im[k]!) > Math.hypot(re[best]!, im[best]!)) best = k
    }
    expect(best).toBe(16)
  })
})

describe('spectral envelope', () => {
  it('follows the resonance and ignores the harmonics under it', () => {
    const bins = 513
    const mag = new Float32Array(bins)
    for (let k = 0; k < bins; k += 1) {
      const bump = Math.exp(-Math.pow(k - 40, 2) / (2 * 12 * 12))
      // A comb on top: only every eighth bin carries a harmonic.
      mag[k] = bump * (k % 8 === 0 ? 1 : 0.02)
    }
    const env = spectralEnvelope(mag, 1024, 24)
    let best = 1
    for (let k = 1; k < bins; k += 1) if (env[k]! > env[best]!) best = k
    expect(best).toBeGreaterThan(30)
    expect(best).toBeLessThan(50)
    // Smooth: no two neighbouring bins differ the way the comb does.
    for (let k = 20; k < 60; k += 1) {
      expect(env[k + 1]! / env[k]!).toBeGreaterThan(0.6)
      expect(env[k + 1]! / env[k]!).toBeLessThan(1.7)
    }
  })
})

describe('VoiceMasker, off', () => {
  it('passes the samples through bit for bit', () => {
    const input = sine(300, 0.1)
    const out = run(input, IDENTITY_VOICE_SETTINGS)
    expect(Array.from(out)).toEqual(Array.from(input))
  })

  it('adds no latency at all', () => {
    expect(latencySamples(IDENTITY_VOICE_SETTINGS)).toBe(0)
    expect(presetLatencyMs('off', SAMPLE_RATE)).toBe(0)
  })
})

describe('VoiceMasker, pitch', () => {
  it('shifts a known tone up by an octave', () => {
    const out = run(sine(220, 1), { semitones: 12, formantRatio: 1 })
    const f = dominantFrequency(out, SETTLE)
    expect(f).toBeGreaterThan(440 * 0.97)
    expect(f).toBeLessThan(440 * 1.03)
  })

  it('shifts a known tone down by an octave', () => {
    const out = run(sine(440, 1), { semitones: -12, formantRatio: 1 })
    const f = dominantFrequency(out, SETTLE)
    expect(f).toBeGreaterThan(220 * 0.97)
    expect(f).toBeLessThan(220 * 1.03)
  })

  it('shifts by the preset amounts', () => {
    for (const name of ['lower', 'higher', 'neutral'] as const) {
      const expected = 200 * semitonesToRatio(VOICE_PRESETS[name].semitones)
      const out = run(sine(200, 1), { ...VOICE_PRESETS[name], formantRatio: 1 })
      const f = dominantFrequency(out, SETTLE)
      expect(Math.abs(f - expected) / expected).toBeLessThan(0.04)
    }
  })
})

describe('VoiceMasker, formants', () => {
  it('moves the formants without moving the pitch', () => {
    const input = vowel(150, 800, 1)
    const before = spectralCentroid(input, SETTLE)
    const up = run(input, { semitones: 0, formantRatio: 1.25 })
    const down = run(input, { semitones: 0, formantRatio: 0.8 })

    // The fundamental has not moved: this is a formant shift, not a pitch one.
    const f0 = fundamentalFrequency(up, SETTLE)
    expect(f0).toBeGreaterThan(150 * 0.97)
    expect(f0).toBeLessThan(150 * 1.03)

    const upRatio = spectralCentroid(up, SETTLE) / before
    const downRatio = spectralCentroid(down, SETTLE) / before
    expect(upRatio).toBeGreaterThan(1.05)
    expect(downRatio).toBeLessThan(0.95)
  })

  it('shifts pitch and formants independently, which is the whole point', () => {
    const input = vowel(150, 800, 1)
    // Same pitch shift, opposite formant treatment. If formants simply
    // followed pitch these two would be the same signal.
    const followed = run(input, { semitones: 5, formantRatio: semitonesToRatio(5) })
    const opposed = run(input, { semitones: 5, formantRatio: 0.85 })
    const a = spectralCentroid(followed, SETTLE)
    const b = spectralCentroid(opposed, SETTLE)
    expect(a / b).toBeGreaterThan(1.15)
  })
})

describe('VoiceMasker, gain and headroom', () => {
  it('keeps the level within a couple of decibels of the input', () => {
    for (const name of Object.keys(VOICE_PRESETS) as VoicePreset[]) {
      const input = vowel(150, 800, 1, 0.4)
      const out = run(input, VOICE_PRESETS[name])
      const db = 20 * Math.log10(rms(out, SETTLE) / rms(input, SETTLE))
      expect(Math.abs(db)).toBeLessThan(2.5)
    }
  })

  it('does not clip a loud input', () => {
    for (const name of Object.keys(VOICE_PRESETS) as VoicePreset[]) {
      const out = run(vowel(150, 800, 1, 0.95), VOICE_PRESETS[name])
      expect(peak(out)).toBeLessThanOrEqual(1)
    }
  })

  it('holds the ceiling even when handed samples already past it', () => {
    const hot = sine(300, 0.5, 3)
    const out = run(hot, VOICE_PRESETS.lower)
    expect(peak(out)).toBeLessThanOrEqual(1)
  })

  it('produces no NaN, which would silence the track for good', () => {
    const out = run(vowel(150, 800, 0.5), VOICE_PRESETS.neutral)
    for (let i = 0; i < out.length; i += 1) expect(Number.isFinite(out[i]!)).toBe(true)
  })

  it('stays silent on silence rather than ringing', () => {
    const out = run(new Float32Array(SAMPLE_RATE / 2), VOICE_PRESETS.higher)
    expect(peak(out)).toBeLessThan(1e-6)
  })
})

describe('VoiceMasker, real-time shape', () => {
  it('reports its added latency, and it is the frame minus one hop', () => {
    expect(latencySamples(VOICE_PRESETS.lower)).toBe(FRAME_SIZE - HOP_SIZE)
    const ms = presetLatencyMs('lower', SAMPLE_RATE)
    expect(ms).toBeCloseTo(((FRAME_SIZE - HOP_SIZE) / SAMPLE_RATE) * 1000, 6)
    // The budget: past roughly 50ms a conversation stops working.
    expect(ms).toBeLessThan(50)
  })

  it('gives the same answer whatever block size it is fed', () => {
    const input = vowel(150, 800, 0.4)
    const a = run(input, VOICE_PRESETS.neutral, 128)
    const b = run(input, VOICE_PRESETS.neutral, 1000)
    for (let i = 0; i < input.length; i += 1) expect(b[i]!).toBeCloseTo(a[i]!, 5)
  })

  it('handles the 128-sample quantum an AudioWorklet actually delivers', () => {
    const input = vowel(150, 800, 0.3)
    const out = run(input, VOICE_PRESETS.higher, 128)
    expect(rms(out, SETTLE)).toBeGreaterThan(0)
  })

  it('starts again cleanly after a reset', () => {
    const input = vowel(150, 800, 0.3)
    const masker = new VoiceMasker({ sampleRate: SAMPLE_RATE, settings: VOICE_PRESETS.lower })
    const first = new Float32Array(input.length)
    masker.process(input, first)
    masker.reset()
    const second = new Float32Array(input.length)
    masker.process(input, second)
    for (let i = 0; i < input.length; i += 1) expect(second[i]!).toBeCloseTo(first[i]!, 5)
  })

  it('changes preset without a click or a burst', () => {
    const input = vowel(150, 800, 1, 0.4)
    const masker = new VoiceMasker({ sampleRate: SAMPLE_RATE, settings: VOICE_PRESETS.lower })
    const out = new Float32Array(input.length)
    for (let i = 0; i < input.length; i += 128) {
      if (i === 24_000) masker.setSettings(VOICE_PRESETS.higher)
      const n = Math.min(128, input.length - i)
      masker.process(input.subarray(i, i + n), out.subarray(i, i + n))
    }
    expect(peak(out)).toBeLessThanOrEqual(1)
    // No step change in level either side of the switch.
    const before = rms(out.subarray(20_000, 23_500))
    const after = rms(out.subarray(26_000, 30_000))
    expect(Math.abs(20 * Math.log10(after / before))).toBeLessThan(3)
  })
})
