import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../src/chat.js'
import { refKey } from '../../src/messages.js'
import { planChatRender, type ChatRenderSnapshot } from './chat-render-plan.js'

const participant = 'ab'.repeat(32)
function message(id: string, sentAt = 1, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, participant, text: id, sentAt, ...extra } as ChatMessage
}
function key(message: ChatMessage): string {
  return refKey({ messageId: message.id, participant: message.participant })
}
function snapshot(rawMessages: ChatMessage[], system: { at: number }[] = [], orderedKeys?: string[], messageLanes?: ChatMessage['lane'][]): ChatRenderSnapshot {
  // Like the app: resolved keys exclude statements about other messages and
  // are sorted the way `compareMessages` sorts the log.
  const keys = rawMessages
    .filter(m => m.reaction === undefined && m.retracts === undefined && m.replaces === undefined && m.invite === undefined)
    .sort((a, b) => ((a.sentAtMs ?? a.sentAt * 1000) - (b.sentAtMs ?? b.sentAt * 1000)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(key)
  return { rawMessages, messageLanes: messageLanes ?? rawMessages.map(m => m.lane), orderedKeys: orderedKeys ?? keys, system }
}

describe('chat render planning', () => {
  it('appends only from a ChatLog change with an identity prefix and resolved suffix', () => {
    const first = message('first')
    const second = message('second', 2)
    const previous = snapshot([first])
    const next = snapshot([first, second])
    expect(planChatRender(previous, next, true)).toEqual({ kind: 'append', resolvedStart: 1, evicted: 0 })
    expect(planChatRender(previous, next, false)).toEqual({ kind: 'full', reason: 'no-append' })
    expect(planChatRender(undefined, next, true)).toEqual({ kind: 'full', reason: 'no-append' })
    expect(planChatRender(snapshot([], [], []), next, true)).toEqual({ kind: 'full', reason: 'no-append' })
  })

  it('rebuilds for replacement, prepend, out-of-order insertion, removal and in-place-only changes', () => {
    const first = message('first')
    const second = message('second', 2)
    const previous = snapshot([first, second])
    expect(planChatRender(previous, snapshot([{ ...first }, second, message('third', 3)]), true)).toEqual({ kind: 'full', reason: 'identity-prefix' })
    expect(planChatRender(previous, snapshot([message('older', 0), first, second]), true)).toEqual({ kind: 'full', reason: 'identity-prefix' })
    // A reorder can look like an eviction to the identity scan; the sorted
    // resolved keys catch it.
    expect(planChatRender(previous, snapshot([second, first, message('third', 3)]), true)).toEqual({ kind: 'full', reason: 'ordered-keys' })
    expect(planChatRender(previous, snapshot([first]), true)).toEqual({ kind: 'full', reason: 'not-only-additions' })
    expect(planChatRender(previous, snapshot([first, second]), true)).toEqual({ kind: 'full', reason: 'not-only-additions' })
    expect(planChatRender(previous, snapshot([first, second, message('third', 3)], [], undefined, ['public', undefined, undefined]), true)).toEqual({ kind: 'full', reason: 'identity-prefix' })
  })

  it('rebuilds when a system line changes or would have to move below an appended message', () => {
    const first = message('first')
    const line = { at: 1 }
    const previous = snapshot([first], [line])
    expect(planChatRender(previous, snapshot([first, message('second', 2)], [line]), true)).toEqual({ kind: 'append', resolvedStart: 1, evicted: 0 })
    expect(planChatRender(previous, snapshot([first, message('second', 2)], [{ at: 1 }]), true)).toEqual({ kind: 'full', reason: 'system-changed' })
    expect(planChatRender(previous, snapshot([first, message('second', 2)], [line, { at: 2 }]), true)).toEqual({ kind: 'full', reason: 'not-only-additions' })
    expect(planChatRender(previous, snapshot([first, message('second', 1)], [line]), true)).toEqual({ kind: 'full', reason: 'system-after-append' })
  })

  it('rebuilds for every suffix statement that can change another row or room state', () => {
    const first = message('first')
    const previous = snapshot([first])
    const reaction = { messageId: first.id, participant, emoji: '👍', active: true, revision: 1 }
    const ref = { messageId: first.id, participant }
    const additions: Partial<ChatMessage>[] = [
      { reaction }, { reaction: { ...reaction, receipt: 'received' } }, { retracts: first.id }, { replaces: first.id },
      { reply: ref }, { thread: ref }, { invite: {} as ChatMessage['invite'] }, { roomLogo: null },
    ]
    for (const extra of additions) {
      expect(planChatRender(previous, snapshot([first, message('second', 2, extra)]), true)).toEqual({ kind: 'full', reason: 'non-ordinary-suffix' })
    }
    const unexpected = Object.assign(message('second', 2), { statusChangingMetadata: true })
    expect(planChatRender(previous, snapshot([first, unexpected]), true)).toEqual({ kind: 'full', reason: 'non-ordinary-suffix' })
  })

  it('checks resolved keys after every other append condition', () => {
    const first = message('first')
    const second = message('second', 2)
    const previous = snapshot([first])
    const oldKey = key(first)
    const newKey = key(second)
    expect(planChatRender(previous, snapshot([first, second], [], [newKey, oldKey]), true)).toEqual({ kind: 'full', reason: 'ordered-keys' })
    expect(planChatRender(previous, snapshot([first, second], [], [oldKey]), true)).toEqual({ kind: 'full', reason: 'ordered-keys' })
    expect(planChatRender(previous, snapshot([first, second], [], [oldKey, newKey, 'extra']), true)).toEqual({ kind: 'full', reason: 'ordered-keys' })
    expect(planChatRender(previous, snapshot([first, second], [], [oldKey, newKey]), true)).toEqual({ kind: 'append', resolvedStart: 1, evicted: 0 })
  })

  it('evicts and appends when the retention cap drops leading ordinary rows', () => {
    const first = message('first')
    const second = message('second', 2)
    const third = message('third', 3)
    const fourth = message('fourth', 4)
    const previous = snapshot([first, second, third])
    // One ordinary row out, one ordinary row in: remove the first row, paint the last.
    expect(planChatRender(previous, snapshot([second, third, fourth]), true))
      .toEqual({ kind: 'append', resolvedStart: 2, evicted: 1 })
    // Several out, several in.
    expect(planChatRender(previous, snapshot([third, fourth, message('fifth', 5)]), true))
      .toEqual({ kind: 'append', resolvedStart: 1, evicted: 2 })
    // Evicting everything is a rebuild: nothing anchors the retained suffix.
    expect(planChatRender(previous, snapshot([fourth, message('fifth', 5), message('sixth', 6)]), true)).toEqual({ kind: 'full', reason: 'identity-prefix' })
    // Shrink without additions is not an append.
    expect(planChatRender(previous, snapshot([second, third]), true)).toEqual({ kind: 'full', reason: 'not-only-additions' })
  })

  it('rebuilds when an evicted statement is not a standalone row', () => {
    const root = message('root', 0.5)
    const threadRef = { messageId: root.id, participant }
    const threadReply = message('thread-reply', 1, { thread: threadRef, reply: threadRef })
    const second = message('second', 2)
    const third = message('third', 3)
    const fourth = message('fourth', 4)
    // The thread reply leads the window; dropping its row is not something
    // eviction can do without recomputing the rows retained around it.
    expect(planChatRender(snapshot([threadReply, second, third]), snapshot([second, third, fourth]), true))
      .toEqual({ kind: 'full', reason: 'non-ordinary-eviction' })
  })

  it('rebuilds when a retained reply or thread points at an evicted message', () => {
    const first = message('first')
    const second = message('second', 2)
    const third = message('third', 3)
    const reply = message('reply', 4, { reply: { messageId: first.id, participant } })
    expect(planChatRender(snapshot([first, second, third, reply]), snapshot([second, third, reply, message('fifth', 5)]), true))
      .toEqual({ kind: 'full', reason: 'evicted-reference' })
  })

  it('evicts and appends around replies whose targets stay in the window', () => {
    const first = message('first')
    const second = message('second', 2)
    const reply = message('reply', 3, { reply: { messageId: second.id, participant } })
    const third = message('third', 4)
    const fourth = message('fourth', 5)
    expect(planChatRender(snapshot([first, second, reply, third]), snapshot([second, reply, third, fourth]), true))
      .toEqual({ kind: 'append', resolvedStart: 3, evicted: 1 })
  })

  it('keeps lane checks across the retained overlap under eviction', () => {
    const first = message('first')
    const second = message('second', 2)
    const third = message('third', 3)
    const fourth = message('fourth', 4)
    const previous = snapshot([first, second, third], [], undefined, ['public', 'sheltered', 'direct'])
    expect(planChatRender(previous, snapshot([second, third, fourth], [], undefined, ['sheltered', 'direct', undefined]), true))
      .toEqual({ kind: 'append', resolvedStart: 2, evicted: 1 })
    expect(planChatRender(previous, snapshot([second, third, fourth], [], undefined, [undefined, 'direct', undefined]), true))
      .toEqual({ kind: 'full', reason: 'identity-prefix' })
  })
})
