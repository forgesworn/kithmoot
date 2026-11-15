import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../src/chat.js'
import { resolveConversation } from '../../src/messages.js'
import { editableBy, latestEditable } from './composer-edit.js'

const ADA = 'a'.repeat(64)
const ROWAN = 'b'.repeat(64)
const CRED = { kind: 20460, created_at: 0, tags: [], content: '', pubkey: '', id: '', sig: '' }

function msg(id: string, participant: string, text: string, sentAt: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, participant, device: participant, credential: CRED, text, sentAt, ...extra }
}

const latest = (messages: ChatMessage[], me = ADA) => latestEditable(resolveConversation(messages).byKey.values(), me)

describe('Up in an empty composer', () => {
  it('edits your newest message, even when someone wrote after it', () => {
    const found = latest([
      msg('m1', ADA, 'first', 10),
      msg('m2', ADA, 'second', 20),
      msg('m3', ROWAN, 'a reply from Rowan', 30),
    ])
    expect(found?.original.id).toBe('m2')
  })

  it('orders as the log does, to the millisecond and then by id', () => {
    expect(latest([msg('m9', ADA, 'later', 10, { sentAtMs: 10_900 }), msg('m1', ADA, 'earlier', 10, { sentAtMs: 10_100 })])?.original.id).toBe('m9')
    expect(latest([msg('mb', ADA, 'b', 10), msg('ma', ADA, 'a', 10)])?.original.id).toBe('mb')
  })

  it('loads the latest wording of an edited message', () => {
    const found = latest([msg('m1', ADA, 'typo', 10), msg('e1', ADA, 'fixed', 15, { replaces: 'm1' })])
    expect(found?.original.id).toBe('m1')
    expect(found?.shown.text).toBe('fixed')
  })

  it('skips retracted messages and kinds the menu offers no Edit on', () => {
    const found = latest([
      msg('m1', ADA, 'keep', 10),
      msg('m2', ADA, 'gone', 20),
      msg('r2', ADA, '', 21, { retracts: 'm2' }),
      msg('m3', ADA, 'heard on the call', 30, { kind: 'transcript' }),
      msg('m4', ADA, 'a directive', 40, { kind: 'directive' }),
    ])
    expect(found?.original.id).toBe('m1')
  })

  it('finds nothing when you have not written, or nobody is signed in', () => {
    expect(latest([msg('m1', ROWAN, 'only Rowan', 10)])).toBeUndefined()
    expect(latest([msg('m1', ADA, 'mine', 10)], '')).toBeUndefined()
    expect(latest([])).toBeUndefined()
  })

  it('matches what the message menu offers', () => {
    const [resolved] = resolveConversation([msg('m1', ADA, 'mine', 10)]).byKey.values()
    expect(editableBy(resolved!, ADA)).toBe(true)
    expect(editableBy(resolved!, ROWAN)).toBe(false)
  })
})
