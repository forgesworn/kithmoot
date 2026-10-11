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
 * The room's name is read the same way, off the control channel, so a rename
 * made while the room is closed here still reaches the list.
 *
 * A watch reads the epoch the room was in when this device was last inside
 * it, and follows the authority's rekeys from there with its own copy of
 * each: see `RoomWatchOptions.epoch` and `RoomWatchOptions.onEpoch`.
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
import { classifyMessage, resolveConversation, type UnreadSplit } from '../../src/messages.js'
import { dmPeer } from '../../src/dm.js'
import { KINDS } from '../../src/kinds.js'
import { decodeRosterEvent } from '../../src/roster.js'
import { evaluateAccess } from '../../src/access.js'
import { ChatLog, type ChatMessage, type EpochRoot, type PastEpoch } from '../../src/chat.js'
import { decodeRekeyEvent, deriveEpoch, peekRekeyEvent, type EpochKeys, type RekeyNotice, type RoomEpoch } from '../../src/epoch.js'
import { CONTROL_CHANNEL } from '../../src/control.js'
import { RoomNameBook, roomNameFromMessage, type RoomNameRecord } from '../../src/room-name.js'
import { RoomLogoBook, roomLogoFromMessage, type RoomLogoRecord } from '../../src/room-logo.js'
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
  /** Previously accepted private metadata, with the epoch it was read under. */
  logo?: { record: RoomLogoRecord; epoch: number }
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
  /** A quiet room: its chat rides the gift-wrap stream, which a watch
   *  does not pull. Reading a quiet room from the list would cost the
   *  whole stream per room in the background; opening the room reads
   *  it. Presence is still watched, since it is in the open. */
  quiet?: boolean
  /** The epoch the room was in when this device was last inside it, and
   *  its keys: omit for epoch 0. Chat, presence and the name are read
   *  under it, and a rekey is followed from it: see `onEpoch`. */
  epoch?: EpochRoot & { epoch: number }
  /** Epochs the room had left by `epoch` that the chat goes on reading, as
   *  a session's log does. */
  pastEpochs?: readonly PastEpoch[]
  /** The room's authority, the root inviter pinned in its link. With
   *  `deviceSk`, the watch follows the authority's rekeys. */
  authority?: string
  /** This device's key for the room: what the authority seals this
   *  device's copy of a rekey to when its credential names no seal key.
   *  Used only to open one; a watch signs nothing. */
  deviceSk?: Uint8Array
  /** The seal key secrets this device's credentials have named in the
   *  room, tried before the device key. Asked at each rekey. */
  sealSks?: () => readonly Uint8Array[]
  /**
   * The watch followed a rekey into the next epoch, with this device's own
   * copy of it: chat, presence and the name are read there from now on,
   * and the epoch it left goes on being read for a while. A rekey with no
   * copy for this device - it was removed, the room was closed, or it was
   * not in the room when the authority rekeyed - is not followed, and the
   * room reads quiet here until it is opened again, as it always has.
   */
  onEpoch?: (moved: WatchedRekey) => void
  /** The authority closed the room: its closing rekey, readable from the
   *  epoch this watch is at, says so (and whether the room self-destructs).
   *  Told once. */
  onClosed?: (notice: RekeyNotice) => void
  /** A verified next rekey could not be opened by this device. Stop views
   * that must not keep presenting an old epoch as current room access. */
  onUnreachable?: () => void
}

/** A rekey a watch followed. */
export interface WatchedRekey {
  /** The epoch the watch moved to, with its secret. */
  epoch: RoomEpoch
  /** The epoch it left. Epoch 0's `id` and `key` are the room's own. */
  left: EpochKeys
  notice: RekeyNotice
}

export class RoomWatch {
  readonly #opts: RoomWatchOptions
  readonly #now: () => number
  readonly #startedAt: number
  readonly #chat?: ChatLog
  readonly #control?: ChatLog
  readonly #names = new RoomNameBook()
  readonly #logos = new RoomLogoBook()
  readonly #namesSeen = new Set<string>()
  readonly #presence = new PresenceLedger()
  /** The roster, and the authority's rekeys when this watch follows them:
   *  one REQ, since rooms on the same relays share a connection and relays
   *  cap the subscriptions one may hold. */
  #unsubRoom: () => void = () => {}
  /** Set while that REQ is being opened: a relay may replay into it before
   *  `subscribe` returns, and a rekey followed then would open the next
   *  one before this one is held. */
  #subscribing = false
  /** Set while rekeys are being followed, so one replayed by the REQ a
   *  follow opens waits its turn and the epochs are reported in order. */
  #draining = false
  /** The epoch read now: `opts.epoch` until a rekey is followed. */
  #epoch: (EpochRoot & { epoch: number }) | undefined
  /** Rekeys heard ahead of this epoch, by epoch, until each can be read. */
  readonly #pendingRekeys = new Map<number, Event>()
  /** When the room left each epoch this watch followed it out of. */
  readonly #rekeyedAt = new Map<number, number>()
  #closed = false
  #closedTold = false

  constructor(opts: RoomWatchOptions) {
    this.#opts = opts
    this.#now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.#startedAt = this.#now()
    this.#epoch = opts.epoch && opts.epoch.epoch > 0 ? opts.epoch : undefined
    if (opts.logo) this.#logos.seed(opts.logo.record, opts.logo.epoch)
    const epoch = this.#epochRoot()
    if (!opts.quiet) {
      const log = (channel?: string) => new ChatLog({
        transport: opts.transport,
        roomId: opts.roomId,
        roomKey: opts.roomKey,
        policy: opts.policy,
        now: this.#now,
        ...(channel ? { channel } : {}),
        ...(epoch ? { epoch } : {}),
        ...(!channel && opts.pastEpochs?.length ? { pastEpochs: opts.pastEpochs } : {}),
      })
      this.#chat = log()
      this.#chat.onChange(() => opts.onChange?.())
      this.#control = log(CONTROL_CHANNEL)
      this.#control.onChange((messages) => this.#readNames(messages))
      this.#readNames(this.#control.messages(), false)
    }
    this.#watchRoom()
  }

  /** (Re)open the room's REQ under the epoch read now: its roster, and the
   *  authority's rekeys when this watch can open its copy of one. Replayed
   *  rekeys at or below this epoch are ignored. */
  #watchRoom(): void {
    const { authority, deviceSk, roomId } = this.#opts
    const follows = authority !== undefined && deviceSk !== undefined
    this.#unsubRoom()
    this.#subscribing = true
    try {
      this.#unsubRoom = this.#opts.transport.subscribe(
        [
          { kinds: [KINDS.ROSTER], '#d': [this.#epoch?.id ?? roomId] },
          ...(follows ? [{ kinds: [KINDS.ROOM_REKEY], '#d': [roomId], authors: [authority] }] : []),
        ],
        (event) => {
          if (event.kind === KINDS.ROOM_REKEY) {
            if (follows) this.#ingestRekey(event)
          } else this.#ingest(event)
        },
      )
    } finally {
      this.#subscribing = false
    }
    this.#drainRekeys()
  }

  /** The key this watch reads the room with. */
  get roomKey(): Uint8Array {
    return this.#opts.roomKey
  }

  /** The room's shared name as this watch has read it, or undefined when
   *  it has read no rename. Undefined for a quiet room. */
  roomName(): RoomNameRecord | undefined {
    return this.#names.current(this.#epoch?.epoch ?? 0, { rekeyedAt: (epoch) => this.#rekeyedAt.get(epoch) })
  }

  roomLogo(): RoomLogoRecord | undefined {
    return this.#logos.current(this.epoch, { rekeyedAt: epoch => this.#rekeyedAt.get(epoch) })
  }

  /** The epoch this watch reads the room in now. */
  get epoch(): number {
    return this.#epoch?.epoch ?? 0
  }

  /** Whether this watch reads the chat at all. False for a quiet room. */
  get readsChat(): boolean {
    return this.#chat !== undefined
  }

  /** The room's chat as decoded here, oldest first. Empty for a quiet room. */
  messages(): ChatMessage[] {
    return this.#chat?.messages() ?? []
  }

  /** How many messages are newer than `readAt` and worth telling `self`
   *  about, split into what a person said and what an agent addressed to
   *  them - see `classifyMessage` in `src/messages.ts`. Zero both for a
   *  quiet room, which says nothing either way. Resolved first, so a
   *  retraction here counts the same as it does everywhere else: the
   *  original it withdraws is never itself unread. Judged against who
   *  this watch has heard is present, plus `self` itself - a watch never
   *  joins the roster, so a name-in-text mention of the viewer would
   *  otherwise go unrecognised - named `selfName` when this device knows
   *  one. A DM read off the link's own policy counts every agent message
   *  from the other side too: there is no room to address instead. */
  unread(readAt: number, self: string, selfName?: string, readIds?: readonly string[]): UnreadSplit {
    const roster = [...this.present(), { participant: self, name: selfName }]
    const direct = dmPeer(this.#opts.policy, self) !== undefined
    const seen = readIds === undefined ? undefined : new Set(readIds)
    let people = 0
    let agents = 0
    for (const message of resolveConversation(this.messages()).byKey.values()) {
      if (message.retracted || (message.original.sentAt < readAt || (message.original.sentAt === readAt && (seen === undefined || seen.has(message.original.id))))) continue
      const cls = classifyMessage(message.original, self, roster, { direct })
      if (cls === 'person') people++
      else if (cls === 'agent') agents++
    }
    return { people, agents }
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
    this.#closed = true
    this.#unsubRoom()
    this.#chat?.close()
    this.#control?.close()
  }

  /** What the codecs are told: nothing in epoch 0, as a session does. */
  #epochRoot(): EpochRoot | undefined {
    const e = this.#epoch
    return e ? { id: e.id, key: e.key } : undefined
  }

  /** A rekey by the authority: kept until the epoch it leaves is this one,
   *  then followed if it holds a copy for this device. */
  #ingestRekey(event: Event): void {
    if (this.#closed) return
    const epoch = peekRekeyEvent(event, { roomId: this.#opts.roomId, authority: this.#opts.authority! })
    if (epoch === null || epoch <= this.epoch || this.#pendingRekeys.has(epoch)) return
    this.#pendingRekeys.set(epoch, event)
    if (!this.#subscribing) this.#drainRekeys()
  }

  #drainRekeys(): void {
    if (this.#draining || this.#closed || !this.#opts.authority || !this.#opts.deviceSk) return
    this.#draining = true
    try {
      this.#drainPending()
    } finally {
      this.#draining = false
    }
  }

  #drainPending(): void {
    for (;;) {
      const left: EpochKeys = this.#epoch ?? { epoch: 0, id: this.#opts.roomId, key: this.#opts.roomKey }
      const next = this.#pendingRekeys.get(left.epoch + 1)
      if (!next) return
      const notice = decodeRekeyEvent(next, {
        roomId: this.#opts.roomId,
        authority: this.#opts.authority!,
        current: left,
        deviceSk: this.#opts.deviceSk!,
        sealSks: this.#opts.sealSks?.(),
      })
      // Removed, closed, or not in the room when it rekeyed: no copy, and
      // the watch stays where it is. Left pending, so a later ingest does
      // not try it again; opening the room is what finds out.
      if (notice?.closed && !this.#closedTold) {
        this.#closedTold = true
        try { this.#opts.onClosed?.(notice) } catch { /* A caller's problem, not the watch's. */ }
      }
      if (!notice?.secret || notice.closed) {
        if (!notice?.closed) { try { this.#opts.onUnreachable?.() } catch { /* Caller owns its view. */ } }
        return
      }
      this.#pendingRekeys.delete(left.epoch + 1)
      this.#follow(left, { epoch: notice.epoch, secret: notice.secret }, notice)
    }
  }

  /** Read the room in `next` from now on, and go on reading `left` for a
   *  while, as a session's logs do. */
  #follow(left: EpochKeys, next: RoomEpoch, notice: RekeyNotice): void {
    const keys = deriveEpoch(next)
    this.#epoch = { epoch: keys.epoch, id: keys.id, key: keys.key }
    this.#rekeyedAt.set(next.epoch, notice.at)
    const root = { id: keys.id, key: keys.key }
    this.#chat?.rekey(root, { leftAt: notice.at })
    this.#control?.rekey(root, { leftAt: notice.at })
    this.#watchRoom()
    try {
      this.#opts.onEpoch?.({ epoch: { epoch: next.epoch, secret: next.secret.slice() }, left, notice })
    } catch {
      // A caller's problem, not the watch's.
    }
    try {
      this.#opts.onChange?.()
    } catch {
      // A caller's render() is not allowed to close the watch.
    }
  }

  /** File the renames among `messages`; say so when one is new, except
   *  from the constructor, before the caller holds the watch. */
  #readNames(messages: ChatMessage[], announce = true): void {
    let added = false
    for (const message of messages) {
      if (this.#namesSeen.has(message.id)) continue
      this.#namesSeen.add(message.id)
      const record = roomNameFromMessage(message)
      if (record && this.#names.add(record, this.epoch)) added = true
      const logo = roomLogoFromMessage(message)
      if (logo && this.#logos.add(logo, this.epoch)) added = true
    }
    if (!added || !announce) return
    try {
      this.#opts.onChange?.()
    } catch {
      // A caller's render() is not allowed to close the watch.
    }
  }

  #ingest(event: Event): void {
    const now = this.#now()
    const epoch = this.#epochRoot()
    const entry = decodeRosterEvent(event, { roomId: this.#opts.roomId, roomKey: this.#opts.roomKey, now, ...(epoch ? { epoch } : {}) })
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
