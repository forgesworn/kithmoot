import { MAX_CHAT_TEXT_LENGTH } from '../chat.js'
import type { ChatMessage } from '../chat.js'
import type { ParticipantView } from '../session.js'
import type { Completer } from './brains.js'
import type { AgentRuntime, RuntimeEvent } from './runtime.js'

/**
 * What a person types in the chat to have the minutes written now. Any
 * member can, because any member holds the room key and the minutes are
 * the room's. Matched as the first word, case-insensitively, so
 * "!minutes please" works.
 */
export const MINUTES_REQUEST = '!minutes'

/**
 * How long the room has to be without media before a call is over. Three
 * minutes: long enough that a person whose connection dropped and came
 * back is still in the same call, short enough that the minutes are on
 * the channel before people have wandered off to read them.
 */
export const DEFAULT_CALL_ENDS_AFTER_MS = 3 * 60_000

/**
 * How a model is told to write minutes. Fixed, so two rooms with the same
 * transcript get the same shape of minutes and a reader knows where to
 * look.
 */
export const MINUTES_PROTOCOL = `
You write the minutes of a meeting from its transcript. You are given who attended and, in order, what each person said. Write in British English, in plain prose, as a person who was in the room would.

Write these four parts in this order, each under a heading of its own on one line:
Attendees: who was there, from the list given, one line.
Decisions: what was agreed. If nothing was decided, say so in one line.
Actions: what somebody took on, and who. If nobody took anything on, say so in one line.
Open questions: what was raised and not settled. If nothing was left open, say so in one line.

Keep to what was said. Do not invent, do not editorialise, do not add a preamble or a sign-off. Name people as they are named in the transcript, key and all.
`.trim()

export interface ScribeOptions {
  /** What writes the minutes. Omit for the transcript grouped by speaker,
   *  which is what a scribe with no model behind it writes. */
  completer?: Completer
  /** How long the room has to be without media before the call is over.
   *  See `DEFAULT_CALL_ENDS_AFTER_MS`. */
  callEndsAfterMs?: number
  /** Milliseconds. Defaults to `Date.now`. */
  now?: () => number
  log?: (line: string) => void
}

/** Why the minutes were written. */
export type MinutesReason = 'request' | 'call-end'

/**
 * A member that writes the minutes.
 *
 * The runtime hears what people said and writes it to the transcript
 * channel; this is the step after. It keeps every transcript line since the
 * last minutes, and when asked - `!minutes` in the chat - or when the call
 * ends - media had been present in the room and none has been for a quiet
 * period - it writes what those lines came to on the `minutes` channel:
 * attendees, decisions, actions, open questions, in that order. A model
 * writes the prose when there is one; without one, the lines themselves
 * go out, grouped by speaker, so the feature works with nothing installed.
 *
 * Minutes cover the transcript since the last minutes, so asking mid-call
 * and then ending the call gives two sets that do not overlap, and a call
 * whose media flaps ends once. Only the transcript is read: a person whose
 * switch is off sends the room's agents nothing, so nothing of theirs is in
 * the transcript, so nothing of theirs is in the minutes.
 */
export class Scribe {
  readonly #runtime: AgentRuntime
  readonly #completer?: Completer
  readonly #callEndsAfterMs: number
  readonly #now: () => number
  readonly #log: (line: string) => void
  /** Transcript since the last minutes. */
  #lines: ChatMessage[] = []
  /** Everybody seen in the room since the last minutes, besides this. */
  readonly #attendees = new Set<string>()
  #inCall = false
  #quiet?: ReturnType<typeof setTimeout>
  /** Writes happen one after another, so a request during a write waits
   *  for it rather than racing it, and a call end during a request finds
   *  the buffer already emptied and writes nothing twice. */
  #queue: Promise<void> = Promise.resolve()
  #off?: () => void
  #closed = false

  constructor(runtime: AgentRuntime, opts: ScribeOptions = {}) {
    this.#runtime = runtime
    this.#completer = opts.completer
    this.#callEndsAfterMs = opts.callEndsAfterMs ?? DEFAULT_CALL_ENDS_AFTER_MS
    this.#now = opts.now ?? (() => Date.now())
    this.#log = opts.log ?? (() => {})
  }

  /** Start following the room. Returns a function that stops. */
  async start(): Promise<() => Promise<void>> {
    this.#roster(this.#runtime.roster())
    this.#off = this.#runtime.on((event) => this.#onEvent(event))
    return async () => {
      this.#closed = true
      this.#off?.()
      this.#off = undefined
      if (this.#quiet) clearTimeout(this.#quiet)
      this.#quiet = undefined
      await this.#queue
    }
  }

  /** Whether media is in the room, as far as the scribe is concerned. */
  get inCall(): boolean {
    return this.#inCall
  }

  /** How many transcript lines the next minutes will cover. */
  get pending(): number {
    return this.#lines.length
  }

  #onEvent(event: RuntimeEvent): void {
    if (this.#closed) return
    if (event.type === 'roster') {
      this.#roster(event.participants)
      return
    }
    // A verdict on something this scribe asked is not a line of minutes,
    // and neither is somebody clicking Invite.
    if (event.type === 'approval' || event.type === 'presence') return
    const m = event.message
    if (event.type === 'transcript') {
      this.#lines.push(m)
      if (m.speaker) this.#attendees.add(m.speaker)
      return
    }
    if (event.type !== 'chat' || m.participant === this.#runtime.agent.participant) return
    if (!isMinutesRequest(m.text)) return
    this.#log(`${this.#runtime.nameOf(m.participant)} asked for the minutes`)
    this.write('request')
  }

  #roster(participants: ParticipantView[]): void {
    const me = this.#runtime.agent.participant
    let live = false
    for (const v of participants) {
      if (v.participant === me) continue
      this.#attendees.add(v.participant)
      if (v.tracks.length > 0) live = true
    }
    if (live) {
      if (this.#quiet) {
        // Media came back inside the quiet period: the same call, still on.
        clearTimeout(this.#quiet)
        this.#quiet = undefined
        this.#log('media is back; the call goes on')
      }
      if (!this.#inCall) {
        this.#inCall = true
        this.#log('a call has started')
      }
      return
    }
    if (!this.#inCall || this.#quiet) return
    this.#quiet = setTimeout(() => {
      this.#quiet = undefined
      this.#inCall = false
      this.#log('no media for the quiet period: the call has ended')
      this.write('call-end')
    }, this.#callEndsAfterMs)
  }

  /**
   * Write the minutes for everything since the last minutes. Queued behind
   * any write in progress. Resolves when the minutes are on the channel,
   * or at once when there was nothing to write.
   */
  write(reason: MinutesReason): Promise<void> {
    const run = this.#queue.then(() => this.#write(reason)).catch((err) => this.#log(`minutes: ${err instanceof Error ? err.message : String(err)}`))
    this.#queue = run
    return run
  }

  async #write(reason: MinutesReason): Promise<void> {
    if (this.#closed) return
    const lines = this.#lines
    const attendees = [...this.#attendees].map((p) => this.#runtime.nameOf(p))
    this.#lines = []
    this.#attendees.clear()
    if (lines.length === 0) {
      // A call in which nobody let the scribe hear them leaves nothing to
      // minute, and nothing is what goes out. A person who asked is
      // answered, because a question deserves one.
      if (reason === 'request') await this.#runtime.say('Nothing to minute: nobody has said anything aloud that reached me since the last minutes.')
      this.#log(`nothing to minute (${reason})`)
      return
    }
    const heading = this.#heading(reason, attendees)
    let body: string | undefined
    if (this.#completer) {
      try {
        body = (await this.#completer.complete(MINUTES_PROTOCOL, this.#prompt(attendees, lines))).trim()
      } catch (err) {
        this.#log(`the model did not answer (${err instanceof Error ? err.message : String(err)}); writing the transcript instead`)
      }
    }
    if (!body) body = this.#grouped(lines)
    const text = `${heading}\n\n${body}`
    const chunks = chunkMinutes(text)
    this.#log(`writing minutes (${reason}): ${lines.length} lines, ${chunks.length} message${chunks.length === 1 ? '' : 's'}`)
    let lastSecond: number | undefined
    for (const chunk of chunks) {
      // Messages in the same second order by id, which is random, so the
      // second half of the minutes must not share a second with the first.
      if (lastSecond !== undefined) await this.#nextSecond(lastSecond)
      lastSecond = Math.floor(this.#now() / 1000)
      await this.#runtime.agent.minutes.send(chunk)
    }
  }

  #heading(reason: MinutesReason, attendees: string[]): string {
    const when = formatWhen(this.#now())
    const why = reason === 'request' ? 'on request' : 'at the end of the call'
    // The runtime names this agent "you"; the minutes are read by others,
    // and what the reader should know about the writer is that it is one.
    const by = this.#runtime.nameOf(this.#runtime.agent.participant).replace(/, you\)$/, ', agent)')
    const who = attendees.length ? attendees.join('; ') : 'nobody besides the scribe'
    return `Minutes, ${when}, ${why}, taken by ${by}.\nAttendees: ${who}.`
  }

  #prompt(attendees: string[], lines: ChatMessage[]): string {
    return ['Attendees:', ...attendees.map((a) => `- ${a}`), '', 'Transcript:', ...lines.map((m) => this.#runtime.line(m))].join('\n')
  }

  /** The transcript itself, grouped by speaker in the order they first
   *  spoke, each line with its time. What goes out with no model. */
  #grouped(lines: ChatMessage[]): string {
    const bySpeaker = new Map<string, string[]>()
    for (const m of lines) {
      const who = m.speaker ? this.#runtime.nameOf(m.speaker) : 'somebody'
      const when = new Date(m.sentAt * 1000).toISOString().slice(11, 16)
      const said = bySpeaker.get(who) ?? []
      said.push(`${when} ${m.text}`)
      bySpeaker.set(who, said)
    }
    const out = ['What was said, by speaker:']
    for (const [who, said] of bySpeaker) {
      out.push('', `${who}:`, ...said)
    }
    return out.join('\n')
  }

  async #nextSecond(after: number): Promise<void> {
    while (Math.floor(this.#now() / 1000) <= after) {
      const wait = 1000 - (this.#now() % 1000) + 5
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
}

/** Whether a line of chat asks for the minutes. */
export function isMinutesRequest(text: string): boolean {
  const first = text.trim().split(/\s+/)[0] ?? ''
  return first.toLowerCase() === MINUTES_REQUEST
}

/**
 * Cut a text into messages no longer than the chat allows, breaking at a
 * line end where there is one and a space where there is not, and marking
 * every part after the first with where it sits, so a reader who sees them
 * out of order can still put them together.
 */
export function chunkMinutes(text: string, max = MAX_CHAT_TEXT_LENGTH): string[] {
  if (text.length <= max) return [text]
  // Room for the widest marker this could need.
  const marker = (i: number, n: number) => `(continued, ${i} of ${n})\n`
  const budget = max - marker(999, 999).length
  const parts: string[] = []
  let rest = text
  while (rest.length > 0) {
    if (rest.length <= budget) {
      parts.push(rest)
      break
    }
    let cut = rest.lastIndexOf('\n', budget)
    if (cut < budget / 2) cut = rest.lastIndexOf(' ', budget)
    if (cut < budget / 2) cut = budget
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^[ \n]/, '')
  }
  return parts.map((part, i) => (i === 0 ? part : marker(i + 1, parts.length) + part))
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** `2 September 2026, 14:05 UTC`. */
export function formatWhen(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`
}
