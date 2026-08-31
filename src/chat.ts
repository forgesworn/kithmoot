import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { randomBytes } from '@noble/hashes/utils'
import { KINDS } from './kinds.js'
import { verifyEventUncached } from './verify.js'
import { verifyDeviceCredential } from './credential.js'
import { hexEquals, normaliseHex } from './hex.js'
import { sanitiseDisplayName } from './display-name.js'
import { evaluateAccess } from './access.js'
import type { RelayTransport } from './relay-pool.js'
import type { DeviceCredential, KindredProof, RoomPolicy } from './types.js'

export const MAX_CHAT_TEXT_LENGTH = 2_000
export const CHAT_RETENTION_SECONDS = 30 * 24 * 60 * 60
export const MAX_CHAT_MESSAGES = 500
export const MAX_CHAT_MESSAGES_PER_MINUTE = 30

export interface ChatMessage {
  id: string
  participant: string
  device: string
  /** Proof that `device` speaks for `participant` in this room. Carried with
   *  the message rather than looked up in the roster, because chat is
   *  durable: a late joiner reads history from senders who have long since
   *  left the room and are in nobody's roster any more. */
  credential: DeviceCredential
  /** Required in a gated room for the same reason it is carried on a roster
   * entry: durable chat must remain independently admissible after the live
   * presence entry has disappeared. */
  proof?: KindredProof
  /**
   * What the sender calls themselves, sanitised - see `RosterEntry.name`
   * for what that is and is not worth.
   *
   * Carried on the message rather than read off the roster for the same
   * reason the credential is: chat is durable and the roster is ephemeral,
   * so a message read out of history was sent by somebody who may be in
   * nobody's roster now.
   */
  name?: string
  text: string
  sentAt: number
}

export interface EncodeChatOptions {
  roomId: string
  roomKey: Uint8Array
  deviceSk: Uint8Array
}

/**
 * Encode a chat message as an event encrypted to the room key.
 *
 * This rides the same channel as the roster - the room key - so chat works
 * before any media connection exists, survives reconnects, and gives late
 * joiners history, because unlike the signalling wrap it is published under
 * a DURABLE kind (see `KINDS.CHAT`).
 */
export function encodeChatEvent(msg: ChatMessage, opts: EncodeChatOptions): Event {
  // Sanitised on the way out as well as on the way in - see
  // `encodeRosterEvent` for why both. `name: undefined` is dropped by
  // JSON.stringify, so a message with no name is byte-identical to one
  // encoded before names existed.
  const plaintext = JSON.stringify({ ...msg, name: sanitiseDisplayName(msg.name) })
  const content = nip44.v2.encrypt(plaintext, opts.roomKey)
  return finalizeEvent(
    {
      kind: KINDS.CHAT,
      created_at: msg.sentAt,
      tags: [['d', opts.roomId]],
      content,
    },
    opts.deviceSk,
  )
}

export interface DecodeChatOptions {
  roomId: string
  roomKey: Uint8Array
  /** Unix seconds. Bounds how far into the future a message may claim to
   *  have been sent - see `MAX_CLOCK_SKEW_SECONDS`. */
  now: number
  policy?: RoomPolicy
}

/**
 * How far ahead of our own clock a message may claim to have been sent.
 *
 * The credential is checked as at `sentAt` rather than as at now, because a
 * message read out of history was sent under a credential that has since
 * expired - checking it against the reader's clock would make all history
 * unverifiable after twelve hours. The sender gains nothing by choosing
 * `sentAt`: it still has to fall inside a window during which they genuinely
 * held a credential for the participant they name. This bound is what stops
 * that window being pushed forward indefinitely.
 */
const MAX_CLOCK_SKEW_SECONDS = 300

/**
 * Decode and verify a chat event. Returns null for anything that does not
 * check out - wrong key, wrong room, bad signature, a device that did not
 * sign the message it claims to be from, or a malformed payload. Never
 * throws, because this runs inside a relay subscription handler where a
 * throw would take down the whole room.
 */
export function decodeChatEvent(event: Event, opts: DecodeChatOptions): ChatMessage | null {
  try {
    if (event.kind !== KINDS.CHAT) return null
    const roomTag = event.tags.find((t) => t[0] === 'd')?.[1]
    if (roomTag === undefined || !hexEquals(roomTag, opts.roomId)) return null
    if (!verifyEventUncached(event)) return null

    const msg = JSON.parse(nip44.v2.decrypt(event.content, opts.roomKey)) as ChatMessage

    if (
      typeof msg.id !== 'string' ||
      typeof msg.participant !== 'string' ||
      typeof msg.device !== 'string' ||
      typeof msg.text !== 'string' ||
      typeof msg.sentAt !== 'number' ||
      typeof msg.credential !== 'object' ||
      msg.credential === null
    ) {
      return null
    }
    if (msg.id.length === 0 || msg.id.length > 128) return null
    if (msg.text.length === 0 || msg.text.length > MAX_CHAT_TEXT_LENGTH) return null
    if (!Number.isSafeInteger(msg.sentAt)) return null

    // This is a boundary: `device`/`participant` are free-text JSON fields
    // with nothing forcing lower case. Canonicalise them here, once, same as
    // `decodeRosterEvent` - see `hex.ts`'s `normaliseHex`.
    msg.device = normaliseHex(msg.device)
    msg.participant = normaliseHex(msg.participant)

    // Attacker-controlled text off a relay, exactly as in the roster.
    const name = sanitiseDisplayName(msg.name)
    if (name === undefined) delete msg.name
    else msg.name = name

    // The device that signed this event must be the device the message
    // claims to be from - the same attribution guard the roster uses.
    if (!hexEquals(msg.device, event.pubkey)) return null
    if (msg.sentAt > opts.now + MAX_CLOCK_SKEW_SECONDS) return null

    // And the credential must bind that device to the participant the
    // message names. Without this, `participant` is a free-text field: any
    // member can sign a message with their own key, name the victim, and
    // have it render on the victim's own screen labelled "you".
    const verdict = verifyDeviceCredential(msg.credential, {
      roomId: opts.roomId,
      now: msg.sentAt,
    })
    if (!verdict.ok) return null
    if (!hexEquals(verdict.device, event.pubkey)) return null
    if (!hexEquals(verdict.participant, msg.participant)) return null

    if (opts.policy) {
      const access = evaluateAccess(opts.policy, msg.participant, msg.proof, msg.sentAt, opts.roomId)
      if (!access.admitted) return null
    }

    return msg
  } catch {
    return null
  }
}

export interface ChatLogOptions {
  transport: RelayTransport
  roomId: string
  roomKey: Uint8Array
  /** This device's credential. The participant is read off it rather than
   *  passed alongside, so the two can never disagree. */
  credential: DeviceCredential
  deviceSk: Uint8Array
  /** What to call this sender on every message. Sanitised here, so a
   *  caller can pass a form field straight in. */
  name?: string
  policy?: RoomPolicy
  proof?: KindredProof
  /** Injectable clock, in unix seconds. Defaults to the real one. */
  now?: () => number
}

/**
 * The chat history for one room, kept in step with events arriving over the
 * transport and appended to by `send()`.
 */
export class ChatLog {
  readonly #opts: ChatLogOptions
  readonly #now: () => number
  #messages: ChatMessage[] = []
  readonly #seen = new Set<string>()
  readonly #senderTimes = new Map<string, number[]>()
  readonly #listeners = new Set<(messages: ChatMessage[]) => void>()
  readonly #unsub: () => void

  constructor(opts: ChatLogOptions) {
    this.#opts = opts
    this.#now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.#unsub = opts.transport.subscribe(
      [{ kinds: [KINDS.CHAT], '#d': [opts.roomId], since: this.#now() - CHAT_RETENTION_SECONDS }],
      (event) => this.#ingest(event),
    )
  }

  async send(text: string): Promise<void> {
    if (text.length === 0) throw new Error('chat message is empty')
    if (text.length > MAX_CHAT_TEXT_LENGTH) {
      throw new Error(`chat message exceeds ${MAX_CHAT_TEXT_LENGTH} characters`)
    }
    const name = sanitiseDisplayName(this.#opts.name)
    const msg: ChatMessage = {
      id: hex(randomBytes(16)),
      participant: this.#opts.credential.pubkey,
      device: getPublicKey(this.#opts.deviceSk),
      credential: this.#opts.credential,
      ...(this.#opts.proof ? { proof: this.#opts.proof } : {}),
      ...(name !== undefined ? { name } : {}),
      text,
      sentAt: this.#now(),
    }
    const event = encodeChatEvent(msg, {
      roomId: this.#opts.roomId,
      roomKey: this.#opts.roomKey,
      deviceSk: this.#opts.deviceSk,
    })
    await this.#opts.transport.publish(event)
  }

  messages(): ChatMessage[] {
    return [...this.#messages]
  }

  onChange(cb: (messages: ChatMessage[]) => void): () => void {
    this.#listeners.add(cb)
    return () => this.#listeners.delete(cb)
  }

  close(): void {
    this.#unsub()
    this.#listeners.clear()
  }

  #ingest(event: Event): void {
    const msg = decodeChatEvent(event, {
      roomId: this.#opts.roomId,
      roomKey: this.#opts.roomKey,
      now: this.#now(),
      policy: this.#opts.policy,
    })
    if (!msg) return
    if (msg.sentAt < this.#now() - CHAT_RETENTION_SECONDS) return
    if (this.#seen.has(msg.id)) return

    const senderTimes = (this.#senderTimes.get(msg.device) ?? [])
      .filter((sentAt) => sentAt >= this.#now() - CHAT_RETENTION_SECONDS)
    if (senderTimes.filter((sentAt) => Math.abs(sentAt - msg.sentAt) < 60).length >= MAX_CHAT_MESSAGES_PER_MINUTE) {
      return
    }
    senderTimes.push(msg.sentAt)
    this.#senderTimes.set(msg.device, senderTimes)
    while (this.#senderTimes.size > MAX_CHAT_MESSAGES) {
      const oldest = this.#senderTimes.keys().next().value
      if (oldest === undefined) break
      this.#senderTimes.delete(oldest)
    }
    this.#seen.add(msg.id)

    this.#messages.push(msg)
    this.#messages.sort(compareMessages)
    while (this.#messages.length > MAX_CHAT_MESSAGES) {
      const removed = this.#messages.shift()
      if (removed) this.#seen.delete(removed.id)
    }

    const snapshot = this.messages()
    // Guarded: decodeChatEvent is written never to throw precisely because
    // this runs inside a relay subscription handler, and a throwing caller
    // callback would undo all of that.
    for (const listener of this.#listeners) {
      try {
        listener(snapshot)
      } catch {
        // A caller's render() is not allowed to close the room.
      }
    }
  }
}

/** Order by send time; a tie breaks on id, so every client in the room
 *  reaches the same order without negotiating one. */
function compareMessages(a: ChatMessage, b: ChatMessage): number {
  if (a.sentAt !== b.sentAt) return a.sentAt - b.sentAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
