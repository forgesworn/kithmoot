/**
 * A room watched from outside it, for the rooms list: what is new in its
 * chat, and who is in it now.
 *
 * Read-only, in the strict sense. Nothing here publishes: no roster entry,
 * no announcement, no answer to anybody else's. A device looking at its
 * list is not in the room, and must not appear to be - a phantom in every
 * standing room's roster, opening peer connections nobody wanted, is the
 * thing this exists not to be. What it costs is that the room cannot answer
 * an arrival it never hears about, so presence here is only what devices
 * say of their own accord: their heartbeats, every twenty seconds. A room
 * fills in over one heartbeat interval rather than at once, and `settled`
 * says when that interval has passed, so a list can tell "nobody heard from
 * yet" apart from "nobody here".
 *
 * The chat is the library's own `ChatLog`, opened without a credential, so
 * what counts as a message is decided in exactly one place. The roster is
 * decoded by the library too, and kept by the same rules `RoomSession` keeps
 * it: an entry stamped before the presence window is a replay and is
 * refused, a farewell removes a device at once and a late entry from before
 * it cannot bring it back, and a device not heard from inside the window has
 * gone. Those rules live in `PresenceLedger`, pure so they can be tested with
 * no relay.
 */
import type { Event } from 'nostr-tools/pure'
import { KINDS } from '../../src/kinds.js'
import { decodeRosterEvent } from '../../src/roster.js'
import { evaluateAccess } from '../../src/access.js'
import { ChatLog, type ChatMessage } from '../../src/chat.js'
import { HEARTBEAT_INTERVAL_MS, PRESENCE_TTL_SECONDS } from '../../src/session.js'
import type { RelayTransport } from '../../src/relay-pool.js'
import type { RoomPolicy, RosterEntry } from '../../src/types.js'

/** One person in a watched room, however many devices they brought. */
export interface PresentParticipant {
  participant: string
  /** Self-asserted, like everywhere else. See `RosterEntry.name`. */
  name?: string
  devices: number
  /** True when any of their devices says it is an agent. */
  agent: boolean
}

/**
 * The roster of a room this device is not in, kept by the rules the session
 * keeps its own: see the file comment. Fed decoded entries; hands back
 * people.
 */
export class PresenceLedger {
  readonly #ttl: number
  readonly #entries = new Map<string, RosterEntry>()
  /** When each device was last heard from, by our clock - never theirs. */
  readonly #seenAt = new Map<string, number>()
  /** Devices that said goodbye, and when, so a slower relay delivering
   *  something they said earlier cannot put them back. */
  readonly #departed = new Map<string, number>()

  constructor(presenceTtlSeconds = PRESENCE_TTL_SECONDS) {
    this.#ttl = presenceTtlSeconds
  }

  /** Take one entry in. True when who is present may have changed. */
  ingest(entry: RosterEntry, now: number): boolean {
    const existing = this.#entries.get(entry.device)
    if (existing && existing.updatedAt > entry.updatedAt) return false
    // Stamped before the window opened: a replay of a heartbeat from a
    // device that died without a goodbye, however recently the relay
    // delivered it. Refused, as the session refuses it.
    if (entry.updatedAt < now - this.#ttl) return false

    if (entry.left) {
      this.#departed.set(entry.device, entry.updatedAt)
      if (!existing) return false
      this.#entries.delete(entry.device)
      this.#seenAt.delete(entry.device)
      return true
    }

    const leftAt = this.#departed.get(entry.device)
    if (leftAt !== undefined) {
      if (entry.updatedAt <= leftAt) return false
      this.#departed.delete(entry.device)
    }

    this.#entries.set(entry.device, entry)
    this.#seenAt.set(entry.device, now)
    return true
  }

  /** Everyone heard from inside the window, grouped by person. Sweeps on
   *  the way, so a caller never sees a device that has lapsed. */
  present(now: number): PresentParticipant[] {
    const cutoff = now - this.#ttl
    for (const [device, seenAt] of this.#seenAt) {
      if (seenAt >= cutoff) continue
      this.#seenAt.delete(device)
      this.#entries.delete(device)
    }
    for (const [device, leftAt] of this.#departed) {
      if (leftAt < cutoff) this.#departed.delete(device)
    }

    const byParticipant = new Map<string, PresentParticipant>()
    const nameStamp = new Map<string, number>()
    for (const entry of this.#entries.values()) {
      let view = byParticipant.get(entry.participant)
      if (!view) {
        view = { participant: entry.participant, devices: 0, agent: false }
        byParticipant.set(entry.participant, view)
      }
      // The most recently restated name wins, as it does in the session,
      // so every device settles on the same answer.
      if (entry.name !== undefined && (view.name === undefined || entry.updatedAt >= (nameStamp.get(entry.participant) ?? 0))) {
        view.name = entry.name
        nameStamp.set(entry.participant, entry.updatedAt)
      }
      view.devices++
      if (entry.agent === true) view.agent = true
    }
    return [...byParticipant.values()]
  }
}

export interface RoomWatchOptions {
  transport: RelayTransport
  roomId: string
  roomKey: Uint8Array
  /** The room's admission rule, off its link. Enforced on the roster here
   *  exactly as the session enforces it, and on the chat by the log. */
  policy?: RoomPolicy
  /** Injectable clock, in unix seconds. */
  now?: () => number
  /** Something changed: a message arrived, or somebody came or went. */
  onChange?: () => void
}

export class RoomWatch {
  readonly #opts: RoomWatchOptions
  readonly #now: () => number
  readonly #startedAt: number
  readonly #chat: ChatLog
  readonly #presence = new PresenceLedger()
  readonly #unsubRoster: () => void

  constructor(opts: RoomWatchOptions) {
    this.#opts = opts
    this.#now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.#startedAt = this.#now()
    this.#chat = new ChatLog({
      transport: opts.transport,
      roomId: opts.roomId,
      roomKey: opts.roomKey,
      policy: opts.policy,
      now: this.#now,
    })
    this.#chat.onChange(() => opts.onChange?.())
    this.#unsubRoster = opts.transport.subscribe(
      [{ kinds: [KINDS.ROSTER], '#d': [opts.roomId] }],
      (event) => this.#ingest(event),
    )
  }

  /** The room's chat as decoded here, oldest first. */
  messages(): ChatMessage[] {
    return this.#chat.messages()
  }

  /** How many messages are newer than `readAt`. */
  unread(readAt: number): number {
    let count = 0
    for (const message of this.#chat.messages()) if (message.sentAt > readAt) count++
    return count
  }

  /** Who is here now, as far as this watch has heard. */
  present(): PresentParticipant[] {
    return this.#presence.present(this.#now())
  }

  /** Whether every device in the room has had the chance to be heard: one
   *  heartbeat interval has passed since this watch started. Before that,
   *  an empty `present()` means nothing either way. */
  get settled(): boolean {
    return this.#now() - this.#startedAt >= HEARTBEAT_INTERVAL_MS / 1000 + 5
  }

  close(): void {
    this.#unsubRoster()
    this.#chat.close()
  }

  #ingest(event: Event): void {
    const now = this.#now()
    const entry = decodeRosterEvent(event, { roomId: this.#opts.roomId, roomKey: this.#opts.roomKey, now })
    if (!entry) return
    if (this.#opts.policy) {
      const verdict = evaluateAccess(this.#opts.policy, entry.participant, entry.proof, now, this.#opts.roomId)
      if (!verdict.admitted) return
    }
    if (!this.#presence.ingest(entry, now)) return
    try {
      this.#opts.onChange?.()
    } catch {
      // A caller's render() is not allowed to close the watch.
    }
  }
}
