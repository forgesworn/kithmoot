import type { ChatMessage } from '../../src/chat.js'
import { refKey, type MessageRef, type ResolvedMessage } from '../../src/messages.js'

/**
 * What the quote inside a reply's bubble says about the message it answers.
 *
 * A reply is an ordinary message in the log, in time order. The wire format
 * still names a parent (`reply`) and a root (`thread`); the display uses the
 * parent, or the root when only that was sent, which for a reply to the root
 * is the same message. See docs/messages.md.
 */
export type ReplyQuote =
  /** The original is loaded and shown: say who, and what, and offer the jump. */
  | { state: 'ready'; ref: MessageRef; target: ResolvedMessage; snippet: string }
  /** The author retracted it. Nothing of it is quoted. */
  | { state: 'deleted'; ref: MessageRef; target: ResolvedMessage }
  /** Older than the history on screen, or never received. */
  | { state: 'missing'; ref: MessageRef }

/** The longest quote worth building; the stylesheet ellipsises to the width. */
const SNIPPET_LENGTH = 160

/** One line of somebody's words: line breaks and runs of space collapsed,
 *  cut on a character boundary. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= SNIPPET_LENGTH) return flat
  return flat.slice(0, SNIPPET_LENGTH).replace(/[\uD800-\uDBFF]$/, '').trimEnd() + '…'
}

/**
 * The words to quote: the message's current text, one line. With no text,
 * what kind of thing it carried, in the app's own names for them. `text`
 * is passed in already stripped of an artwork fallback (see
 * `artworkMessageText`), so a sticker with no caption reads as one.
 */
export function quoteSnippet(text: string, message: Pick<ChatMessage, 'attachments' | 'artwork'>): string {
  const line = oneLine(text)
  if (line) return line
  const attachment = message.attachments?.[0]
  if (attachment) {
    const type = attachment.type ?? ''
    if (type.startsWith('image/')) return 'Photo'
    if (type.startsWith('audio/')) return 'Audio'
    if (type.startsWith('video/')) return 'Video'
    return `File: ${attachment.name ?? 'Encrypted file'}`
  }
  if (message.artwork?.length) return 'Sticker'
  return ''
}

/** The reference a reply's quote points at, or undefined for a message that
 *  answers nothing. */
export function quoteRefOf(r: Pick<ResolvedMessage, 'reply' | 'thread'>): MessageRef | undefined {
  return r.reply ?? r.thread
}

/** The state of the quote on `r`, or undefined when `r` is not a reply.
 *  `textOf` turns the original's current words into what is quoted. */
export function replyQuoteOf(
  r: Pick<ResolvedMessage, 'reply' | 'thread'>,
  byKey: ReadonlyMap<string, ResolvedMessage>,
  textOf: (shown: ChatMessage) => string = shown => shown.text,
): ReplyQuote | undefined {
  const ref = quoteRefOf(r)
  if (!ref) return undefined
  const target = byKey.get(refKey(ref))
  if (!target) return { state: 'missing', ref }
  if (target.retracted) return { state: 'deleted', ref, target }
  return { state: 'ready', ref, target, snippet: quoteSnippet(textOf(target.shown), target.shown) }
}
