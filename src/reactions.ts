import type { ChatMessage } from './chat.js'

// Nine choices, in the order they are offered, and the order is the one a
// person has learned: 💯 was added at the end rather than beside 👍, so that
// nobody's thumb lands on a different reaction than it did yesterday.
//
// This list is also the allow-list `normaliseReaction` checks, which makes
// adding to it a compatibility event in one direction: a client that has
// not updated drops a 💯 it is sent rather than showing an unknown mark.
// Adding is therefore safe and removing never is.
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
      !(REACTION_EMOJIS as readonly unknown[]).includes(r.emoji) || typeof r.active !== 'boolean' ||
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
        (r.revision === old.reaction!.revision && (m.sentAt > old.sentAt || (m.sentAt === old.sentAt && m.id > old.id)))) latest.set(key, m)
  }
  const result = new Map<string, ChatMessage[]>()
  for (const emoji of REACTION_EMOJIS) result.set(emoji, [...latest.values()].filter(m => m.reaction!.emoji === emoji))
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
