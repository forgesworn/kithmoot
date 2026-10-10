import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../src/chat.js'
import type { DeviceCredential } from '../../src/types.js'
import { workspaceMentions } from './workspace-work.js'

const ada = 'a'.repeat(64), bob = 'b'.repeat(64), worker = 'c'.repeat(64)
const room = { roomId: 'd'.repeat(64), link: 'unused', openedAt: 1, readAt: 0 }
const people = [{ participant: ada, name: 'Ada' }, { participant: bob, name: 'Bob' }, { participant: worker, name: 'Tally', agent: true }]
const message = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, text, participant: bob, device: 'e'.repeat(64), credential: {} as DeviceCredential, sentAt: 100, ...extra,
})

describe('workspace human attention', () => {
  it('includes human mentions and replies while routine and agent chatter stay outside the Inbox', () => {
    const messages = [message('mention', 'Check this', { mentions: [ada] }), message('reply', 'Done', { reply: { participant: ada, messageId: 'older-root' } }),
      message('routine', 'Still working'), message('agent', 'Check this', { participant: worker, mentions: [ada] }), message('self', 'My own message', { participant: ada, mentions: [ada] })]
    expect(workspaceMentions(messages, ada, room, people).map(item => [item.ref.messageId, item.reason])).toEqual([
      ['mention', 'Mentioned you'], ['reply', 'Reply to you'],
    ])
  })
  it('uses the canonical latest edit and author-bound retraction instead of the original preview', () => {
    const original = message('original', 'Check this', { mentions: [ada] })
    const edit = message('edit', 'Routine progress now', { replaces: original.id, sentAt: 101 })
    expect(workspaceMentions([original, edit], ada, room, people)).toEqual([])
    const forgedRetraction = message('forged', '', { participant: worker, retracts: original.id, sentAt: 102 })
    expect(workspaceMentions([original, forgedRetraction], ada, room, people).map(item => item.text)).toEqual(['Check this'])
    const retraction = message('retract', '', { retracts: original.id, sentAt: 103 })
    expect(workspaceMentions([original, retraction], ada, room, people)).toEqual([])
  })
  it('includes nested replies and excludes exactly seen messages at a shared timestamp', () => {
    const root = message('root', 'A root', { participant: ada })
    const seen = message('seen', 'Already read', { reply: { participant: ada, messageId: root.id } })
    const unseen = message('unseen', 'New reply', { reply: { participant: ada, messageId: root.id } })
    expect(workspaceMentions([root, seen, unseen], ada, { ...room, readAt: 100, readIds: ['seen'] }, people).map(item => item.ref.messageId)).toEqual(['unseen'])
  })
})
