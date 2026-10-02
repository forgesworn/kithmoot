import type { ChatMessage } from './chat.js'

/** When a message was sent, in milliseconds: `sentAtMs`, or the start of
 *  its second from a client that does not write one. */
export function sentAtMillis(m: Pick<ChatMessage, 'sentAt' | 'sentAtMs'>): number {
  return m.sentAtMs ?? m.sentAt * 1000
}

/** Order by send time, to the millisecond where the sender gave it; a tie
 *  breaks on id, so every client in the room reaches the same order
 *  without negotiating one. */
export function compareMessages(a: Pick<ChatMessage, 'sentAt' | 'sentAtMs' | 'id'>, b: Pick<ChatMessage, 'sentAt' | 'sentAtMs' | 'id'>): number {
  const at = sentAtMillis(a) - sentAtMillis(b)
  if (at !== 0) return at
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
