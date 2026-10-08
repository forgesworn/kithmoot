import type { ChatMessage } from './chat.js'
import { isReactionEmoji } from './emoji-catalog.js'
import { compareMessages } from './message-order.js'

// Keep the quick palette stable; the full picker uses the Unicode catalogue.
export const REACTION_EMOJIS = ['👍', '❤️', '🤦', '😂', '🎉', '👀', '🙏', '😢', '💯'] as const
export interface ChatReaction {
  messageId: string
  participant: string
  emoji: string
  active: boolean
  /** Monotonic per reacting participant, target and emoji; resolves fast toggles. */
  revision: number
  /** Automatic receipt by an agent's room connection, not model completion. */
  receipt?: 'received'
}

export function normaliseReaction(value: unknown): ChatReaction | null {
  if (!value || typeof value !== 'object') return null
  const r = value as ChatReaction
  if (typeof r.messageId !== 'string' || !r.messageId.length || r.messageId.length > 128 ||
      typeof r.participant !== 'string' || !/^[0-9a-fA-F]{64}$/.test(r.participant) ||
      !isReactionEmoji(r.emoji) || typeof r.active !== 'boolean' ||
      !Number.isSafeInteger(r.revision) || r.revision < 1 || r.revision > 2_147_483_647) return null
  if (r.receipt !== undefined && r.receipt !== 'received') return null
  return { messageId: r.messageId, participant: r.participant.toLowerCase(), emoji: r.emoji, active: r.active, revision: r.revision, ...(r.receipt ? { receipt: r.receipt } : {}) }
}

/** Input is verified chat from ONE conversation. A participant changes only their own vote. */
export function reactionsFor(messages: readonly ChatMessage[], target: Pick<ChatMessage, 'id' | 'participant'>): Map<string, ChatMessage[]> {
  const latest = new Map<string, ChatMessage>()
  for (const m of messages) {
    const r = m.reaction
    if (!r || r.messageId !== target.id || r.participant !== target.participant) continue
    const key = `${m.participant}:${r.emoji}`
    const old = latest.get(key)
    if (!old || r.revision > old.reaction!.revision ||
        (r.revision === old.reaction!.revision && compareMessages(m, old) > 0)) latest.set(key, m)
  }
  const result = new Map<string, ChatMessage[]>()
  for (const emoji of REACTION_EMOJIS) result.set(emoji, [])
  for (const m of latest.values()) {
    const emoji = m.reaction!.emoji
    if (!result.has(emoji)) result.set(emoji, [])
    result.get(emoji)!.push(m)
  }
  return result
}

export function toggleReaction(messages: readonly ChatMessage[], target: Pick<ChatMessage, 'id' | 'participant'>, self: string, emoji: string): ChatReaction {
  const mine = reactionsFor(messages, target).get(emoji)?.find(m => m.participant === self)?.reaction
  const result = normaliseReaction({ messageId: target.id, participant: target.participant, emoji, active: !mine?.active, revision: (mine?.revision ?? 0) + 1 })
  if (!result) throw new Error('This reaction cannot be updated')
  return result
}

export function reactionText(reaction: ChatReaction): string {
  return `${reaction.active ? 'Reacted' : 'Removed reaction'} ${reaction.emoji} ${reaction.active ? 'to' : 'from'} message ${reaction.messageId}`
}
