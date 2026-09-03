import { wrapEvent } from 'nostr-tools/nip17'
import type { RoomAgent } from '../agent.js'
import type { ChatMessage } from '../chat.js'
import { CONTROL_CHANNEL, decodeControl } from '../control.js'
import type { RelayTransport } from '../relay-pool.js'

/**
 * The keeper tells an absent member there is something to read.
 *
 * A standing room nobody is told about is a room nobody reads, and there
 * is no server to push from. The one party that is always in the room is
 * its keeper, and the one address every Nostr identity already has is a
 * DM. So a member who signed in with a Nostr key can ask the keeper, on
 * the control channel, to nudge them: when a message lands in the main
 * chat while they are not in the roster, the keeper sends them one NIP-17
 * gift-wrapped DM from its own identity, over the room's relays, saying
 * there are new messages in the room, with the link.
 *
 * Bounded twice over, because a nudge that keeps coming is a nudge that
 * gets muted: at most one per member per hour, and not again until the
 * member has been in the room since the last one. Opting in is the
 * member's own signed message and is undone by the same; the keeper keeps
 * the list of who asked in its state, so a restart does not forget them.
 *
 * What a relay learns from this: that the keeper's key sent a gift wrap
 * addressed to that member's key, and when. Not the room, not the text,
 * not who else was nudged. A gift wrap is what hides the rest - the seal
 * inside names the room only in ciphertext to the member.
 */

/** At most one nudge per member in this many seconds. */
export const NUDGE_COOLDOWN_SECONDS = 60 * 60

/** Messages older than this at start are history, not a reason to nudge. */
const HISTORY_GRACE_SECONDS = 10

/** Where the keeper keeps who asked. In a state file for a real keeper;
 *  in memory for a test, and for a keeper started without `--state`. */
export interface NudgeStore {
  load(): Promise<string[]>
  save(pubkeys: string[]): Promise<void>
}

/** Sends one direct message to one participant. The real one wraps and
 *  publishes; a test records. */
export type NudgeSender = (participant: string, text: string) => Promise<void>

export interface NudgerOptions {
  agent: RoomAgent
  send: NudgeSender
  store: NudgeStore
  /** What the room is called in the message. Off the link when unset. */
  roomName?: string
  /** Unix seconds. */
  now?: () => number
  cooldownSeconds?: number
  log?: (line: string) => void
}

/** What the DM says. The room by name, and the way in. */
export function nudgeText(room: string, link: string): string {
  return `There are new messages in ${room}. Open the room: ${link}`
}

export function memoryNudgeStore(initial: string[] = []): NudgeStore {
  let list = [...initial]
  return {
    load: async () => [...list],
    save: async (pubkeys) => {
      list = [...pubkeys]
    },
  }
}

/**
 * The real sender: a NIP-17 DM from `sk` to the participant, published on
 * the transport. Kind 14 inside a seal inside a gift wrap, as nostr-tools
 * builds it, with the wrap's own throwaway key and a backdated stamp.
 */
export function nip17Sender(sk: Uint8Array, transport: RelayTransport): NudgeSender {
  return async (participant, text) => {
    await transport.publish(wrapEvent(sk, { publicKey: participant }, text))
  }
}

export class Nudger {
  readonly #agent: RoomAgent
  readonly #send: NudgeSender
  readonly #store: NudgeStore
  readonly #roomName?: string
  readonly #now: () => number
  readonly #cooldown: number
  readonly #log: (line: string) => void
  readonly #optedIn = new Set<string>()
  /** The `sentAt` of the newest opt in or out seen per member, so a replay
   *  delivered out of order cannot undo a later choice. */
  readonly #optedAt = new Map<string, number>()
  /** When each member was last nudged. */
  readonly #nudgedAt = new Map<string, number>()
  /** Members seen in the room since they were last nudged. */
  readonly #presentSince = new Set<string>()
  readonly #seen = new Set<string>()
  #startedAt = 0
  #unsubs: (() => void)[] = []
  #closed = false

  constructor(opts: NudgerOptions) {
    this.#agent = opts.agent
    this.#send = opts.send
    this.#store = opts.store
    this.#roomName = opts.roomName
    this.#now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.#cooldown = opts.cooldownSeconds ?? NUDGE_COOLDOWN_SECONDS
    this.#log = opts.log ?? (() => {})
  }

  /** Who has asked, as of now. */
  optedIn(): string[] {
    return [...this.#optedIn].sort()
  }

  async start(): Promise<void> {
    this.#startedAt = this.#now()
    for (const pubkey of await this.#store.load()) this.#optedIn.add(pubkey)
    // Everybody here now has been present since any nudge that went out
    // before this process started.
    this.#markPresent(this.#agent.roster().map((v) => v.participant))
    this.#unsubs.push(this.#agent.onRoster((views) => this.#markPresent(views.map((v) => v.participant))))

    const control = this.#agent.channel(CONTROL_CHANNEL)
    const ingestControl = (messages: ChatMessage[]) => {
      void this.#ingestControl(messages)
    }
    // History counts here: a member who asked while the keeper was down
    // still asked, and the newest choice per member wins whatever order a
    // relay delivers them in.
    ingestControl(control.messages())
    this.#unsubs.push(control.onChange(ingestControl))

    const chat = this.#agent.chat
    const ingestChat = (messages: ChatMessage[]) => {
      void this.#ingestChat(messages)
    }
    ingestChat(chat.messages())
    this.#unsubs.push(chat.onChange(ingestChat))
  }

  #markPresent(participants: string[]): void {
    for (const p of participants) this.#presentSince.add(p)
  }

  async #ingestControl(messages: ChatMessage[]): Promise<void> {
    if (this.#closed) return
    let changed = false
    for (const m of messages) {
      if (this.#seen.has(m.id)) continue
      this.#seen.add(m.id)
      const control = decodeControl(m.text)
      if (!control || control.op !== 'nudge') continue
      const previous = this.#optedAt.get(m.participant)
      if (previous !== undefined && previous > m.sentAt) continue
      this.#optedAt.set(m.participant, m.sentAt)
      const was = this.#optedIn.has(m.participant)
      if (control.on) this.#optedIn.add(m.participant)
      else this.#optedIn.delete(m.participant)
      if (was !== control.on) {
        changed = true
        this.#log(`nudge ${control.on ? 'on' : 'off'} for ${m.participant.slice(0, 8)}`)
      }
    }
    if (changed) {
      try {
        await this.#store.save(this.optedIn())
      } catch (err) {
        this.#log(`could not save who asked to be nudged: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  async #ingestChat(messages: ChatMessage[]): Promise<void> {
    if (this.#closed) return
    const now = this.#now()
    const present = new Set(this.#agent.roster().map((v) => v.participant))
    this.#markPresent([...present])
    for (const m of messages) {
      if (this.#seen.has(m.id)) continue
      this.#seen.add(m.id)
      if (m.sentAt < this.#startedAt - HISTORY_GRACE_SECONDS) continue
      if (m.participant === this.#agent.participant) continue
      for (const member of this.#optedIn) {
        if (member === m.participant || present.has(member)) continue
        if (!this.#due(member, now)) continue
        this.#nudgedAt.set(member, now)
        this.#presentSince.delete(member)
        try {
          await this.#send(member, nudgeText(this.#roomLabel(), this.#agent.url))
          this.#log(`nudged ${member.slice(0, 8)}`)
        } catch (err) {
          this.#log(`could not nudge ${member.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  }

  /** Never nudged, or nudged long enough ago and here in between. */
  #due(member: string, now: number): boolean {
    const last = this.#nudgedAt.get(member)
    if (last === undefined) return true
    return now - last >= this.#cooldown && this.#presentSince.has(member)
  }

  #roomLabel(): string {
    return this.#roomName ?? this.#agent.link.name ?? `Room ${this.#agent.roomId.slice(0, 8)}`
  }

  stop(): void {
    this.#closed = true
    for (const unsub of this.#unsubs) unsub()
    this.#unsubs = []
  }
}
