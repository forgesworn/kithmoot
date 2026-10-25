import { describe, expect, it } from 'vitest'
import type { ChatMessage } from './chat.js'
import { compareMessages } from './message-order.js'
import { createReactionIndex, REACTION_EMOJIS, reactionsFor, toggleReaction } from './reactions.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const target = { id: 'shared', participant: A } as ChatMessage

function update(id: string, reactor: string, addressed: Pick<ChatMessage, 'id' | 'participant'>, emoji: string, revision: number, active = true, sentAt = 10): ChatMessage {
  return {
    ...target,
    id,
    participant: reactor,
    sentAt,
    reaction: { messageId: addressed.id, participant: addressed.participant, emoji, revision, active },
  } as ChatMessage
}

function referenceReactionsFor(messages: readonly ChatMessage[], addressed: Pick<ChatMessage, 'id' | 'participant'>): Map<string, ChatMessage[]> {
  const latest = new Map<string, ChatMessage>()
  for (const message of messages) {
    const reaction = message.reaction
    if (!reaction || reaction.messageId !== addressed.id || reaction.participant !== addressed.participant) continue
    const key = `${message.participant}:${reaction.emoji}`
    const old = latest.get(key)
    if (!old || reaction.revision > old.reaction!.revision ||
        (reaction.revision === old.reaction!.revision && compareMessages(message, old) > 0)) latest.set(key, message)
  }
  const result = new Map<string, ChatMessage[]>()
  for (const emoji of REACTION_EMOJIS) result.set(emoji, [])
  for (const message of latest.values()) {
    const emoji = message.reaction!.emoji
    if (!result.has(emoji)) result.set(emoji, [])
    result.get(emoji)!.push(message)
  }
  return result
}

describe('reaction index', () => {
  it('is equivalent to independent per-target scans, including ordering and tie-breaking', () => {
    const otherTarget = { ...target, participant: B }
    const otherMessage = { ...target, id: 'different' }
    const thumb = update('thumb', A, target, '👍', 1)
    const removed = update('removed', A, target, '👍', 2, false)
    const tiedWinner = update('z-tie', A, target, '❤️', 2, true, 11)
    const tiedLoser = update('a-tie', A, target, '❤️', 2, false, 11)
    const messages = [
      thumb,
      update('custom', B, target, '🦄', 1),
      tiedLoser,
      update('heart', A, target, '❤️', 1),
      removed,
      update('other-thumb', B, target, '👍', 1),
      update('other-target', A, otherTarget, '👍', 1),
      update('other-message', A, otherMessage, '👍', 1),
      tiedWinner,
      removed,
    ]
    const index = createReactionIndex(messages)
    for (const addressed of [target, otherTarget, otherMessage, { id: 'missing', participant: A }]) {
      expect([...index.for(addressed)]).toEqual([...referenceReactionsFor(messages, addressed)])
      expect([...index.for(addressed)]).toEqual([...reactionsFor(messages, addressed)])
    }
    expect([...index.for(target).keys()]).toEqual([...REACTION_EMOJIS, '🦄'])
    expect(index.for(target).get('❤️')).toEqual([tiedWinner])
    expect(index.for(target).get('👍')).toEqual([removed, messages[5]])
    expect(index.for(target).get('🦄')).toEqual([messages[1]])
  })

  it('keeps lookups isolated from caller mutations and preserves toggle revisions', () => {
    const add = update('add', A, target, '👍', 1)
    const index = createReactionIndex([add])
    const first = index.for(target)
    first.get('👍')!.length = 0
    first.set('🦄', [])
    expect(index.for(target).get('👍')).toEqual([add])
    expect(index.for(target).has('🦄')).toBe(false)
    expect(toggleReaction([add], target, A, '👍')).toMatchObject({ active: false, revision: 2 })
  })
})
