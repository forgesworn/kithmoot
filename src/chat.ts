import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { randomBytes } from '@noble/hashes/utils'
import { KINDS } from './kinds.js'
import { normaliseReaction, type ChatReaction } from './reactions.js'
import { assignmentPayload, ASSIGNMENT_CHANNEL } from './assignments.js'
import {
  normaliseInvite,
  normaliseMentions,
  normaliseMessageRef,
  validMessageId,
  MAX_MENTIONS,
  type ChatInvite,
  type MessageRef,
} from './messages.js'
import { verifyEventUncached } from './verify.js'
import { verifyDeviceCredential } from './credential.js'
import { hexEquals, normaliseHex } from './hex.js'
import { sanitiseDisplayName } from './display-name.js'
import { evaluateAccess } from './access.js'
import { normaliseAgentOwnership, verifyAgentOwnership } from './ownership.js'
import type { RelayTransport } from './relay-pool.js'
import type { AgentOwnership, DeviceCredential, KindredProof, RoomPolicy } from './types.js'

export const MAX_CHAT_TEXT_LENGTH = 2_000
export const CHAT_RETENTION_SECONDS = 30 * 24 * 60 * 60
export const MAX_CHAT_MESSAGES = 500
export const MAX_CHAT_MESSAGES_PER_MINUTE = 30

const CHANNEL_ID_INFO = 'kithmoot/v1/channel-id/'
const CHANNEL_KEY_INFO = 'kithmoot/v1/channel-key/'
/** Bounds a channel name, which rides only in an HKDF info string and
 *  never on the wire; long enough for any sensible name. */
export const MAX_CHANNEL_NAME_LENGTH = 64

/**
 * The room id and key a named channel lives under.
 *
 * Both derived from the room KEY, never the room id, so a party that holds
 * the id and not the key - a forwarder, a relay - cannot find the channel
 * from the room, let alone read it. Two separate HKDF expansions for the
 * same reason `deriveRoom` uses two: publishing the id reveals nothing about
 * the key. The main chat is the unnamed channel and is untouched by this:
 * its id is the room id and its key the room key, byte for byte as before.
 */
export function deriveChannel(roomId: string, roomKey: Uint8Array, channel?: string): { id: string; key: Uint8Array } {
  if (channel === undefined) return { id: roomId, key: roomKey }
  if (channel.length === 0 || channel.length > MAX_CHANNEL_NAME_LENGTH) throw new Error('channel name out of range')
  const idBytes = hkdf(sha256, roomKey, undefined, CHANNEL_ID_INFO + channel, 32)
  const key = hkdf(sha256, roomKey, undefined, CHANNEL_KEY_INFO + channel, 32)
  const id = Array.from(idBytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return { id, key }
}

/** What a message is, when it is not simply something somebody typed. */
export type ChatMessageKind = 'transcript' | 'directive'

export interface ChatMessage {
  /** Authenticated shared-work operation, inside room encryption only. */
  assignment?: Event
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
  /** Encrypted reaction update; text is a readable fallback for older clients. */
  reaction?: ChatReaction
  sentAt: number
  /**
   * `transcript` when `text` is what somebody SAID, written down by the
   * sender - an agent that was listening - rather than something the sender
   * typed. Absent on an ordinary message, so the wire is byte-identical for
   * a client that has never heard of transcripts, and such a client shows
   * it as an ordinary message from the transcriber, which is honest.
   *
   * `directive` when `text` is what the SENDER said, out loud, while
   * deliberately holding the microphone down to address the agents. It is
   * an instruction rather than conversation, and the distinction is the
   * whole point: pressing a microphone is already an unambiguous act of
   * address, so nobody should have to say a machine's name out loud to be
   * heard by one, and an adapter may treat a directive as a mention
   * whatever its engagement pattern otherwise says.
   *
   * A directive carries no `speaker`. A transcript needs one because the
   * sender is writing down somebody else's words; a directive is the
   * sender's own, so `participant` already says whose they are, and a
   * second claim would only be a weaker copy of it.
   *
   * Like a transcript it degrades honestly: a client that has never heard
   * of directives shows an ordinary message from the person who spoke.
   */
  kind?: ChatMessageKind
  /**
   * For a transcript: the participant whose words these are. A claim made
   * by the transcriber, exactly as a display name is a claim made by its
   * owner, and rendered the same way - beside a pubkey, never instead of
   * one. Absent unless `kind` is set.
   */
  speaker?: string
  /**
   * Files shared through Wildbloom, riding with the message. Absent on a
   * message that carries none, so the wire is byte-identical for a client
   * that has never heard of attachments, and such a client shows the text,
   * which the sender wrote as the caption. See `ChatAttachment`.
   */
  attachments?: ChatAttachment[]
  /**
   * Whose agent the sender is, when it is one and its principal has said
   * so. Carried on the message for the reason the credential is: chat is
   * durable and the roster is not, and a line read out of history was
   * written by an agent that may be in nobody's roster now. Verified by
   * `decodeChatEvent` as at the message's send time, like the credential,
   * and dropped if it does not hold. See `AgentOwnership`.
   */
  owner?: AgentOwnership
  /**
   * The message this one answers, and the root of the thread it belongs
   * to. A reply to a root carries both, equal; deeper in a thread `thread`
   * is the root and `reply` the message answered. `thread` absent with
   * `reply` present means the parent is the root. A malformed reference
   * is dropped and the message stays. See `docs/messages.md`.
   */
  reply?: MessageRef
  thread?: MessageRef
  /**
   * The id of the ORIGINAL message this one replaces, same author, same
   * channel. The whole new message: text, attachments and mentions. A
   * message carrying this is an edit, not a message, and a reader shows
   * the latest edit on the original's frame; see `resolveConversation`.
   */
  replaces?: string
  /**
   * The id of the original this retracts, same author. An author-signed
   * tombstone, cooperative like every deletion here: every admitted device
   * already holds the plaintext. Carries nothing else.
   */
  retracts?: string
  /**
   * Who this addresses: participant keys, and `everyone`. The sender's
   * declaration, on the wire, so what shows as a mention is exactly what
   * an agent answers to. Absent on a message from before the field
   * existed, which readers match by name instead; see `mentionsOf`.
   */
  mentions?: string[]
  /**
   * A direct-message invitation, sealed to one member of this room. Not
   * conversation; shown to nobody but `to`. See `ChatInvite` and `dm.ts`.
   */
  invite?: ChatInvite
}

/**
 * One file shared through Wildbloom.
 *
 * Wildbloom uploads only an encrypted envelope and publishes a kind-1063
 * event naming where it is and what its bytes hash to; the key that opens
 * it is shown to the uploader once and goes nowhere public. Here it goes
 * into the chat, inside the room-key ciphertext, which is the one place
 * every member can read and nobody else can. That is not a weakening of
 * Wildbloom's model but the case it was designed for: the key travels by a
 * channel the people concerned already trust, and the room is that channel.
 *
 * The hints are what the sender chose to say about the file before anyone
 * has fetched it, so a reader can decide whether to. They are claims like a
 * display name is; the envelope's own metadata is what the file turns out
 * to be.
 */
export interface ChatAttachment {
  /** The kind-1063 event id: where this came from, for anyone who wants to
   *  check the public record. */
  event: string
  /** Where the envelope is served. https only. */
  url: string
  /** SHA-256 of the served envelope bytes, the event's `x` tag. Checked
   *  before the key is ever applied to a download. */
  sha256: string
  /** The Wildbloom recovery key, as 64 hex characters. */
  key: string
  /** What the sender says the file is called. */
  name?: string
  /** What the sender says it is, as a media type. */
  type?: string
  /** The envelope's byte count: what a click will download. */
  size?: number
}

export const MAX_CHAT_ATTACHMENTS = 4
export const MAX_ATTACHMENT_URL_LENGTH = 2048
export const MAX_ATTACHMENT_NAME_LENGTH = 255
const MAX_ATTACHMENT_TYPE_LENGTH = 128
const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+$/
const HEX_64 = /^[0-9a-fA-F]{64}$/

/**
 * The one honest shape of an attachment, or null. Runs on the way out as
 * well as on the way in, like a display name: the JSON off a relay is
 * anybody's, and the object handed to `send` is a caller's.
 */
export function normaliseAttachment(raw: unknown): ChatAttachment | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  if (typeof a.event !== 'string' || !HEX_64.test(a.event)) return null
  if (typeof a.sha256 !== 'string' || !HEX_64.test(a.sha256)) return null
  if (typeof a.key !== 'string' || !HEX_64.test(a.key)) return null
  if (typeof a.url !== 'string' || a.url.length === 0 || a.url.length > MAX_ATTACHMENT_URL_LENGTH) return null
  let url: URL
  try {
    url = new URL(a.url)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  const out: ChatAttachment = {
    event: normaliseHex(a.event),
    url: a.url,
    sha256: normaliseHex(a.sha256),
    key: normaliseHex(a.key),
  }
  const name = sanitiseAttachmentName(a.name)
  if (name !== undefined) out.name = name
  if (typeof a.type === 'string' && a.type.length <= MAX_ATTACHMENT_TYPE_LENGTH && MEDIA_TYPE.test(a.type)) {
    out.type = a.type.toLowerCase()
  }
  if (typeof a.size === 'number' && Number.isSafeInteger(a.size) && a.size >= 0) out.size = a.size
  return out
}

/**
 * A file name gets the display-name treatment - no invisibles, no second
 * row, no reversed direction - but a longer leash, because a file name is
 * allowed to be a sentence and is not standing in for an identity.
 */
function sanitiseAttachmentName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const collapsed = raw
    .replace(/\s+/gu, ' ')
    .replace(/\p{C}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!collapsed) return undefined
  const characters = [...collapsed]
  if (characters.length <= MAX_ATTACHMENT_NAME_LENGTH) return collapsed
  return characters.slice(0, MAX_ATTACHMENT_NAME_LENGTH).join('').trim() || undefined
}

/** The attachments of a message in their honest shape, or undefined if
 *  there are none worth carrying. Throws when there are too many: that is
 *  a caller's mistake, not a relay's, and it should not be papered over. */
function honestAttachments(raw: unknown): ChatAttachment[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) return undefined
  const kept = raw.map(normaliseAttachment).filter((a): a is ChatAttachment => a !== null)
  if (kept.length > MAX_CHAT_ATTACHMENTS) throw new Error(`a message carries at most ${MAX_CHAT_ATTACHMENTS} attachments`)
  return kept.length ? kept : undefined
}

/** The mentions of a message in their honest shape, or undefined if none
 *  are worth carrying. Throws over the cap, for the reason attachments do. */
function honestMentions(raw: unknown): string[] | undefined {
  if (raw === undefined || !Array.isArray(raw)) return undefined
  if (raw.length > MAX_MENTIONS) throw new Error(`a message names at most ${MAX_MENTIONS} participants`)
  const kept = normaliseMentions(raw)
  return kept.length ? kept : undefined
}

/**
 * The id and key a room's traffic rides under in its current epoch. Omitted
 * in epoch 0, where they are the room id and the room key and the wire is
 * byte for byte what it was before epochs existed. See `epoch.ts`.
 */
export interface EpochRoot {
  id: string
  key: Uint8Array
}

export interface EncodeChatOptions {
  /** The room this message belongs to: what its credential is checked
   *  against, whatever epoch it rides in. */
  roomId: string
  roomKey: Uint8Array
  deviceSk: Uint8Array
  /** Which channel of the room this rides in. Omit for the main chat. See
   *  `deriveChannel`. */
  channel?: string
  /** The epoch to ride in. Omit for epoch 0. */
  epoch?: EpochRoot
}

/** The root a channel derives from: the epoch's id and key when there is
 *  one, the room's otherwise. */
function rootOf(opts: { roomId: string; roomKey: Uint8Array; epoch?: EpochRoot }): EpochRoot {
  return opts.epoch ?? { id: opts.roomId, key: opts.roomKey }
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
  if (msg.assignment) {
    const payload = assignmentPayload(msg.assignment, opts.roomId)
    if (opts.channel !== ASSIGNMENT_CHANNEL || !payload || msg.assignment.pubkey !== msg.participant ||
        (payload.device !== undefined && payload.device !== msg.device)) throw new Error('Invalid assignment envelope')
  }
  // Sanitised on the way out as well as on the way in - see
  // `encodeRosterEvent` for why both. `name: undefined` is dropped by
  // JSON.stringify, so a message with no name is byte-identical to one
  // encoded before names existed.
  // `kind` and `speaker` are written only in the one honest shape, so a
  // message that is not a transcript is byte-identical to one encoded
  // before transcripts existed.
  // Attachments likewise: only the honest shape, and none at all rather
  // than an empty list, so a message without them is byte-identical to one
  // encoded before attachments existed.
  const transcript = msg.kind === 'transcript'
  const directive = msg.kind === 'directive'
  const plaintext = JSON.stringify({
    ...msg,
    name: sanitiseDisplayName(msg.name),
    kind: transcript ? 'transcript' : directive ? 'directive' : undefined,
    speaker: transcript && typeof msg.speaker === 'string' ? normaliseHex(msg.speaker) : undefined,
    attachments: honestAttachments(msg.attachments),
    reaction: msg.reaction === undefined ? undefined : normaliseReaction(msg.reaction),
    owner: msg.owner ? normaliseAgentOwnership(msg.owner) ?? undefined : undefined,
    // The message layer's fields, each in its one honest shape or absent,
    // so a message that says nothing about another is byte-identical to
    // one encoded before any of them existed.
    reply: msg.reply === undefined ? undefined : normaliseMessageRef(msg.reply) ?? undefined,
    thread: msg.thread === undefined ? undefined : normaliseMessageRef(msg.thread) ?? undefined,
    replaces: validMessageId(msg.replaces) ? msg.replaces : undefined,
    retracts: validMessageId(msg.retracts) ? msg.retracts : undefined,
    mentions: honestMentions(msg.mentions),
    invite: msg.invite === undefined ? undefined : normaliseInvite(msg.invite) ?? undefined,
  })
  const root = rootOf(opts)
  const { id, key } = deriveChannel(root.id, root.key, opts.channel)
  const content = nip44.v2.encrypt(plaintext, key)
  return finalizeEvent(
    {
      kind: KINDS.CHAT,
      created_at: msg.sentAt,
      tags: [['d', id]],
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
  /** Which channel to read. Omit for the main chat. A message on another
   *  channel does not decode: it is under another id and another key. The
   *  credential inside is still checked against the ROOM, because that is
   *  what it names - a channel is a place in a room, not a room. */
  channel?: string
  /** The epoch to read. Omit for epoch 0. A message from another epoch
   *  does not decode, for the same reason a message on another channel
   *  does not: it is under another id and another key. */
  epoch?: EpochRoot
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
    const root = rootOf(opts)
    const { id, key } = deriveChannel(root.id, root.key, opts.channel)
    const roomTag = event.tags.find((t) => t[0] === 'd')?.[1]
    if (roomTag === undefined || !hexEquals(roomTag, id)) return null
    if (!verifyEventUncached(event)) return null

    const msg = JSON.parse(nip44.v2.decrypt(event.content, key)) as ChatMessage

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

    // One statement per message. A reaction, an edit, a retraction and an
    // invitation each say one thing about one other message, and a
    // payload that carries two of them, or one of them beside conversation
    // it has no business carrying, is not a shape any client sends. It is
    // refused whole rather than read charitably, and the check is on the
    // keys as they arrived, so a malformed extra says nothing in its
    // favour.
    const raw = msg as unknown as Record<string, unknown>
    const has = (field: string): boolean => raw[field] !== undefined
    const statements = ['reaction', 'replaces', 'retracts', 'invite', 'assignment'].filter(has)
    if (statements.length > 1) return null
    if ((has('reaction') || has('retracts') || has('invite') || has('assignment')) &&
        (has('kind') || has('attachments') || has('reply') || has('thread') || has('mentions'))) return null
    if (has('replaces') && (has('kind') || has('reply') || has('thread'))) return null
    if (msg.assignment) {
      const payload = assignmentPayload(msg.assignment, opts.roomId)
      if (opts.channel !== ASSIGNMENT_CHANNEL || !payload || msg.assignment.pubkey !== msg.participant ||
          (payload.device !== undefined && payload.device !== msg.device)) return null
    }

    if (msg.reaction !== undefined) {
      const reaction = normaliseReaction(msg.reaction)
      if (!reaction) return null
      msg.reaction = reaction
    }

    // An edit or a retraction that does not say which message is not one
    // to make the best of: shown as a message it would duplicate what it
    // meant to replace.
    if (msg.replaces !== undefined && !validMessageId(msg.replaces)) return null
    if (msg.retracts !== undefined && !validMessageId(msg.retracts)) return null
    if (msg.invite !== undefined) {
      const invite = normaliseInvite(msg.invite)
      if (!invite) return null
      msg.invite = invite
    }

    // A reference that does not check out is dropped and the message
    // stays, which is exactly what an older client shows.
    for (const field of ['reply', 'thread'] as const) {
      if (msg[field] === undefined) continue
      const ref = normaliseMessageRef(msg[field])
      if (ref) msg[field] = ref
      else delete msg[field]
    }

    // Mentions off a relay: bad entries dropped, the field gone unless
    // something is left, more than the cap refused, exactly as attachments.
    if (msg.mentions !== undefined) {
      if (!Array.isArray(msg.mentions)) {
        delete msg.mentions
      } else {
        if (msg.mentions.length > MAX_MENTIONS) return null
        const kept = normaliseMentions(msg.mentions)
        if (kept.length) msg.mentions = kept
        else delete msg.mentions
      }
    }

    // Only the one honest shape reads as a transcript; anything else is an
    // ordinary message, which is what it would be to a client that never
    // heard of transcripts. The speaker is a pubkey off the wire like any
    // other, canonicalised here so a renderer can match it to a roster
    // entry without its own case rule.
    // Only an honest shape reads as anything but an ordinary message, which
    // is what it would be to a client that never heard of either marker. A
    // speaker belongs to a transcript alone: on a directive the sender is
    // the speaker, so one arriving there is dropped rather than believed.
    if (msg.kind !== 'transcript' && msg.kind !== 'directive') {
      delete msg.kind
      delete msg.speaker
    } else if (
      msg.kind === 'transcript' &&
      typeof msg.speaker === 'string' &&
      /^[0-9a-fA-F]{64}$/.test(msg.speaker)
    ) {
      msg.speaker = normaliseHex(msg.speaker)
    } else {
      delete msg.speaker
    }

    // Attachments off a relay: each entry is checked on its own and a bad
    // one is dropped, because one malformed entry should not silence the
    // text beside it. The field goes altogether unless something valid is
    // left. More than the cap is refused outright: no conformant client
    // sends that, so it is not a message to make the best of.
    if (msg.attachments !== undefined) {
      if (!Array.isArray(msg.attachments)) {
        delete msg.attachments
      } else {
        if (msg.attachments.length > MAX_CHAT_ATTACHMENTS) return null
        const kept = msg.attachments.map(normaliseAttachment).filter((a): a is ChatAttachment => a !== null)
        if (kept.length) msg.attachments = kept
        else delete msg.attachments
      }
    }

    // Whose agent the sender is: verified as at send time, like the
    // credential, or not carried at all. See `decodeRosterEvent`.
    if (msg.owner !== undefined) {
      const proof = normaliseAgentOwnership(msg.owner)
      const verdict = proof ? verifyAgentOwnership(proof, { agent: msg.participant, now: msg.sentAt }) : { ok: false as const }
      if (proof && verdict.ok) msg.owner = proof
      else delete msg.owner
    }

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
   *  passed alongside, so the two can never disagree.
   *
   *  Omit it, and `deviceSk` with it, for a log that only reads: a device
   *  that holds the room key can always read the room's chat, and sometimes
   *  wants to - to count what is new in a room it is not in right now -
   *  without publishing anything. Such a log decodes by exactly the rules
   *  above and refuses `send`. */
  credential?: DeviceCredential
  deviceSk?: Uint8Array
  /** What to call this sender on every message. Sanitised here, so a
   *  caller can pass a form field straight in. */
  name?: string
  policy?: RoomPolicy
  proof?: KindredProof
  /** Injectable clock, in unix seconds. Defaults to the real one. */
  now?: () => number
  /** Which channel of the room this log is. Omit for the main chat. See
   *  `deriveChannel`. */
  channel?: string
  /** The epoch to open in. Omit for epoch 0. `rekey` moves a log on. */
  epoch?: EpochRoot
  /** This sender's ownership proof, when it is an agent whose principal
   *  has attested to it. Carried on every message. */
  owner?: AgentOwnership
}

/** What `send` may say beyond the text. */
export interface SendOptions {
  reaction?: ChatReaction
  /** Mark the message a transcript of `speaker`'s words. See
   *  `ChatMessage.kind`. */
  transcriptOf?: string
  /**
   * Send this as a directive: something the sender said out loud, holding
   * the microphone, to address the agents. See `ChatMessage.kind`.
   *
   * Refused together with `transcriptOf`, because the two say different
   * things about whose words these are and a message cannot be both.
   */
  directive?: boolean
  /** Files shared through Wildbloom to carry with the text. See
   *  `ChatAttachment`. The text is the caption and is still required. */
  attachments?: ChatAttachment[]
  /** Answer this message. The thread root is worked out here: the target's
   *  own root when it is in a thread, the target itself otherwise. */
  replyTo?: Pick<ChatMessage, 'id' | 'participant' | 'thread' | 'reply'>
  /** Replace this message of ours with the text and attachments given. */
  replaces?: string
  /** Retract this message of ours. The text is the readable fallback. */
  retracts?: string
  /** Who the text addresses. See `ChatMessage.mentions`. */
  mentions?: string[]
  /** Carry a sealed DM invitation. See `dm.ts`. */
  invite?: ChatInvite
}

/**
 * The chat history for one room, kept in step with events arriving over the
 * transport and appended to by `send()`.
 */
export class ChatLog {
  readonly #opts: ChatLogOptions
  readonly #now: () => number
  /** The credential every message goes out under. Starts as the one handed
   *  in and is replaced when the session renews - see `setCredential`.
   *  Undefined on a log that only reads. */
  #credential: DeviceCredential | undefined
  #messages: ChatMessage[] = []
  readonly #seen = new Set<string>()
  readonly #senderTimes = new Map<string, number[]>()
  readonly #listeners = new Set<(messages: ChatMessage[]) => void>()
  #closed = false
  #unsub: () => void
  /** The epoch this log reads and writes. Undefined is epoch 0. */
  #epoch?: EpochRoot

  constructor(opts: ChatLogOptions) {
    this.#opts = opts
    this.#credential = opts.credential
    this.#epoch = opts.epoch
    this.#now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.#unsub = this.#subscribe()
  }

  #subscribe(): () => void {
    const root = rootOf({ roomId: this.#opts.roomId, roomKey: this.#opts.roomKey, epoch: this.#epoch })
    const { id } = deriveChannel(root.id, root.key, this.#opts.channel)
    return this.#opts.transport.subscribe(
      [{ kinds: [KINDS.CHAT], '#d': [id], since: this.#now() - CHAT_RETENTION_SECONDS }],
      (event) => this.#ingest(event),
    )
  }

  /**
   * Move this log to a new epoch: read and write under the new id and key
   * from now on, and keep what was already read. History from the epoch
   * being left stays on screen for whoever was there for it, which is
   * honest; nothing published under the old key after this is heard, which
   * is the point. See `epoch.ts`.
   */
  rekey(next: EpochRoot): void {
    this.#unsub()
    this.#epoch = next
    this.#unsub = this.#subscribe()
  }

  /** The channel this log is, or undefined for the main chat. */
  get channel(): string | undefined {
    return this.#opts.channel
  }

  /** Whether this log can send, or was opened to read only. */
  get readOnly(): boolean {
    return this.#credential === undefined || this.#opts.deviceSk === undefined
  }

  async send(text: string, sendOpts: SendOptions = {}): Promise<void> {
    await this.prepareSend(text, sendOpts)()
  }

  /** Prepare one signed event. Explicit retries publish exactly the same
   * event, including after an acknowledgement was lost. A room or channel
   * that has closed or changed its key must not publish the old event. */
  prepareSend(text: string, sendOpts: SendOptions = {}): () => Promise<void> {
    if (this.#closed) throw new Error('this conversation has closed')
    const credential = this.#credential
    const deviceSk = this.#opts.deviceSk
    if (!credential || !deviceSk) throw new Error('this log only reads; it was opened without a credential')
    if (text.length === 0) throw new Error('chat message is empty')
    if (text.length > MAX_CHAT_TEXT_LENGTH) {
      throw new Error(`chat message exceeds ${MAX_CHAT_TEXT_LENGTH} characters`)
    }
    const reaction = sendOpts.reaction === undefined ? undefined : normaliseReaction(sendOpts.reaction)
    if (sendOpts.reaction !== undefined && (!reaction || sendOpts.transcriptOf !== undefined || sendOpts.directive || sendOpts.attachments !== undefined)) {
      throw new Error('invalid reaction')
    }
    // One statement per message, checked here as a caller's mistake so it
    // is never silently sent as something else. See `decodeChatEvent`.
    const statements = [sendOpts.reaction, sendOpts.replaces, sendOpts.retracts, sendOpts.invite].filter((x) => x !== undefined)
    if (statements.length > 1) throw new Error('a message says one thing about another message, not two')
    const isConversation = statements.length === 0
    if (!isConversation && sendOpts.replyTo !== undefined) throw new Error('only a message can answer another')
    if ((sendOpts.reaction !== undefined || sendOpts.retracts !== undefined || sendOpts.invite !== undefined) &&
        (sendOpts.mentions !== undefined || sendOpts.attachments !== undefined || sendOpts.transcriptOf !== undefined || sendOpts.directive)) {
      throw new Error('a reaction, a retraction or an invitation carries nothing else')
    }
    if (sendOpts.replaces !== undefined && (sendOpts.transcriptOf !== undefined || sendOpts.directive)) {
      throw new Error('an edit keeps the kind of the message it replaces')
    }
    if (sendOpts.replaces !== undefined && !validMessageId(sendOpts.replaces)) throw new Error('an edit must name the message it replaces')
    if (sendOpts.retracts !== undefined && !validMessageId(sendOpts.retracts)) throw new Error('a retraction must name the message it retracts')
    const invite = sendOpts.invite === undefined ? undefined : normaliseInvite(sendOpts.invite)
    if (sendOpts.invite !== undefined && !invite) throw new Error('invalid invitation')
    const mentions = honestMentions(sendOpts.mentions)
    let reply: MessageRef | undefined
    let thread: MessageRef | undefined
    if (sendOpts.replyTo !== undefined) {
      const target = sendOpts.replyTo
      reply = normaliseMessageRef({ messageId: target.id, participant: target.participant }) ?? undefined
      if (!reply) throw new Error('a reply must name the message it answers')
      thread = target.thread ?? target.reply ?? reply
    }
    const name = sanitiseDisplayName(this.#opts.name)
    // A caller's attachment that does not check out is a bug in the caller,
    // and one that would be silently dropped here would be a file the
    // sender believes went out and nobody received.
    let attachments: ChatAttachment[] | undefined
    if (sendOpts.attachments !== undefined) {
      if (sendOpts.attachments.length > MAX_CHAT_ATTACHMENTS) {
        throw new Error(`a message carries at most ${MAX_CHAT_ATTACHMENTS} attachments`)
      }
      attachments = sendOpts.attachments.map((a) => {
        const ok = normaliseAttachment(a)
        if (!ok) throw new Error('attachment is not a Wildbloom share')
        return ok
      })
      if (attachments.length === 0) attachments = undefined
    }
    const msg: ChatMessage = {
      id: hex(randomBytes(16)),
      participant: credential.pubkey,
      device: getPublicKey(deviceSk),
      credential,
      ...(this.#opts.proof ? { proof: this.#opts.proof } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(sendOpts.transcriptOf !== undefined
        ? { kind: 'transcript' as const, speaker: normaliseHex(sendOpts.transcriptOf) }
        : sendOpts.directive
          ? { kind: 'directive' as const }
          : {}),
      text,
      ...(reaction ? { reaction } : {}),
      sentAt: this.#now(),
      ...(attachments ? { attachments } : {}),
      ...(this.#opts.owner ? { owner: this.#opts.owner } : {}),
      ...(reply ? { reply } : {}),
      ...(thread ? { thread } : {}),
      ...(sendOpts.replaces !== undefined ? { replaces: sendOpts.replaces } : {}),
      ...(sendOpts.retracts !== undefined ? { retracts: sendOpts.retracts } : {}),
      ...(mentions ? { mentions } : {}),
      ...(invite ? { invite } : {}),
    }
    const event = encodeChatEvent(msg, {
      roomId: this.#opts.roomId,
      roomKey: this.#opts.roomKey,
      deviceSk,
      channel: this.#opts.channel,
      ...(this.#epoch ? { epoch: this.#epoch } : {}),
    })
    const epoch = this.#epoch
    return async () => {
      if (this.#closed || this.#epoch !== epoch) {
        throw new Error('This conversation has closed or changed its key. Copy your message into the current conversation to send it.')
      }
      await this.#opts.transport.publish(event)
    }
  }

  /**
   * Present a fresh credential on every message from now on.
   *
   * A message carries its credential because chat is durable and a reader
   * checks it as at the message's send time, so a message sent after the
   * old credential lapsed under the old credential would be refused by
   * everybody. The session renews before that happens and hands the
   * replacement here. It must name the same device and participant: a
   * message signed by one device carrying another's credential is exactly
   * what `decodeChatEvent` exists to refuse.
   */
  setCredential(credential: DeviceCredential): void {
    if (!this.#credential) throw new Error('this log only reads; it was opened without a credential')
    if (credential.pubkey !== this.#credential.pubkey) throw new Error('renewed credential names a different participant')
    this.#credential = credential
  }

  messages(): ChatMessage[] {
    return [...this.#messages]
  }

  onChange(cb: (messages: ChatMessage[]) => void): () => void {
    this.#listeners.add(cb)
    return () => this.#listeners.delete(cb)
  }

  close(): void {
    this.#closed = true
    this.#unsub()
    this.#listeners.clear()
  }

  #ingest(event: Event): void {
    const msg = decodeChatEvent(event, {
      roomId: this.#opts.roomId,
      roomKey: this.#opts.roomKey,
      now: this.#now(),
      policy: this.#opts.policy,
      channel: this.#opts.channel,
      ...(this.#epoch ? { epoch: this.#epoch } : {}),
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
