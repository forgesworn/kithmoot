import { hexEquals, normaliseHex } from './hex.js'
import type { ChatMessage } from './chat.js'

/**
 * The message layer: what a chat message may say about another message,
 * who it addresses, and how a reader turns a flat log of statements into a
 * conversation. The design is `docs/messages.md`; the codec that carries
 * these fields is `chat.ts`; the rules for resolving them are here so that
 * every client, and every agent, reaches the same answer.
 */

/**
 * A message named by its id and its author. An id is chosen by its sender,
 * so an id alone is anybody's to reuse; the pair is what no third party can
 * forge. Reactions name their target this way too.
 */
export interface MessageRef {
  messageId: string
  participant: string
}

const HEX_64 = /^[0-9a-fA-F]{64}$/
export const MAX_MESSAGE_ID_LENGTH = 128

export function validMessageId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_MESSAGE_ID_LENGTH
}

/** The one honest shape of a reference, or null. */
export function normaliseMessageRef(raw: unknown): MessageRef | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!validMessageId(r.messageId)) return null
  if (typeof r.participant !== 'string' || !HEX_64.test(r.participant)) return null
  return { messageId: r.messageId, participant: normaliseHex(r.participant) }
}

export function refOf(m: Pick<ChatMessage, 'id' | 'participant'>): MessageRef {
  return { messageId: m.id, participant: m.participant }
}

/** One string per message, for maps. */
export function refKey(ref: MessageRef): string {
  return `${normaliseHex(ref.participant)}:${ref.messageId}`
}

export function sameRef(a: MessageRef, b: MessageRef): boolean {
  return a.messageId === b.messageId && hexEquals(a.participant, b.participant)
}

/** The literal that addresses the whole room. */
export const EVERYONE = 'everyone'
export const MAX_MENTIONS = 32

/** Explicit room calls only: ordinary prose and email addresses do not broadcast. */
export const ROOM_MENTION_PATTERN = /(?<![\p{L}\p{N}_@.+-])@(?:all|everyone)(?![\p{L}\p{N}_@-]|\.[\p{L}\p{N}_])/iu

/**
 * Participant keys and `everyone`, deduplicated and normalised. Anything
 * else is dropped: the sender's declaration is only worth what it names.
 */
export function normaliseMentions(raw: readonly unknown[]): string[] {
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const value = entry === EVERYONE ? EVERYONE : HEX_64.test(entry) ? normaliseHex(entry) : undefined
    if (value !== undefined && !out.includes(value)) out.push(value)
  }
  return out
}

/**
 * A direct-message invitation: the DM room's link, sealed to one member
 * of the room this message is sent in. See `dm.ts` for sealing and
 * opening, and `docs/messages.md` for why `to` is explicit.
 */
export interface ChatInvite {
  /** The participant this is for. */
  to: string
  /** The DM room's id, so a recipient can recognise one it already joined. */
  room: string
  /** The join URL, NIP-44 v2 encrypted between the sender's participant
   *  key and `to`'s. */
  link: string
}

export const MAX_INVITE_LINK_LENGTH = 8192

export function normaliseInvite(raw: unknown): ChatInvite | null {
  if (!raw || typeof raw !== 'object') return null
  const i = raw as Record<string, unknown>
  if (typeof i.to !== 'string' || !HEX_64.test(i.to)) return null
  if (typeof i.room !== 'string' || !HEX_64.test(i.room)) return null
  if (typeof i.link !== 'string' || i.link.length === 0 || i.link.length > MAX_INVITE_LINK_LENGTH) return null
  return { to: normaliseHex(i.to), room: normaliseHex(i.room), link: i.link }
}

/**
 * Whether the text names `name` as a whole word, with or without an `@`.
 * The legacy reading of a mention, from before the field existed: a name
 * found in the text, not a word the name happens to sit inside.
 */
export function namesInText(text: string, name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) return false
  const literal = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@?${literal}(?![\\p{L}\\p{N}_])`, 'iu').test(text)
}

export interface Named {
  participant: string
  name?: string
  agent?: boolean
}

/**
 * Who a message addresses: the participants it names on the wire, or, on a
 * message from before the field existed, whoever in the roster it names by
 * name. `everyone` is returned as itself.
 *
 * This is the one function both a client and an agent use, so what lights
 * up as a mention is exactly what an agent answers to.
 */
export function mentionsOf(message: Pick<ChatMessage, 'text' | 'mentions'>, roster: readonly Named[] = []): string[] {
  if (message.mentions !== undefined) return message.mentions
  const out: string[] = ROOM_MENTION_PATTERN.test(message.text) ? [EVERYONE] : []
  // Name the currently present agents as well, so a new composer can reach
  // older agent clients that treated the room sentinel as people-only.
  if (out.includes(EVERYONE)) {
    for (const entry of roster) if (entry.agent && !out.includes(entry.participant)) out.push(entry.participant)
  }
  for (const entry of roster) {
    if (entry.name && namesInText(message.text, entry.name) && !out.includes(entry.participant)) out.push(entry.participant)
  }
  return out
}

/**
 * Whether the message addresses `self`. A room call includes agents;
 * addressing does not grant the sender permission to run an agent's tools.
 */
export function mentionedBy(
  message: Pick<ChatMessage, 'text' | 'mentions'>,
  self: string,
  roster: readonly Named[] = [],
  _opts: { agent?: boolean } = {},
): boolean {
  const named = mentionsOf(message, roster)
  if (named.some((p) => p !== EVERYONE && hexEquals(p, self))) return true
  return named.includes(EVERYONE)
}

/** Whether a message is something somebody said, rather than a statement
 *  about another message. */
export function isConversation(m: ChatMessage): boolean {
  return m.reaction === undefined && m.replaces === undefined && m.retracts === undefined && m.invite === undefined
}

/** A message as it should be read, once every statement about it is applied. */
export interface ResolvedMessage {
  /** The message as first sent. On an edit whose original is not loaded,
   *  the edit itself. */
  original: ChatMessage
  /** What to show: the latest edit's text, attachments and mentions on
   *  the original's frame. The original when there are no edits. */
  shown: ChatMessage
  edited: boolean
  /** Every edit that reached this reader, oldest first. */
  edits: ChatMessage[]
  retracted: boolean
  /** The root this belongs under, when it is in a thread. Set whether or
   *  not the root is loaded; `replies` on the root says which. */
  thread?: MessageRef
  /** The message this answers, when it says. */
  reply?: MessageRef
  /** Replies under this message, oldest first, when it is a root. */
  replies: ResolvedMessage[]
  /** True when this belongs under a root that is not loaded, so it is
   *  shown in the main stream marked as part of a thread. */
  orphan: boolean
}

export interface Conversation {
  /** Top-level messages in order, with their replies nested. */
  stream: ResolvedMessage[]
  /** Every resolved message by `refKey`, replies included. */
  byKey: Map<string, ResolvedMessage>
}

/** Later wins: greater `sentAt`, then greater id. The reactions rule. */
export function later(a: Pick<ChatMessage, 'sentAt' | 'id'>, b: Pick<ChatMessage, 'sentAt' | 'id'>): boolean {
  return a.sentAt > b.sentAt || (a.sentAt === b.sentAt && a.id > b.id)
}

function byTime(a: ChatMessage, b: ChatMessage): number {
  if (a.sentAt !== b.sentAt) return a.sentAt - b.sentAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Turn one conversation's verified messages into what a reader shows.
 *
 * The input is every message the log holds for one channel: originals,
 * edits, retractions, reactions and invitations together. Reactions and
 * invitations are not conversation and are left for `reactionsFor` and
 * `openInvite`. Edits attach to their original by id and author, so an
 * edit by anybody else is simply an edit of a message that does not exist,
 * and is shown as its own message marked edited, which is what an older
 * client shows anyway. A retraction attaches the same way, hides the
 * original whatever the times, and is ignored when it names nothing loaded.
 */
export function resolveConversation(messages: readonly ChatMessage[]): Conversation {
  const sorted = [...messages].sort(byTime)
  const byKey = new Map<string, ResolvedMessage>()
  const editsByTarget = new Map<string, ChatMessage[]>()
  const editIds = new Map<string, ChatMessage>()
  const retracted = new Set<string>()

  for (const m of sorted) {
    if (m.replaces !== undefined) {
      editIds.set(refKey(refOf(m)), m)
    } else if (m.retracts !== undefined) {
      retracted.add(refKey({ messageId: m.retracts, participant: m.participant }))
    } else if (isConversation(m)) {
      byKey.set(refKey(refOf(m)), {
        original: m,
        shown: m,
        edited: false,
        edits: [],
        retracted: false,
        ...(m.thread || m.reply ? { thread: m.thread ?? m.reply } : {}),
        ...(m.reply ? { reply: m.reply } : {}),
        replies: [],
        orphan: false,
      })
    }
  }

  // An edit names its original; one that names another edit is read as
  // naming that edit's original, walked with a guard against a loop.
  for (const edit of editIds.values()) {
    let target = refKey({ messageId: edit.replaces!, participant: edit.participant })
    for (let hops = 0; hops < 8 && !byKey.has(target) && editIds.has(target); hops++) {
      target = refKey({ messageId: editIds.get(target)!.replaces!, participant: edit.participant })
    }
    const list = editsByTarget.get(target) ?? []
    list.push(edit)
    editsByTarget.set(target, list)
  }

  for (const [target, edits] of editsByTarget) {
    const resolved = byKey.get(target)
    if (resolved) {
      resolved.edits = edits
      resolved.edited = true
      const latest = edits.reduce((best, e) => (later(e, best) ? e : best))
      resolved.shown = shownFrom(resolved.original, latest)
      continue
    }
    // The original is not loaded: the latest edit stands in for it, marked
    // edited, so nothing somebody said disappears just because the message
    // it corrected is older than the window.
    const latest = edits.reduce((best, e) => (later(e, best) ? e : best))
    const key = refKey({ messageId: latest.replaces!, participant: latest.participant })
    if (!byKey.has(key)) {
      byKey.set(key, { original: latest, shown: latest, edited: true, edits, retracted: false, replies: [], orphan: false })
    }
  }

  for (const key of retracted) {
    const resolved = byKey.get(key)
    if (resolved) resolved.retracted = true
  }

  // Threads: a message under a loaded root nests there; otherwise it stays
  // in the stream and says it belongs to a thread the reader cannot see.
  const stream: ResolvedMessage[] = []
  const ordered = [...byKey.values()].sort((a, b) => byTime(a.original, b.original))
  for (const resolved of ordered) {
    if (!resolved.thread) {
      stream.push(resolved)
      continue
    }
    const root = rootOf(resolved, byKey)
    if (root && root !== resolved) {
      resolved.thread = refOf(root.original)
      root.replies.push(resolved)
    } else {
      resolved.orphan = true
      stream.push(resolved)
    }
  }
  return { stream, byKey }
}

/** Walk `thread`/`reply` up to a loaded message that is not itself in a
 *  thread, or undefined when the chain leaves what is loaded. */
function rootOf(resolved: ResolvedMessage, byKey: Map<string, ResolvedMessage>): ResolvedMessage | undefined {
  let current: ResolvedMessage | undefined = resolved
  for (let hops = 0; hops < 8 && current?.thread; hops++) {
    const next = byKey.get(refKey(current.thread))
    if (!next) return undefined
    if (next === current) return undefined
    current = next
  }
  return current?.thread ? undefined : current
}

/** The latest edit's words on the original's frame: who said it, when it
 *  was first said, where it sits, and what kind of thing it is. */
function shownFrom(original: ChatMessage, latest: ChatMessage): ChatMessage {
  const shown: ChatMessage = { ...original, text: latest.text }
  delete shown.attachments
  delete shown.mentions
  if (latest.attachments) shown.attachments = latest.attachments
  if (latest.mentions) shown.mentions = latest.mentions
  return shown
}

/** The text to send with a retraction, readable on a client that has never
 *  heard of one. */
export function retractionText(): string {
  return 'Retracted a message'
}

/** The text to send with a DM invitation. Names nobody on purpose. */
export function inviteText(): string {
  return 'Started a private conversation'
}
