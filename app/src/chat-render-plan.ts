import type { ChatMessage } from '../../src/chat.js'
import { isConversation, refKey } from '../../src/messages.js'

export interface ChatRenderSnapshot {
  rawMessages: readonly ChatMessage[]
  messageLanes: readonly ChatMessage['lane'][]
  orderedKeys: readonly string[]
  system: readonly { at: number }[]
}

export type ChatRenderFullReason =
  | 'no-append'
  | 'not-only-additions'
  | 'identity-prefix'
  | 'system-changed'
  | 'non-ordinary-suffix'
  | 'non-ordinary-eviction'
  | 'evicted-reference'
  | 'system-after-append'
  | 'ordered-keys'

export type ChatRenderPlan =
  | { kind: 'full'; reason: ChatRenderFullReason }
  | { kind: 'append'; resolvedStart: number; evicted: number }

const knownMessageFields: ReadonlySet<string> = new Set([
  'id', 'participant', 'device', 'credential', 'proof', 'name', 'text', 'sentAt', 'sentAtMs', 'kind', 'speaker',
  'attachments', 'artwork', 'owner', 'ownerClaim', 'mentions', 'lane', 'reaction', 'retracts', 'replaces', 'reply',
  'thread', 'invite', 'roomLogo',
])

function ordinaryAddition(message: ChatMessage): boolean {
  return message.reaction === undefined && message.retracts === undefined && message.replaces === undefined &&
    message.reply === undefined && message.thread === undefined && message.invite === undefined && message.roomLogo === undefined &&
    Object.keys(message).every(key => knownMessageFields.has(key))
}

/** Whether an evicted message stands in a row of its own whose removal
 *  cannot change any retained row: something somebody said, not a reaction,
 *  edit or retraction aimed at another message, not a thread reply nested
 *  under a retained root, and not a room-logo override. */
function evictableRow(message: ChatMessage): boolean {
  return isConversation(message) && message.thread === undefined && message.roomLogo === undefined &&
    ordinaryAddition(message)
}

/** How many leading messages of `previous` the retention cap dropped before
 *  `next`: the smallest k whose tail of `previous` is the identity prefix of
 *  `next`. Zero for a pure suffix append. */
function evictedPrefix(previous: readonly ChatMessage[], next: readonly ChatMessage[]): number | undefined {
  for (let k = 0; k < previous.length; k++) {
    const overlap = Math.min(previous.length - k, next.length)
    let matches = true
    for (let i = 0; i < overlap; i++) {
      if (next[i] !== previous[k + i]) { matches = false; break }
    }
    if (matches) return k
  }
  return undefined
}

export function planChatRender(
  previous: ChatRenderSnapshot | undefined,
  next: ChatRenderSnapshot,
  allowAppend: boolean,
): ChatRenderPlan {
  if (!allowAppend || !previous || previous.rawMessages.length === 0) return { kind: 'full', reason: 'no-append' }
  const prev = previous.rawMessages
  const retainedRaw = next.rawMessages
  const evicted = evictedPrefix(prev, retainedRaw)
  if (evicted === undefined) return { kind: 'full', reason: 'identity-prefix' }
  const retained = prev.length - evicted
  const added = retainedRaw.length - retained
  if (added <= 0 || next.system.length !== previous.system.length ||
      next.messageLanes.length !== retainedRaw.length || previous.messageLanes.length !== prev.length) return { kind: 'full', reason: 'not-only-additions' }
  for (let i = 0; i < retained; i++) {
    if (retainedRaw[i] !== prev[evicted + i] || next.messageLanes[i] !== previous.messageLanes[evicted + i]) return { kind: 'full', reason: 'identity-prefix' }
  }
  for (let i = 0; i < next.system.length; i++) {
    if (next.system[i] !== previous.system[i]) return { kind: 'full', reason: 'system-changed' }
  }
  const evictedMessages = prev.slice(0, evicted)
  if (evictedMessages.some(message => !evictableRow(message))) return { kind: 'full', reason: 'non-ordinary-eviction' }
  const additions = retainedRaw.slice(retained)
  if (additions.some(message => !ordinaryAddition(message))) return { kind: 'full', reason: 'non-ordinary-suffix' }
  // A retained reply or thread pointing at an evicted message would paint
  // differently once its target is gone, so eviction cannot stand.
  if (evicted > 0) {
    const gone = new Set(evictedMessages.map(message => refKey({ messageId: message.id, participant: message.participant })))
    for (let i = 0; i < retained; i++) {
      const message = retainedRaw[i]!
      if ((message.reply !== undefined && gone.has(refKey(message.reply))) ||
          (message.thread !== undefined && gone.has(refKey(message.thread)))) return { kind: 'full', reason: 'evicted-reference' }
    }
  }
  const first = additions[0]!
  if (next.system.some(line => line.at >= first.sentAt)) return { kind: 'full', reason: 'system-after-append' }
  const keptKeys = previous.orderedKeys.length - evicted
  if (next.orderedKeys.length !== keptKeys + additions.length) return { kind: 'full', reason: 'ordered-keys' }
  for (let index = 0; index < keptKeys; index++) {
    if (next.orderedKeys[index] !== previous.orderedKeys[evicted + index]) return { kind: 'full', reason: 'ordered-keys' }
  }
  return { kind: 'append', resolvedStart: keptKeys, evicted }
}
