import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ApprovalOutcome, ApprovalRequestOptions, RoomAgent } from '../agent.js'
import type { ChatLog, ChatMessage } from '../chat.js'
import type { ParticipantView } from '../session.js'
import { listenToTrack } from './audio.js'
import type { RtpTrackLike } from './audio.js'
import type { Transcriber } from './transcriber.js'
import type { UtteranceSplitterOptions } from './utterances.js'

/** The three conversations an agent follows. */
export type Channel = 'chat' | 'backchannel' | 'transcript'
export const CHANNELS: readonly Channel[] = ['chat', 'backchannel', 'transcript']

export type RuntimeEvent =
  | { type: Channel; message: ChatMessage; at: number }
  | { type: 'roster'; participants: ParticipantView[]; at: number }
  /** How a request this agent made through `requestApproval` ended: a
   *  verdict from an approver, with who gave it, or `expired`. */
  | { type: 'approval'; id: string; verdict: string; by?: string; note?: string; expired: boolean; at: number }

/**
 * Who an agent is.
 *
 * `system` is the whole of its character: a markdown file, read verbatim,
 * put in front of whatever model drives it. Nothing here interprets it.
 */
export interface Persona {
  name: string
  system: string
}

export interface RuntimeOptions {
  persona?: Persona
  /** Where to keep an append-only record of everything this agent saw and
   *  said, one JSON line per event. A room that stays open for weeks
   *  outlives what any relay retains, and an agent restarted next week
   *  should be able to read what happened last week. */
  memoryDir?: string
  /** Milliseconds. Defaults to `Date.now`. */
  now?: () => number
  /** Messages older than this many seconds at join are history rather than
   *  news: reported through `history()`, never as an event. */
  historyGraceSeconds?: number
}

/**
 * How many messages of each conversation are kept in memory for prompts and
 * for `history()`. The chat log itself keeps more; this is what a model is
 * shown.
 */
export const RUNTIME_HISTORY = 200

/**
 * One agent, running: the room session, the three conversations as a
 * single stream of events, a place to write memory, and - when asked -
 * ears.
 *
 * Everything a brain needs sits on this and nothing else: `say`, `whisper`,
 * `roster`, `history`, `on`. The brains in `brains.ts` and the MCP server
 * in `mcp.ts` are different ways of driving the same object, and a test
 * can drive it directly with none of them.
 */
export class AgentRuntime {
  readonly agent: RoomAgent
  readonly persona: Persona
  readonly #now: () => number
  readonly #listeners = new Set<(event: RuntimeEvent) => void>()
  readonly #seen = new Set<string>()
  readonly #recent: Record<Channel, ChatMessage[]> = { chat: [], backchannel: [], transcript: [] }
  readonly #memoryDir?: string
  readonly #joinedAt: number
  readonly #graceSeconds: number
  #unsubs: (() => void)[] = []
  #stopListening?: () => Promise<void>
  #closed = false

  constructor(agent: RoomAgent, opts: RuntimeOptions = {}) {
    this.agent = agent
    this.persona = opts.persona ?? { name: 'agent', system: '' }
    this.#now = opts.now ?? (() => Date.now())
    this.#memoryDir = opts.memoryDir
    this.#joinedAt = Math.floor(this.#now() / 1000)
    this.#graceSeconds = opts.historyGraceSeconds ?? 10
  }

  /** Subscribe to the room. Returns this, so `new AgentRuntime(a).start()`
   *  reads as one thing. */
  start(): this {
    this.#follow('chat', this.agent.chat)
    this.#follow('backchannel', this.agent.backchannel)
    this.#follow('transcript', this.agent.transcripts)
    this.#unsubs.push(
      this.agent.onRoster((participants) => this.#emit({ type: 'roster', participants, at: this.#now() })),
    )
    this.#unsubs.push(
      this.agent.onApproval((outcome) =>
        this.#emit({ type: 'approval', id: outcome.id, verdict: outcome.verdict, by: outcome.by, note: outcome.note, expired: outcome.expired, at: this.#now() }),
      ),
    )
    return this
  }

  #follow(channel: Channel, log: ChatLog): void {
    const ingest = (messages: ChatMessage[]) => {
      for (const message of messages) {
        if (this.#seen.has(message.id)) continue
        this.#seen.add(message.id)
        const recent = this.#recent[channel]
        recent.push(message)
        recent.sort((a, b) => a.sentAt - b.sentAt || (a.id < b.id ? -1 : 1))
        while (recent.length > RUNTIME_HISTORY) recent.shift()
        // Replayed history is context, not news. A message sent before we
        // arrived was not said to us, and a brain that answers a week-old
        // question on arrival is a brain nobody wants in the room.
        if (message.sentAt < this.#joinedAt - this.#graceSeconds) continue
        this.#emit({ type: channel, message, at: this.#now() })
      }
    }
    ingest(log.messages())
    this.#unsubs.push(log.onChange(ingest))
  }

  #emit(event: RuntimeEvent): void {
    if (this.#closed) return
    void this.#remember(event)
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch {
        // A listener's problem, not the room's.
      }
    }
  }

  async #remember(event: RuntimeEvent): Promise<void> {
    if (!this.#memoryDir) return
    try {
      await mkdir(this.#memoryDir, { recursive: true })
      const line =
        event.type === 'roster'
          ? { type: 'roster', at: event.at, participants: event.participants.map((p) => ({ participant: p.participant, name: p.name, agent: p.agent === true })) }
          : event.type === 'approval'
          ? { type: 'approval', at: event.at, id: event.id, verdict: event.verdict, by: event.by, note: event.note }
          : { type: event.type, at: event.at, id: event.message.id, participant: event.message.participant, name: event.message.name, kind: event.message.kind, speaker: event.message.speaker, text: event.message.text, sentAt: event.message.sentAt }
      await appendFile(join(this.#memoryDir, 'log.jsonl'), JSON.stringify(line) + '\n')
    } catch {
      // Memory is best effort. The room does not stop because a disk did.
    }
  }

  on(listener: (event: RuntimeEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Wait for the next event on any of `channels`, or until `timeoutMs`. */
  next(timeoutMs: number, channels?: readonly RuntimeEvent['type'][]): Promise<RuntimeEvent | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off()
        resolve(undefined)
      }, timeoutMs)
      const off = this.on((event) => {
        if (channels && !channels.includes(event.type)) return
        clearTimeout(timer)
        off()
        resolve(event)
      })
    })
  }

  history(channel: Channel, limit = 50): ChatMessage[] {
    return this.#recent[channel].slice(-limit)
  }

  roster(): ParticipantView[] {
    return this.agent.roster()
  }

  /** The best name the room has for a participant: their roster name, the
   *  name on a message they sent, or a short key. Always with the short
   *  key, because a name is a claim. */
  nameOf(participant: string): string {
    const view = this.roster().find((v) => v.participant === participant)
    let name = view?.name
    if (!name) {
      for (const channel of CHANNELS) {
        const message = [...this.#recent[channel]].reverse().find((m) => m.participant === participant && m.name)
        if (message?.name) {
          name = message.name
          break
        }
      }
    }
    const short = participant.slice(0, 8)
    if (participant === this.agent.participant) return `${name ?? this.persona.name} (${short}, you)`
    // "agent of" only from a proof the session verified; a bare agent flag
    // is a claim and reads as one.
    const owner = view?.owner
    const kind = owner ? `, agent of ${this.#principalLabel(owner.principal)}` : view?.agent ? ', agent' : ''
    return name ? `${name} (${short}${kind})` : `${short}${kind ? ` (${kind.slice(2)})` : ''}`
  }

  /** A principal, by roster name or short key, for "agent of". */
  #principalLabel(principal: string): string {
    const view = this.roster().find((v) => v.participant === principal)
    const short = principal.slice(0, 8)
    if (principal === this.agent.participant) return 'you'
    return view?.name ? `${view.name} (${short})` : short
  }

  async say(text: string): Promise<void> {
    await this.agent.chat.send(text)
  }

  /** Say something on the agents' channel. The people in the room can read
   *  it; that is the point. */
  async whisper(text: string): Promise<void> {
    await this.agent.backchannel.send(text)
  }

  /** Ask a person for a decision, in the room. See `RoomAgent.requestApproval`. */
  requestApproval(opts: ApprovalRequestOptions): Promise<ApprovalOutcome> {
    return this.agent.requestApproval(opts)
  }

  /**
   * The room, as text a model can read: who is here, and the tail of each
   * conversation. Deterministic in shape so a prompt cache has a chance.
   */
  describe(limits: Partial<Record<Channel, number>> = {}): string {
    const lines: string[] = []
    lines.push(`Room ${this.agent.roomId.slice(0, 8)}. You are ${this.nameOf(this.agent.participant)}.`)
    lines.push('Present:')
    for (const view of this.roster()) {
      const tracks = view.tracks.map((t) => t.role).join(', ')
      lines.push(`- ${this.nameOf(view.participant)}${tracks ? ` [${tracks}]` : ''}`)
    }
    const render = (title: string, channel: Channel, limit: number) => {
      const messages = this.history(channel, limit)
      lines.push('')
      lines.push(`${title}:`)
      if (messages.length === 0) lines.push('(nothing yet)')
      for (const m of messages) lines.push(this.line(m))
    }
    render('Chat', 'chat', limits.chat ?? 40)
    render('Agents, among themselves', 'backchannel', limits.backchannel ?? 20)
    render('Said aloud (transcript)', 'transcript', limits.transcript ?? 30)
    return lines.join('\n')
  }

  /** One message, as a line of a transcript. */
  line(m: ChatMessage): string {
    const when = new Date(m.sentAt * 1000).toISOString().slice(11, 16)
    if (m.kind === 'transcript') {
      const who = m.speaker ? this.nameOf(m.speaker) : 'somebody'
      return `${when} ${who} said: ${m.text}`
    }
    return `${when} ${this.nameOf(m.participant)}: ${m.text}`
  }

  /**
   * Start listening: every audio track that reaches this agent is cut into
   * utterances, transcribed, and written to the transcript channel with the
   * speaker named.
   *
   * Only what reaches it. A person who has not let agents hear them sends
   * this agent nothing, and there is nothing here that could change that -
   * see `RoomSession.publishTracks`.
   */
  listen(
    transcriber: Transcriber,
    opts: UtteranceSplitterOptions & {
      onError?: (err: unknown) => void
      /** How a track is turned into utterances. The real thing decodes
       *  Opus; a test hands in something that does not need a codec. */
      attach?: typeof listenToTrack
    } = {},
  ): void {
    if (this.#stopListening) throw new Error('already listening')
    const attach = opts.attach ?? listenToTrack
    const stops = new Map<string, () => void>()
    /** One transcription at a time per speaker, so their words stay in order. */
    const queues = new Map<string, Promise<void>>()
    const unsub = this.agent.onRemoteTrack(({ participant, device, track }) => {
      const rtp = track as unknown as RtpTrackLike
      if (rtp.kind !== 'audio') return
      const key = `${device}|${(track as unknown as { id?: string }).id ?? ''}`
      stops.get(key)?.()
      attach(
        rtp,
        (utterance) => {
          const previous = queues.get(participant) ?? Promise.resolve()
          const next = previous
            .then(async () => {
              const transcript = await transcriber.transcribe(utterance)
              if (!transcript || this.#closed) return
              await this.agent.transcripts.send(transcript.text, { transcriptOf: participant })
            })
            .catch((err) => opts.onError?.(err))
          queues.set(participant, next)
        },
        opts,
      )
        .then((stop) => {
          if (this.#closed) stop()
          else stops.set(key, stop)
        })
        .catch((err) => opts.onError?.(err))
    })
    this.#stopListening = async () => {
      unsub()
      for (const stop of stops.values()) stop()
      stops.clear()
      await Promise.allSettled([...queues.values()])
    }
  }

  get listening(): boolean {
    return this.#stopListening !== undefined
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#stopListening?.()
    for (const unsub of this.#unsubs) unsub()
    this.#unsubs = []
    this.#listeners.clear()
    await this.agent.leave()
  }
}
