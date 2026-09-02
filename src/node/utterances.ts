/**
 * Cut a stream of speech into utterances, on silence.
 *
 * A transcriber that works on whole sentences - WhisperX does - wants to be
 * handed a person's turn, not a rolling twenty milliseconds. So audio is
 * accumulated while somebody is talking and released when they stop for
 * long enough, with a floor so a cough is not an utterance and a ceiling so
 * a monologue is not one utterance either. Energy-based, deliberately: a
 * real voice-activity model would be better at a noisy room and worse at
 * being something a unit test can exercise with a sine wave, and the
 * transcriber downstream is what decides whether an utterance had words in
 * it.
 *
 * Runtime-agnostic: numbers in, numbers out. The Opus decoding that feeds
 * it, and the WebRTC track that feeds that, live in `audio.ts`.
 */

export interface Utterance {
  /** Mono PCM, in the range -1..1, at `sampleRate`. */
  pcm: Float32Array
  sampleRate: number
  /** Milliseconds, on whatever clock the caller pushes with. */
  startedAt: number
  endedAt: number
}

export interface UtteranceSplitterOptions {
  /** The rate of what is pushed in. */
  sampleRate?: number
  /** The rate utterances come out at. WhisperX wants 16 kHz. */
  outputRate?: number
  /** RMS below which a block is silence. */
  threshold?: number
  /** How long the silence has to last before the utterance is over. */
  silenceMs?: number
  /** Shorter than this and it is discarded. */
  minMs?: number
  /** Longer than this and it is cut, mid-flow, and the rest starts a new one. */
  maxMs?: number
}

export const DEFAULT_SPLITTER: Required<UtteranceSplitterOptions> = {
  sampleRate: 48_000,
  outputRate: 16_000,
  threshold: 0.01,
  silenceMs: 700,
  minMs: 400,
  maxMs: 20_000,
}

export class UtteranceSplitter {
  readonly #opts: Required<UtteranceSplitterOptions>
  #chunks: Float32Array[] = []
  #samples = 0
  #startedAt: number | undefined
  #silentSamples = 0
  /** Samples of silence kept at the head of the next utterance, so its
   *  first syllable is not clipped. */
  readonly #leadIn: Float32Array[] = []
  #leadInSamples = 0

  constructor(opts: UtteranceSplitterOptions = {}) {
    this.#opts = { ...DEFAULT_SPLITTER, ...opts }
    if (this.#opts.sampleRate % this.#opts.outputRate !== 0) {
      throw new Error('sampleRate must be a whole multiple of outputRate')
    }
  }

  /** Push a block of mono samples at `sampleRate`, stamped `now` in
   *  milliseconds. Returns every utterance that completed. */
  push(block: Float32Array, now: number): Utterance[] {
    const out: Utterance[] = []
    const rate = this.#opts.sampleRate
    const silent = rms(block) < this.#opts.threshold

    if (this.#startedAt === undefined) {
      if (silent) {
        this.#keepLeadIn(block)
        return out
      }
      this.#startedAt = now - (this.#leadInSamples * 1000) / rate
      this.#chunks = [...this.#leadIn]
      this.#samples = this.#leadInSamples
      this.#leadIn.length = 0
      this.#leadInSamples = 0
    }

    this.#chunks.push(block)
    this.#samples += block.length
    this.#silentSamples = silent ? this.#silentSamples + block.length : 0

    const durationMs = (this.#samples * 1000) / rate
    const silenceMs = (this.#silentSamples * 1000) / rate
    if (silenceMs >= this.#opts.silenceMs) {
      const spoken = durationMs - silenceMs
      if (spoken >= this.#opts.minMs) out.push(this.#emit(now))
      else this.#discard()
    } else if (durationMs >= this.#opts.maxMs) {
      out.push(this.#emit(now))
    }
    return out
  }

  /** Whatever is in flight, released now - somebody left mid-sentence. */
  flush(now: number): Utterance | undefined {
    if (this.#startedAt === undefined) return undefined
    const spoken = ((this.#samples - this.#silentSamples) * 1000) / this.#opts.sampleRate
    if (spoken < this.#opts.minMs) {
      this.#discard()
      return undefined
    }
    return this.#emit(now)
  }

  #keepLeadIn(block: Float32Array): void {
    const want = Math.floor((this.#opts.sampleRate * 200) / 1000)
    this.#leadIn.push(block)
    this.#leadInSamples += block.length
    while (this.#leadInSamples - (this.#leadIn[0]?.length ?? 0) >= want && this.#leadIn.length > 1) {
      this.#leadInSamples -= this.#leadIn.shift()!.length
    }
  }

  #emit(now: number): Utterance {
    const startedAt = this.#startedAt ?? now
    const joined = concat(this.#chunks, this.#samples)
    this.#discard()
    return {
      pcm: downsample(joined, this.#opts.sampleRate / this.#opts.outputRate),
      sampleRate: this.#opts.outputRate,
      startedAt,
      endedAt: now,
    }
  }

  #discard(): void {
    this.#chunks = []
    this.#samples = 0
    this.#silentSamples = 0
    this.#startedAt = undefined
  }
}

export function rms(block: Float32Array): number {
  if (block.length === 0) return 0
  let sum = 0
  for (let i = 0; i < block.length; i++) sum += block[i]! * block[i]!
  return Math.sqrt(sum / block.length)
}

function concat(chunks: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * Drop the rate by an integer factor, averaging each group of samples
 * rather than picking one: a boxcar, which is a crude low-pass but takes
 * the worst of the aliasing out of speech, and speech is all this carries.
 */
export function downsample(pcm: Float32Array, factor: number): Float32Array {
  if (factor === 1) return pcm
  const out = new Float32Array(Math.floor(pcm.length / factor))
  for (let i = 0; i < out.length; i++) {
    let sum = 0
    const base = i * factor
    for (let j = 0; j < factor; j++) sum += pcm[base + j]!
    out[i] = sum / factor
  }
  return out
}

/** Fold stereo (or more) interleaved channels down to one. */
export function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!
  const length = channels[0]!.length
  const out = new Float32Array(length)
  for (const channel of channels) for (let i = 0; i < length; i++) out[i] += channel[i]! / channels.length
  return out
}

/** A 16-bit mono WAV, which is what every transcription server on earth
 *  accepts without argument. */
export function wavFromPcm(pcm: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + pcm.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]!))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return bytes
}
