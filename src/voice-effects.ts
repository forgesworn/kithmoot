/**
 * Voice masking for the outgoing microphone track.
 *
 * ## Read this before writing any copy about it
 *
 * This shifts pitch and formants. That defeats **casual recognition**:
 * someone who knows your voice will not place it straight away, and a
 * recording passed around will not obviously be you.
 *
 * It does **not** make you unidentifiable. Anyone holding a voiceprint and
 * willing to use it can still match you, the shift is a known transform that
 * can be searched over, and none of this survives a forensic comparison.
 *
 * So it is called **voice masking**, everywhere, and never "anonymity" and
 * never "unidentifiable". This is not pedantry about wording: the one way
 * this feature hurts somebody is a person relying on it in a situation where
 * being identified matters, because a control implied a guarantee it cannot
 * give. The UI states the limit next to the control, in the same register
 * the README uses for what does not work yet.
 *
 * ## Why formants move separately from pitch
 *
 * Pitch shift alone is a chipmunk, and it is trivially undone: shift back by
 * the same interval and you have the original voice. The formants are the
 * resonances of a particular throat and mouth, and they are a good part of
 * what makes a voice recognisable. Moving them by a *different* factor from
 * the pitch is both more natural to listen to and not a single-parameter
 * inversion, because the excitation and the envelope have been decoupled and
 * recombined.
 *
 * ## Method
 *
 * A phase vocoder: overlap-add STFT, per-bin true-frequency estimation from
 * the phase advance, bin remapping for pitch, and a cepstrally-liftered
 * spectral envelope divided out before the shift and re-applied warped
 * afterwards for formants. No model, a few kilobytes of code, and a fixed
 * latency of one frame minus one hop.
 *
 * Everything in this file is plain arithmetic on `Float32Array`, with no
 * reference to Web Audio, so it runs and is tested in Node. The
 * `AudioWorkletProcessor` that drives it in a browser lives in `app/`.
 */

// ---------------------------------------------------------------------------
// Shape of the transform
// ---------------------------------------------------------------------------

/**
 * STFT frame length, in samples.
 *
 * 1024 at 48kHz is 21ms of window, which is long enough to resolve a low
 * male fundamental (bins are 47Hz apart, and the phase advance refines
 * within a bin) and short enough that the resulting latency is a fifth of
 * the conversational budget. 2048 sounds slightly better and costs 32ms,
 * which is most of the budget for a barely audible gain.
 */
export const FRAME_SIZE = 1024

/** Four-times overlap. Less than this and the overlap-add ripples audibly. */
export const OVERSAMPLING = 4
export const HOP_SIZE = FRAME_SIZE / OVERSAMPLING

/**
 * Cepstral lifter length: how many quefrency coefficients the spectral
 * envelope keeps.
 *
 * Too few and the envelope flattens, so formant shifting does nothing. Too
 * many and the envelope starts tracking individual harmonics, so the
 * excitation goes flat and the shift stops sounding like a different throat.
 * 32 at this frame size sits between the two.
 */
export const CEPSTRAL_LIFTER = 32

/** Beyond about an octave either way it stops being a person and starts
 *  being an effect, which is neither useful nor honest. */
export const MAX_SEMITONES = 12
export const MIN_FORMANT_RATIO = 0.5
export const MAX_FORMANT_RATIO = 2

/** Where the limiter starts to bend. Below this nothing is touched. */
const LIMIT_THRESHOLD = 0.95

/** How fast the level correction is allowed to move, per frame. At four-times
 *  overlap that is 187 frames a second, so 0.1 settles in about 50ms: quick
 *  enough that nobody hears the start of a sentence come up, slow enough that
 *  it does not chase individual plosives and pump. */
const GAIN_SMOOTHING = 0.1
const MIN_GAIN = 0.25
const MAX_GAIN = 4

/** Below this the input is silence or room noise, and the level correction
 *  holds where it is rather than winding itself up to `MAX_GAIN` on a gap
 *  between words. */
const SILENCE_FLOOR = 1e-5

const EPSILON = 1e-10

/**
 * What the overlap-add has to be divided by to come back out at the level it
 * went in at, worked out rather than tuned by ear.
 *
 * Two factors. The synthesis spectrum is built from a magnitude that already
 * had the negative-frequency half folded into it (the `2 *` in the analysis)
 * and is then mirrored back out conjugate-symmetrically, so the inverse
 * transform returns twice the windowed frame. And the frame is windowed on
 * the way out as well as on the way in, so what overlap-add sums is Hann
 * squared: mean 3/8, `OVERSAMPLING` frames deep.
 *
 * For a 1024-point frame at four-times overlap this is exactly a third. It
 * is written as the arithmetic rather than as `1 / 3` so that changing
 * `OVERSAMPLING` does not silently change the output level.
 */
const HANN_SQUARED_OVERLAP_SUM = (3 * OVERSAMPLING) / 8
const SYNTHESIS_SCALE = 1 / (2 * HANN_SQUARED_OVERLAP_SUM)

export interface VoiceSettings {
  /** Pitch shift in semitones. Negative is down. */
  semitones: number
  /** Formant scale. Above 1 moves the resonances up, which reads as a
   *  smaller head; below 1, larger. Independent of `semitones` by design. */
  formantRatio: number
}

export type VoicePreset = 'off' | 'lower' | 'higher' | 'neutral'

export const IDENTITY_VOICE_SETTINGS: VoiceSettings = { semitones: 0, formantRatio: 1 }

/**
 * The four the UI offers.
 *
 * Presets rather than sliders because a slider invites someone to find the
 * setting that sounds least like them, which is a different and much worse
 * question than "which of these four is usable". These four are all
 * intelligible on a bad connection, which is the property that matters.
 *
 * `neutral` is the interesting one: pitch down slightly with the formants
 * moved *up*. Listeners judge the size of a speaker from pitch and formants
 * together, so making the two disagree removes that cue without landing the
 * result anywhere in particular, and it is a shift no single inverse
 * transform undoes.
 */
export const VOICE_PRESETS: Record<VoicePreset, VoiceSettings> = {
  off: IDENTITY_VOICE_SETTINGS,
  lower: { semitones: -4, formantRatio: 0.88 },
  higher: { semitones: 4, formantRatio: 1.14 },
  neutral: { semitones: -2, formantRatio: 1.06 },
}

/** Off, because turning someone's own voice into somebody else's without
 *  being asked is not a safe default the way blurring a room is. */
export const DEFAULT_VOICE_PRESET: VoicePreset = 'off'

export function semitonesToRatio(semitones: number): number {
  return Math.pow(2, semitones / 12)
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function clampVoiceSettings(settings: VoiceSettings): VoiceSettings {
  const { semitones, formantRatio } = settings
  if (
    typeof semitones !== 'number' ||
    typeof formantRatio !== 'number' ||
    !Number.isFinite(semitones) ||
    !Number.isFinite(formantRatio)
  ) {
    // Nonsense means pass the voice through, never means silence: a mic that
    // has gone quiet mid-sentence is worse than one that is unmasked, and
    // the user can see which preset is selected.
    return IDENTITY_VOICE_SETTINGS
  }
  return {
    semitones: clampNumber(semitones, -MAX_SEMITONES, MAX_SEMITONES),
    formantRatio: clampNumber(formantRatio, MIN_FORMANT_RATIO, MAX_FORMANT_RATIO),
  }
}

export function isIdentitySettings(settings: VoiceSettings): boolean {
  const s = clampVoiceSettings(settings)
  return s.semitones === 0 && s.formantRatio === 1
}

/**
 * Added latency in samples.
 *
 * Zero when nothing is being done: "off" is a genuine bypass, not the
 * vocoder configured to do nothing, so selecting it gets the original
 * latency back rather than merely the original voice.
 */
export function latencySamples(settings: VoiceSettings): number {
  return isIdentitySettings(settings) ? 0 : FRAME_SIZE - HOP_SIZE
}

export function presetLatencyMs(preset: VoicePreset, sampleRate: number): number {
  return (latencySamples(VOICE_PRESETS[preset]) / sampleRate) * 1000
}

// ---------------------------------------------------------------------------
// FFT
// ---------------------------------------------------------------------------

/**
 * In-place iterative radix-2 FFT. `re.length` must be a power of two.
 *
 * Written out rather than pulled in because it is forty lines, it runs in an
 * `AudioWorkletProcessor` where every import is a liability, and a
 * dependency here would be a dependency in the audio thread.
 */
export function fftInPlace(re: Float32Array, im: Float32Array, inverse = false): void {
  const n = re.length
  if (n !== im.length) throw new Error('fft: real and imaginary parts differ in length')
  if (n === 0 || (n & (n - 1)) !== 0) throw new Error(`fft: length ${n} is not a power of two`)

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]!
      re[i] = re[j]!
      re[j] = tr
      const ti = im[i]!
      im[i] = im[j]!
      im[j] = ti
    }
  }

  const sign = inverse ? 1 : -1
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (sign * 2 * Math.PI) / len
    const wr = Math.cos(angle)
    const wi = Math.sin(angle)
    for (let i = 0; i < n; i += len) {
      let curR = 1
      let curI = 0
      for (let k = 0; k < len / 2; k += 1) {
        const ar = re[i + k]!
        const ai = im[i + k]!
        const br = re[i + k + len / 2]!
        const bi = im[i + k + len / 2]!
        const tr = br * curR - bi * curI
        const ti = br * curI + bi * curR
        re[i + k] = ar + tr
        im[i + k] = ai + ti
        re[i + k + len / 2] = ar - tr
        im[i + k + len / 2] = ai - ti
        const nextR = curR * wr - curI * wi
        curI = curR * wi + curI * wr
        curR = nextR
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      re[i] = re[i]! / n
      im[i] = im[i]! / n
    }
  }
}

/**
 * The smooth curve a magnitude spectrum sits under, found by keeping only
 * the low quefrency part of its cepstrum.
 *
 * `mag` holds bins 0 to `frameSize / 2` inclusive. The result has the same
 * length. This is the resonance structure of a throat with the harmonics of
 * the vocal folds taken out of it, which is exactly the thing that has to
 * move independently for a formant shift to mean anything.
 */
export function spectralEnvelope(
  mag: Float32Array | ArrayLike<number>,
  frameSize: number,
  lifter: number = CEPSTRAL_LIFTER,
): Float32Array {
  const out = new Float32Array(frameSize / 2 + 1)
  spectralEnvelopeInto(mag, frameSize, lifter, new Float32Array(frameSize), new Float32Array(frameSize), out)
  return out
}

/**
 * `spectralEnvelope` with every buffer handed in.
 *
 * The audio thread runs this 187 times a second and must not allocate while
 * it does: a garbage collection inside an `AudioWorkletProcessor` is an
 * audible dropout, and dropouts on a masked voice are indistinguishable from
 * the masking being broken.
 */
export function spectralEnvelopeInto(
  mag: Float32Array | ArrayLike<number>,
  frameSize: number,
  lifter: number,
  re: Float32Array,
  im: Float32Array,
  out: Float32Array,
): void {
  const half = frameSize / 2
  im.fill(0)
  for (let k = 0; k < frameSize; k += 1) {
    const mirrored = k <= half ? k : frameSize - k
    re[k] = Math.log(Math.max(EPSILON, mag[mirrored] ?? EPSILON))
  }
  fftInPlace(re, im, false)
  for (let k = lifter + 1; k < frameSize - lifter; k += 1) {
    re[k] = 0
    im[k] = 0
  }
  fftInPlace(re, im, true)
  for (let k = 0; k <= half; k += 1) out[k] = Math.exp(re[k]!)
}

/** A limiter that is transparent below the threshold and asymptotic above
 *  it, so a hot input is held under 1.0 without the buzz of a hard clip. */
function softClip(x: number): number {
  if (x > LIMIT_THRESHOLD) {
    return LIMIT_THRESHOLD + (1 - LIMIT_THRESHOLD) * Math.tanh((x - LIMIT_THRESHOLD) / (1 - LIMIT_THRESHOLD))
  }
  if (x < -LIMIT_THRESHOLD) {
    return -LIMIT_THRESHOLD - (1 - LIMIT_THRESHOLD) * Math.tanh((-x - LIMIT_THRESHOLD) / (1 - LIMIT_THRESHOLD))
  }
  return x
}

// ---------------------------------------------------------------------------
// The masker
// ---------------------------------------------------------------------------

export interface VoiceMaskerOptions {
  sampleRate: number
  settings?: VoiceSettings
}

export class VoiceMasker {
  readonly #sampleRate: number
  readonly #half = FRAME_SIZE / 2
  #settings: VoiceSettings
  #bypass: boolean

  readonly #window = new Float32Array(FRAME_SIZE)
  readonly #inFifo = new Float32Array(FRAME_SIZE)
  readonly #outFifo = new Float32Array(FRAME_SIZE)
  readonly #outAccum = new Float32Array(FRAME_SIZE * 2)
  readonly #re = new Float32Array(FRAME_SIZE)
  readonly #im = new Float32Array(FRAME_SIZE)
  readonly #lastPhase: Float32Array
  readonly #sumPhase: Float32Array
  readonly #anaMagn: Float32Array
  readonly #anaFreq: Float32Array
  readonly #synMagn: Float32Array
  readonly #synFreq: Float32Array
  readonly #excitation: Float32Array
  readonly #envelope: Float32Array
  readonly #envRe = new Float32Array(FRAME_SIZE)
  readonly #envIm = new Float32Array(FRAME_SIZE)
  #rover = FRAME_SIZE - HOP_SIZE
  #gain = 1

  constructor(opts: VoiceMaskerOptions) {
    this.#sampleRate = opts.sampleRate
    this.#settings = clampVoiceSettings(opts.settings ?? IDENTITY_VOICE_SETTINGS)
    this.#bypass = isIdentitySettings(this.#settings)
    const bins = this.#half + 1
    this.#lastPhase = new Float32Array(bins)
    this.#sumPhase = new Float32Array(bins)
    this.#anaMagn = new Float32Array(bins)
    this.#anaFreq = new Float32Array(bins)
    this.#synMagn = new Float32Array(bins)
    this.#synFreq = new Float32Array(bins)
    this.#excitation = new Float32Array(bins)
    this.#envelope = new Float32Array(bins)
    for (let k = 0; k < FRAME_SIZE; k += 1) {
      this.#window[k] = 0.5 * (1 - Math.cos((2 * Math.PI * k) / FRAME_SIZE))
    }
  }

  get settings(): VoiceSettings {
    return this.#settings
  }

  get latencySamples(): number {
    return latencySamples(this.#settings)
  }

  get latencyMs(): number {
    return (this.latencySamples / this.#sampleRate) * 1000
  }

  /** Change what the masker is doing without restarting it. The phase
   *  accumulators carry on, so a preset change mid-sentence is a change of
   *  voice rather than a click. */
  setSettings(settings: VoiceSettings): void {
    this.#settings = clampVoiceSettings(settings)
    this.#bypass = isIdentitySettings(this.#settings)
  }

  reset(): void {
    this.#inFifo.fill(0)
    this.#outFifo.fill(0)
    this.#outAccum.fill(0)
    this.#lastPhase.fill(0)
    this.#sumPhase.fill(0)
    this.#rover = FRAME_SIZE - HOP_SIZE
    this.#gain = 1
  }

  /**
   * One block. `output` may be the same length as `input` and nothing else
   * is assumed about the block size, because an `AudioWorklet` delivers 128
   * samples and a test does not.
   */
  process(input: Float32Array, output: Float32Array): void {
    if (this.#bypass) {
      output.set(input.subarray(0, output.length))
      return
    }

    const latency = FRAME_SIZE - HOP_SIZE
    for (let i = 0; i < input.length; i += 1) {
      this.#inFifo[this.#rover] = input[i]!
      output[i] = this.#outFifo[this.#rover - latency]!
      this.#rover += 1
      if (this.#rover >= FRAME_SIZE) {
        this.#rover = latency
        this.#processFrame()
      }
    }
  }

  #processFrame(): void {
    const half = this.#half
    const freqPerBin = this.#sampleRate / FRAME_SIZE
    const expected = (2 * Math.PI * HOP_SIZE) / FRAME_SIZE
    const pitchRatio = semitonesToRatio(this.#settings.semitones)
    const formantRatio = this.#settings.formantRatio

    // --- analysis ---------------------------------------------------------
    for (let k = 0; k < FRAME_SIZE; k += 1) {
      this.#re[k] = this.#inFifo[k]! * this.#window[k]!
      this.#im[k] = 0
    }
    fftInPlace(this.#re, this.#im, false)

    for (let k = 0; k <= half; k += 1) {
      const real = this.#re[k]!
      const imag = this.#im[k]!
      const magnitude = 2 * Math.hypot(real, imag)
      const phase = Math.atan2(imag, real)

      // Phase advance since the last frame, with the advance a bin at its
      // centre frequency would have had taken out of it. What is left is
      // how far off centre this partial actually is, which is what makes a
      // 47Hz-wide bin able to report a 220Hz tone as 220Hz.
      let delta = phase - this.#lastPhase[k]!
      this.#lastPhase[k] = phase
      delta -= k * expected
      const wraps = Math.round(delta / Math.PI)
      delta -= Math.PI * wraps
      delta = (OVERSAMPLING * delta) / (2 * Math.PI)

      this.#anaMagn[k] = magnitude
      this.#anaFreq[k] = k * freqPerBin + delta * freqPerBin
    }

    // --- take the throat out of it ---------------------------------------
    spectralEnvelopeInto(
      this.#anaMagn,
      FRAME_SIZE,
      CEPSTRAL_LIFTER,
      this.#envRe,
      this.#envIm,
      this.#envelope,
    )
    const envelope = this.#envelope
    for (let k = 0; k <= half; k += 1) {
      this.#excitation[k] = this.#anaMagn[k]! / Math.max(EPSILON, envelope[k]!)
    }

    // --- shift the excitation, which is the pitch -------------------------
    this.#synMagn.fill(0)
    this.#synFreq.fill(0)
    for (let k = 0; k <= half; k += 1) {
      const target = Math.round(k * pitchRatio)
      if (target <= half) {
        this.#synMagn[target] = this.#synMagn[target]! + this.#excitation[k]!
        this.#synFreq[target] = this.#anaFreq[k]! * pitchRatio
      }
    }

    // --- put a different throat back on, which is the formants ------------
    // Reading the envelope at `k / formantRatio` moves a resonance that sat
    // at bin b out to bin b * formantRatio. Linear interpolation because the
    // envelope is smooth by construction, so nothing better is warranted.
    for (let k = 0; k <= half; k += 1) {
      const source = k / formantRatio
      const lower = Math.floor(source)
      const upper = Math.min(half, lower + 1)
      const frac = source - lower
      const value =
        lower > half
          ? envelope[half]!
          : envelope[lower]! * (1 - frac) + envelope[upper]! * frac
      this.#synMagn[k] = this.#synMagn[k]! * value
    }

    // --- synthesis --------------------------------------------------------
    for (let k = 0; k <= half; k += 1) {
      let delta = this.#synFreq[k]! - k * freqPerBin
      delta /= freqPerBin
      delta = (2 * Math.PI * delta) / OVERSAMPLING
      delta += k * expected
      this.#sumPhase[k] = this.#sumPhase[k]! + delta
      const phase = this.#sumPhase[k]!
      this.#re[k] = this.#synMagn[k]! * Math.cos(phase)
      this.#im[k] = this.#synMagn[k]! * Math.sin(phase)
    }
    for (let k = half + 1; k < FRAME_SIZE; k += 1) {
      this.#re[k] = this.#re[FRAME_SIZE - k]!
      this.#im[k] = -this.#im[FRAME_SIZE - k]!
    }
    fftInPlace(this.#re, this.#im, true)

    // --- overlap-add ------------------------------------------------------
    for (let k = 0; k < FRAME_SIZE; k += 1) {
      this.#outAccum[k] = this.#outAccum[k]! + this.#window[k]! * this.#re[k]! * SYNTHESIS_SCALE
    }
    // --- hold the level ---------------------------------------------------
    // Measured on the samples, not on the spectrum. Dividing by one envelope
    // and multiplying by a warped one conserves nothing in general, and the
    // bin remapping smears a partial across two bins whose phases then partly
    // cancel - a loss that is invisible in the magnitude domain and about
    // 4dB in the time domain. An unattended gain drop on a live microphone
    // reads as "the masking broke my mic", so it is corrected here where it
    // can actually be seen.
    let inEnergy = 0
    for (let k = 0; k < FRAME_SIZE; k += 1) inEnergy += this.#inFifo[k]! * this.#inFifo[k]!
    let outEnergy = 0
    for (let k = 0; k < HOP_SIZE; k += 1) outEnergy += this.#outAccum[k]! * this.#outAccum[k]!
    const inRms = Math.sqrt(inEnergy / FRAME_SIZE)
    const outRms = Math.sqrt(outEnergy / HOP_SIZE)
    if (inRms > SILENCE_FLOOR && outRms > SILENCE_FLOOR) {
      const target = clampNumber(inRms / outRms, MIN_GAIN, MAX_GAIN)
      this.#gain += (target - this.#gain) * GAIN_SMOOTHING
    }

    for (let k = 0; k < HOP_SIZE; k += 1) {
      this.#outFifo[k] = softClip(this.#outAccum[k]! * this.#gain)
    }
    this.#outAccum.copyWithin(0, HOP_SIZE, FRAME_SIZE + HOP_SIZE)
    this.#outAccum.fill(0, FRAME_SIZE, FRAME_SIZE + HOP_SIZE)
    this.#inFifo.copyWithin(0, HOP_SIZE, FRAME_SIZE)
  }
}
