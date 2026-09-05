import type { ChatMessage } from './chat.js'

export const REACTION_EMOJIS = ['👍', '❤️', '🤦', '😂', '🎉', '👀', '🙏', '😢'] as const
export interface ChatReaction {
  messageId: string
  participant: string
  emoji: string
  active: boolean
  /** Monotonic per reacting participant, target and emoji; resolves fast toggles. */
  revision: number
}

export function normaliseReaction(value: unknown): ChatReaction | null {
  if (!value || typeof value !== 'object') return null
  const r = value as ChatReaction
  if (typeof r.messageId !== 'string' || !r.messageId.length || r.messageId.length > 128 ||
      typeof r.participant !== 'string' || !/^[0-9a-fA-F]{64}$/.test(r.participant) ||
      !(REACTION_EMOJIS as readonly unknown[]).includes(r.emoji) || typeof r.active !== 'boolean' ||
      !Number.isSafeInteger(r.revision) || r.revision < 1 || r.revision > 2_147_483_647) return null
  return { messageId: r.messageId, participant: r.participant.toLowerCase(), emoji: r.emoji, active: r.active, revision: r.revision }
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
