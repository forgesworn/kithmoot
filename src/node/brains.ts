import type { CatalogueEntry, RunningAgent } from '../control.js'
import type { ChatAttachment, ChatMessageKind } from '../chat.js'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type Anthropic from '@anthropic-ai/sdk'
import type { AgentRuntime, Channel, RuntimeEvent } from './runtime.js'

/**
 * What drives an agent.
 *
 * The runtime is the body: it is in the room, it hears and it can speak. A
 * brain decides what to say. Three are here - one that hands everything to
 * another process over stdio, and two that ask a model - and an MCP client
 * is a fourth (`mcp.ts`). All of them see the same runtime and nothing
 * else, so a brain written against one room works in every room.
 */
export interface Brain {
  /** Start driving. Returns a function that stops. */
  start(runtime: AgentRuntime): Promise<() => Promise<void>>
}

/**
 * A model on its own: a prompt in, text out, no turn-taking. What a scribe
 * (`scribe.ts`) needs from a brain, and all it needs, so the same Ollama or
 * Claude behind a character can write the minutes without being one.
 */
export interface Completer {
  complete(system: string, user: string): Promise<string>
}

// ---------------------------------------------------------------------------
// stdio: the agent as a pipe
// ---------------------------------------------------------------------------

/** What goes out on stdout, one JSON object per line. */
export type StdioEvent =
  | {
      type: Channel
      id: string
      from: string
      name?: string
      text: string
      sentAt: number
      /** `transcript` for words an agent wrote down, `directive` for words
       *  the sender said while holding the microphone to address the
       *  agents. A brain may treat a directive as a mention whatever its
       *  engagement pattern says: pressing the microphone was the address.
       *  Absent on an ordinary message. */
      kind?: ChatMessageKind
      /** Whose words a `transcript` carries. Never set on a directive - the
       *  sender said those, so `from` already answers it. */
      speaker?: string
      attachments?: ChatAttachment[]
    }
  | { type: 'roster'; participants: Array<{ participant: string; name?: string; agent: boolean; tracks: string[] }> }
  | { type: 'ready'; participant: string; device: string; room: string; url: string; hosting: boolean }
  /** How a request made with `approval-request` ended: a verdict and who
   *  gave it, or `expired` with nobody. */
  | { type: 'approval'; id: string; verdict: string; by?: string; note?: string; expired: boolean }
  /** Somebody in the room clicked Invite or Dismiss, or asked every host to
   *  say its catalogue again. `by` is the participant who asked, and it is
   *  the whole point of the event: a brain cannot apply any rule about who
   *  may bring an agent into a room without knowing who asked. Nothing here
   *  decides on its behalf. */
  | { type: 'presence'; op: 'invite' | 'dismiss' | 'catalogue?'; host?: string; agent?: string; by: string }
  | { type: 'error'; message: string }
  | { type: 'ok'; op: string; id?: string }

/** What comes in on stdin, one JSON object per line. */
export type StdioCommand =
  | { op: 'say'; text: string }
  | { op: 'whisper'; text: string }
  | { op: 'roster' }
  | { op: 'history'; channel?: Channel; limit?: number }
  /** Ask a person in the room for a decision. The answer arrives later as
   *  an `approval` event carrying the same id, which is echoed in the ok. */
  | { op: 'approval-request'; text: string; options?: string[]; ttlSeconds?: number; id?: string }
  /** Say on the control channel what this host can run and what it is
   *  running, in the shape the browser already renders. Sent on arrival and
   *  in answer to a `presence` event with op `catalogue?`. */
  | { op: 'announce'; agents: CatalogueEntry[]; running?: RunningAgent[] }
  /** Say on the control channel that a request was refused, and why, so a
   *  click that does nothing is never indistinguishable from a click that
   *  was declined. */
  | { op: 'refuse'; agent?: string; message: string }
  | { op: 'leave' }

/** Does this text name the agent?
 *
 *  `@name` is the convention people already use and the one the app offers,
 *  so it always counts. A bare name counts too, because people typed names
 *  long before there was an `@` to type, but only as a whole word: a
 *  substring test wakes Tally on "totally", Wren on "wrench" and Quill on
 *  "quilling", and an agent that answers a word it merely appears inside is
 *  an agent people mute. `text` is already lowercased by the caller. */
export function namesAgent(text: string, name: string): boolean {
  const wanted = name.trim().toLowerCase()
  if (!wanted) return false
  const literal = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@?${literal}(?![\\p{L}\\p{N}_])`, 'u').test(text)
}

/**
 * The simplest possible first-class access: events out, commands in, one
 * JSON line each. Whatever can read and write a pipe can be in the room -
 * a shell script, a Python process, another agent framework - and it gets
 * exactly what an in-process brain gets.
 */
export class StdioBrain implements Brain {
  readonly #input: Readable
  readonly #output: Writable

  constructor(input: Readable = process.stdin, output: Writable = process.stdout) {
    this.#input = input
    this.#output = output
  }

  async start(runtime: AgentRuntime): Promise<() => Promise<void>> {
    const write = (event: StdioEvent) => {
      this.#output.write(JSON.stringify(event) + '\n')
    }
    const roster = () =>
      runtime.roster().map((v) => ({
        participant: v.participant,
        name: v.name,
        agent: v.agent === true,
        tracks: v.tracks.map((t) => t.role),
      }))

    write({
      type: 'ready',
      participant: runtime.agent.participant,
      device: runtime.agent.device,
      room: runtime.agent.roomId,
      url: runtime.agent.url,
      hosting: runtime.agent.hosting,
    })
    const off = runtime.on((event) => write(toStdioEvent(event)))

    const lines = createInterface({ input: this.#input, crlfDelay: Infinity })
    lines.on('line', (line) => {
      if (line.trim() === '') return
      let command: StdioCommand
      try {
        command = JSON.parse(line) as StdioCommand
      } catch {
        write({ type: 'error', message: 'not JSON' })
        return
      }
      void this.#run(runtime, command, write, roster)
    })
    return async () => {
      off()
      lines.close()
    }
  }

  async #run(
    runtime: AgentRuntime,
    command: StdioCommand,
    write: (event: StdioEvent) => void,
    roster: () => Extract<StdioEvent, { type: 'roster' }>['participants'],
  ): Promise<void> {
    try {
      switch (command.op) {
        case 'say':
          await runtime.say(String(command.text))
          write({ type: 'ok', op: 'say' })
          return
        case 'whisper':
          await runtime.whisper(String(command.text))
          write({ type: 'ok', op: 'whisper' })
          return
        case 'roster':
          write({ type: 'roster', participants: roster() })
          return
        case 'history':
          for (const message of runtime.history(command.channel ?? 'chat', command.limit ?? 50)) {
            write(toStdioEvent({ type: command.channel ?? 'chat', message, at: 0 }))
          }
          write({ type: 'ok', op: 'history' })
          return
        case 'approval-request': {
          const id = typeof command.id === 'string' ? command.id : undefined
          const options = Array.isArray(command.options) ? command.options.map(String) : undefined
          // Not awaited: the verdict is an event, so the pipe stays free.
          let pending: Promise<unknown> = Promise.resolve()
          const opened = new Promise<string>((resolve, reject) => {
            pending = runtime.agent
              .requestApproval({ text: String(command.text), options, ttlSeconds: command.ttlSeconds, id })
              .then(() => undefined, reject)
            // The id is known synchronously when the caller gave one; when
            // random, the request event carries it and so does the outcome.
            resolve(id ?? '')
          })
          void pending.catch(() => {})
          const chosen = await opened
          write({ type: 'ok', op: 'approval-request', ...(chosen ? { id: chosen } : {}) })
          return
        }
        case 'leave':
          await runtime.close()
          write({ type: 'ok', op: 'leave' })
          return
        default:
          write({ type: 'error', message: `unknown op ${String((command as { op?: unknown }).op)}` })
      }
    } catch (err) {
      write({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }
}

export function toStdioEvent(event: RuntimeEvent): StdioEvent {
  if (event.type === 'approval') {
    return {
      type: 'approval',
      id: event.id,
      verdict: event.verdict,
      ...(event.by !== undefined ? { by: event.by } : {}),
      ...(event.note !== undefined ? { note: event.note } : {}),
      expired: event.expired,
    }
  }
  if (event.type === 'roster') {
    return {
      type: 'roster',
      participants: event.participants.map((v) => ({
        participant: v.participant,
        name: v.name,
        agent: v.agent === true,
        tracks: v.tracks.map((t) => t.role),
      })),
    }
  }
  if (event.type === 'presence') {
    return {
      type: 'presence',
      op: event.op,
      ...(event.host !== undefined ? { host: event.host } : {}),
      ...(event.agent !== undefined ? { agent: event.agent } : {}),
      by: event.by,
    }
  }
  const m = event.message
  return {
    type: event.type,
    id: m.id,
    from: m.participant,
    ...(m.name !== undefined ? { name: m.name } : {}),
    text: m.text,
    sentAt: m.sentAt,
    ...(m.kind ? { kind: m.kind } : {}),
    ...(m.speaker ? { speaker: m.speaker } : {}),
    // Passed through whole, key included: an agent is a member, and a
    // member holds what the room holds. Whether it fetches is its own call,
    // exactly as it is a person's.
    ...(m.attachments ? { attachments: m.attachments } : {}),
  }
}

// ---------------------------------------------------------------------------
// A model in the loop
// ---------------------------------------------------------------------------

export interface ModelBrainOptions {
  /** `mentions`: speak when named in the chat or the transcript, or when
   *  another agent speaks on the backchannel. `always`: answer every human
   *  message. Mentions by default, because an agent that answers
   *  everything is an agent people leave. */
  respond?: 'mentions' | 'always'
  /** How long to wait after a trigger for the burst to finish, so a
   *  sentence typed in three messages gets one answer. */
  debounceMs?: number
  /** The fewest milliseconds between two turns of this agent. */
  minGapMs?: number
  /** How many turns agents may take among themselves before a person has
   *  to say something. What stops two agents agreeing with each other for
   *  ever. */
  maxAgentTurns?: number
  log?: (line: string) => void
}

/** How a model is told to behave in the room. Appended to the persona. */
export const ROOM_PROTOCOL = `
You are a participant in a small private room with people and other agents. You see the roster, the chat, what the agents say among themselves on their own channel, and a transcript of what people said aloud when they allowed agents to listen. Names are self-asserted; the short key beside each is what identifies somebody.

Reply with exactly what you want to say to the room, in plain text, briefly, in the voice of your character. Do not narrate, do not prefix your name.
- To say something only to the other agents, start the line with /whisper. The people can read it; it is for co-ordination, not secrecy.
- To say nothing, reply with the single word /quiet.
- You may combine one /whisper line and one spoken reply.
`.trim()

/**
 * Turn-taking for a model: watch the room, decide when it is worth a turn,
 * build a prompt, say what comes back. Subclasses supply `complete`.
 */
export abstract class ModelBrain implements Brain {
  readonly #opts: Required<Omit<ModelBrainOptions, 'log'>> & { log: (line: string) => void }
  #pending: RuntimeEvent[] = []
  #timer?: ReturnType<typeof setTimeout>
  #lastTurn = 0
  #agentTurns = 0
  #busy = false
  #runtime?: AgentRuntime

  constructor(opts: ModelBrainOptions = {}) {
    this.#opts = {
      respond: opts.respond ?? 'mentions',
      debounceMs: opts.debounceMs ?? 1_500,
      minGapMs: opts.minGapMs ?? 4_000,
      maxAgentTurns: opts.maxAgentTurns ?? 6,
      log: opts.log ?? (() => {}),
    }
  }

  /** Ask the model. `system` is the character and the protocol; `user` is
   *  the room and what is new. Returns the model's reply as text. */
  protected abstract complete(system: string, user: string): Promise<string>

  /** This brain's model with the turn-taking left off. See `Completer`. */
  completer(): Completer {
    return { complete: (system, user) => this.complete(system, user) }
  }

  async start(runtime: AgentRuntime): Promise<() => Promise<void>> {
    this.#runtime = runtime
    const off = runtime.on((event) => this.#onEvent(runtime, event))
    return async () => {
      off()
      if (this.#timer) clearTimeout(this.#timer)
      this.#timer = undefined
      this.#runtime = undefined
    }
  }

  #onEvent(runtime: AgentRuntime, event: RuntimeEvent): void {
    if (event.type === 'roster' || event.type === 'approval' || event.type === 'presence') return
    const m = event.message
    if (m.participant === runtime.agent.participant) return
    const fromAgent = runtime.roster().find((v) => v.participant === m.participant)?.agent === true
    // A person spoke: agents may talk among themselves again.
    if (!fromAgent && event.type !== 'backchannel') this.#agentTurns = 0

    if (!this.#wants(runtime, event, fromAgent)) return
    this.#pending.push(event)
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.#turn(runtime)
    }, this.#opts.debounceMs)
  }

  #wants(runtime: AgentRuntime, event: RuntimeEvent, fromAgent: boolean): boolean {
    if (event.type === 'roster' || event.type === 'approval' || event.type === 'presence') return false
    const text = event.message.text.toLowerCase()
    const named = namesAgent(text, runtime.persona.name)
    if (event.type === 'backchannel') {
      // Another agent, among agents: answer if named, or if there is still
      // room in the budget for a conversation nobody is steering.
      return named || this.#agentTurns < this.#opts.maxAgentTurns
    }
    if (this.#opts.respond === 'always' && !fromAgent) return true
    return named
  }

  async #turn(runtime: AgentRuntime): Promise<void> {
    if (this.#busy || this.#runtime !== runtime) return
    const since = Date.now() - this.#lastTurn
    if (since < this.#opts.minGapMs) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined
        void this.#turn(runtime)
      }, this.#opts.minGapMs - since)
      return
    }
    const news = this.#pending
    this.#pending = []
    if (news.length === 0) return
    this.#busy = true
    try {
      const onlyAgents = news.every((e) => e.type === 'backchannel')
      if (onlyAgents) this.#agentTurns++
      const system = [runtime.persona.system.trim(), ROOM_PROTOCOL].filter(Boolean).join('\n\n')
      const user = [
        runtime.describe(),
        '',
        'New since your last turn:',
        ...news.map((e) =>
          e.type === 'roster' || e.type === 'approval' || e.type === 'presence' ? '' : `[${e.type}] ${runtime.line(e.message)}`,
        ),
      ].join('\n')
      this.#opts.log(`turn: ${news.length} new`)
      const reply = await this.complete(system, user)
      this.#lastTurn = Date.now()
      await this.#deliver(runtime, reply)
    } catch (err) {
      this.#opts.log(`turn failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.#busy = false
      if (this.#pending.length > 0 && !this.#timer) {
        this.#timer = setTimeout(() => {
          this.#timer = undefined
          void this.#turn(runtime)
        }, this.#opts.debounceMs)
      }
    }
  }

  async #deliver(runtime: AgentRuntime, reply: string): Promise<void> {
    const { say, whisper } = parseReply(reply)
    if (whisper) await runtime.whisper(whisper)
    if (say) await runtime.say(say)
  }
}

/** Split a model's reply into what is said aloud and what is whispered. */
export function parseReply(reply: string): { say?: string; whisper?: string } {
  const say: string[] = []
  const whisper: string[] = []
  for (const raw of reply.split('\n')) {
    const line = raw.trim()
    if (line === '' || line === '/quiet') continue
    if (line.startsWith('/whisper')) {
      whisper.push(line.slice('/whisper'.length).trim())
      continue
    }
    say.push(line)
  }
  const out: { say?: string; whisper?: string } = {}
  const spoken = say.join('\n').trim()
  const whispered = whisper.join('\n').trim()
  if (spoken) out.say = spoken.slice(0, 2_000)
  if (whispered) out.whisper = whispered.slice(0, 2_000)
  return out
}

export interface OllamaBrainOptions extends ModelBrainOptions {
  /** A model Ollama has pulled. */
  model: string
  url?: string
  /**
   * Whether a model that can reason before answering should. Off by
   * default: measured here, qwen3:8b took 57 seconds over a one-sentence
   * answer with thinking on, and a room does not wait a minute for a
   * reply. The persona is the reasoning; a turn is a sentence.
   */
  think?: boolean
  fetch?: typeof fetch
}

/** A local model through Ollama's chat endpoint. Nothing leaves the machine. */
export class OllamaBrain extends ModelBrain {
  readonly #model: string
  readonly #url: string
  readonly #think: boolean
  readonly #fetch: typeof fetch

  constructor(opts: OllamaBrainOptions) {
    super(opts)
    this.#model = opts.model
    this.#url = (opts.url ?? 'http://127.0.0.1:11434').replace(/\/$/, '')
    this.#think = opts.think ?? false
    this.#fetch = opts.fetch ?? fetch
  }

  protected async complete(system: string, user: string): Promise<string> {
    const res = await this.#fetch(`${this.#url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.#model,
        stream: false,
        think: this.#think,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    })
    if (!res.ok) throw new Error(`ollama answered ${res.status}`)
    const body = (await res.json()) as { message?: { content?: unknown } }
    const content = body.message?.content
    if (typeof content !== 'string') throw new Error('ollama answered without content')
    return content
  }
}

export interface AnthropicBrainOptions extends ModelBrainOptions {
  model?: string
  maxTokens?: number
}

/**
 * Claude, through the official SDK. The key comes from the environment the
 * SDK reads (`ANTHROPIC_API_KEY`, or an `ant auth login` profile); nothing
 * here holds one. Loaded on demand, so an agent driven by anything else
 * never loads the SDK.
 */
export class AnthropicBrain extends ModelBrain {
  readonly #model: string
  readonly #maxTokens: number
  #client?: Anthropic

  constructor(opts: AnthropicBrainOptions = {}) {
    super(opts)
    this.#model = opts.model ?? 'claude-opus-5'
    this.#maxTokens = opts.maxTokens ?? 2_000
  }

  protected async complete(system: string, user: string): Promise<string> {
    if (!this.#client) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk')
      this.#client = new Anthropic()
    }
    const response = await this.#client.messages.create({
      model: this.#model,
      max_tokens: this.#maxTokens,
      // The character and the protocol never change between turns, so they
      // are the cacheable prefix; the room is what moves.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    })
    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
  }
}
