import { wavFromPcm } from './utterances.js'
import type { Utterance } from './utterances.js'

/** What a transcriber makes of an utterance. */
export interface Transcript {
  text: string
  language?: string
}

/**
 * Something that turns an utterance into words.
 *
 * Kept to one method so a test can hand in a fake, and so a person can hand
 * in whatever they run: WhisperX behind the small HTTP server in
 * `server/whisperx/`, or anything else that takes a WAV and answers with
 * text. Returning null means "nothing said" - breathing, a chair - and is
 * not an error.
 */
export interface Transcriber {
  transcribe(utterance: Utterance): Promise<Transcript | null>
}

export interface WhisperXOptions {
  /** Where `server/whisperx/server.py` is listening. */
  endpoint?: string
  /** Force a language rather than have it detected per utterance. Detection
   *  is per utterance and short utterances detect badly, so a room that
   *  knows what it speaks should say so. */
  language?: string
  /** How long to wait for an answer. A transcriber that has fallen over
   *  must not hold the agent's whole audio pipeline. */
  timeoutMs?: number
  fetch?: typeof fetch
}

export const DEFAULT_WHISPERX_ENDPOINT = 'http://127.0.0.1:8765'

/**
 * WhisperX, over HTTP. See `server/whisperx/README.md` for the server.
 *
 * Plain HTTP to a loopback address, on purpose: the audio of a room whose
 * people agreed to be transcribed leaves the agent's process and goes to a
 * model on the same machine, and nowhere else. Point this at a remote
 * endpoint and that is no longer true, and the person doing so should know
 * it.
 */
export class WhisperXTranscriber implements Transcriber {
  readonly #endpoint: string
  readonly #language?: string
  readonly #timeoutMs: number
  readonly #fetch: typeof fetch

  constructor(opts: WhisperXOptions = {}) {
    this.#endpoint = (opts.endpoint ?? DEFAULT_WHISPERX_ENDPOINT).replace(/\/$/, '')
    this.#language = opts.language
    this.#timeoutMs = opts.timeoutMs ?? 60_000
    this.#fetch = opts.fetch ?? fetch
  }

  async transcribe(utterance: Utterance): Promise<Transcript | null> {
    const url = new URL(`${this.#endpoint}/transcribe`)
    if (this.#language) url.searchParams.set('language', this.#language)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const res = await this.#fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: new Blob([wavFromPcm(utterance.pcm, utterance.sampleRate)], { type: 'audio/wav' }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`whisperx answered ${res.status}`)
      const body = (await res.json()) as { text?: unknown; language?: unknown }
      if (typeof body.text !== 'string') throw new Error('whisperx answered without text')
      const text = body.text.trim()
      if (text.length === 0) return null
      return typeof body.language === 'string' ? { text, language: body.language } : { text }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Answers with the same text every time. For tests, and for proving the
 *  plumbing before a model is installed. */
export class FixedTranscriber implements Transcriber {
  readonly #text: string
  readonly heard: Utterance[] = []
  constructor(text = '(speech)') {
    this.#text = text
  }
  async transcribe(utterance: Utterance): Promise<Transcript | null> {
    this.heard.push(utterance)
    return { text: this.#text }
  }
}
