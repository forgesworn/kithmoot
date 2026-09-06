import { describe, it, expect } from 'vitest'
import {
  normaliseMessageRef,
  normaliseMentions,
  normaliseInvite,
  namesInText,
  mentionsOf,
  mentionedBy,
  resolveConversation,
  refOf,
  EVERYONE,
} from './messages.js'
import type { ChatMessage } from './chat.js'

const ADA = 'a'.repeat(64)
const ROWAN = 'b'.repeat(64)
const TALLY = 'c'.repeat(64)
const CRED = { kind: 20460, created_at: 0, tags: [], content: '', pubkey: '', id: '', sig: '' }

function msg(id: string, participant: string, text: string, sentAt: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, participant, device: participant, credential: CRED, text, sentAt, ...extra }
}

describe('message references', () => {
  it('keeps the one honest shape and lower-cases the author', () => {
    expect(normaliseMessageRef({ messageId: 'm1', participant: 'A'.repeat(64) })).toEqual({ messageId: 'm1', participant: ADA })
  })
  it('refuses anything else', () => {
    expect(normaliseMessageRef(null)).toBeNull()
    expect(normaliseMessageRef({ messageId: '', participant: ADA })).toBeNull()
    expect(normaliseMessageRef({ messageId: 'x'.repeat(129), participant: ADA })).toBeNull()
    expect(normaliseMessageRef({ messageId: 'm1', participant: 'not-a-key' })).toBeNull()
    expect(normaliseMessageRef({ messageId: 7, participant: ADA })).toBeNull()
  })
})

describe('mentions', () => {
  it('keeps keys and everyone, deduplicated and normalised, and drops the rest', () => {
    expect(normaliseMentions(['A'.repeat(64), ADA, 'everyone', 'everyone', 'Ada', 7, null])).toEqual([ADA, EVERYONE])
  })
  it('names as a whole word, with or without the @', () => {
    expect(namesInText('morning @Ada', 'Ada')).toBe(true)
    expect(namesInText('Ada, are you there', 'Ada')).toBe(true)
    expect(namesInText('Adam is here', 'Ada')).toBe(false)
    expect(namesInText('madame', 'Ada')).toBe(false)
    expect(namesInText('anything', '  ')).toBe(false)
  })
  it('reads the wire field when there is one, and the text when there is not', () => {
    const roster = [{ participant: ADA, name: 'Ada' }, { participant: ROWAN, name: 'Rowan' }]
    expect(mentionsOf({ text: '@Rowan look', mentions: [ADA] }, roster)).toEqual([ADA])
    expect(mentionsOf({ text: '@Rowan look' }, roster)).toEqual([ROWAN])
    expect(mentionsOf({ text: 'nobody' }, roster)).toEqual([])
  })
  it('a room call addresses people and agents', () => {
    expect(mentionedBy({ text: 'hi', mentions: [EVERYONE] }, ADA)).toBe(true)
    expect(mentionedBy({ text: 'hi', mentions: [EVERYONE] }, TALLY, [], { agent: true })).toBe(true)
    expect(mentionedBy({ text: 'hi', mentions: [TALLY] }, TALLY, [], { agent: true })).toBe(true)
    expect(mentionedBy({ text: '@Tally do it' }, TALLY, [{ participant: TALLY, name: 'Tally' }], { agent: true })).toBe(true)
  })
  it('recognises explicit room calls without broadcasting prose, names or email addresses', () => {
    for (const text of ['@all help', 'Hello @ALL!', '@everyone, please look', 'Thanks @all.']) {
      expect(mentionsOf({ text })).toEqual([EVERYONE])
      expect(mentionedBy({ text }, TALLY, [], { agent: true })).toBe(true)
    }
    for (const text of ['all done', 'everyone is here', '@allison', 'mail@all.example', 'mail+@all.example', '@all.example', '@all-team', '@everyone_else']) {
      expect(mentionsOf({ text })).toEqual([])
    }
    expect(mentionsOf({ text: '@all', mentions: [ADA] })).toEqual([ADA])
    expect(mentionedBy({ text: '@all', mentions: [] }, TALLY, [], { agent: true })).toBe(false)
    const roster = Array.from({ length: 40 }, (_, i) => ({ name: `Person${i}`, participant: i.toString(16).padStart(64, '0') }))
    expect(mentionsOf({ text: `${roster.map(p => `@${p.name}`).join(' ')} @all` }, roster).slice(0, 32)).toContain(EVERYONE)
  })
})

describe('invitations', () => {
  it('keeps the honest shape', () => {
    expect(normaliseInvite({ to: 'B'.repeat(64), room: 'C'.repeat(64), link: 'cipher' })).toEqual({ to: ROWAN, room: TALLY, link: 'cipher' })
    expect(normaliseInvite({ to: ROWAN, room: TALLY, link: '' })).toBeNull()
    expect(normaliseInvite({ to: 'rowan', room: TALLY, link: 'x' })).toBeNull()
    expect(normaliseInvite({ to: ROWAN, room: TALLY, link: 'x'.repeat(8193) })).toBeNull()
  })
})

describe('resolveConversation', () => {
  it('shows the latest edit on the original frame and keeps the chain', () => {
    const original = msg('m1', ADA, 'helo', 100)
    const first = msg('e1', ADA, 'hello', 110, { replaces: 'm1' })
    const second = msg('e2', ADA, 'hello there', 120, { replaces: 'm1', mentions: [ROWAN] })
    const { stream } = resolveConversation([second, original, first])
    expect(stream).toHaveLength(1)
    expect(stream[0]!.shown.text).toBe('hello there')
    expect(stream[0]!.shown.id).toBe('m1')
    expect(stream[0]!.shown.sentAt).toBe(100)
    expect(stream[0]!.shown.mentions).toEqual([ROWAN])
    expect(stream[0]!.edited).toBe(true)
    expect(stream[0]!.edits.map((e) => e.id)).toEqual(['e1', 'e2'])
  })

  it('later wins on time, then on id, and an edit of an edit lands on the original', () => {
    const original = msg('m1', ADA, 'one', 100)
    const a = msg('e-a', ADA, 'two', 110, { replaces: 'm1' })
    const b = msg('e-b', ADA, 'three', 110, { replaces: 'e-a' })
    const { stream } = resolveConversation([original, a, b])
    expect(stream[0]!.shown.text).toBe('three')
    expect(stream[0]!.edits).toHaveLength(2)
  })

  it('ignores an edit by somebody else, which becomes its own message marked edited', () => {
    const original = msg('m1', ADA, 'mine', 100)
    const forged = msg('e1', ROWAN, 'theirs', 110, { replaces: 'm1' })
    const { stream } = resolveConversation([original, forged])
    expect(stream).toHaveLength(2)
    expect(stream[0]!.shown.text).toBe('mine')
    expect(stream[0]!.edited).toBe(false)
    expect(stream[1]!.shown.text).toBe('theirs')
    expect(stream[1]!.edited).toBe(true)
  })

  it('an edit whose original is not loaded stands in for it', () => {
    const edit = msg('e1', ADA, 'corrected', 110, { replaces: 'gone' })
    const { stream } = resolveConversation([edit])
    expect(stream).toHaveLength(1)
    expect(stream[0]!.edited).toBe(true)
    expect(stream[0]!.shown.text).toBe('corrected')
  })

  it('a retraction hides the original and beats every edit', () => {
    const original = msg('m1', ADA, 'oops', 100)
    const edit = msg('e1', ADA, 'still oops', 130, { replaces: 'm1' })
    const retract = msg('r1', ADA, 'Retracted a message', 120, { retracts: 'm1' })
    const { stream } = resolveConversation([original, edit, retract])
    expect(stream).toHaveLength(1)
    expect(stream[0]!.retracted).toBe(true)
  })

  it('a retraction by somebody else does nothing', () => {
    const original = msg('m1', ADA, 'stays', 100)
    const retract = msg('r1', ROWAN, 'Retracted a message', 120, { retracts: 'm1' })
    const { stream } = resolveConversation([original, retract])
    expect(stream).toHaveLength(1)
    expect(stream[0]!.retracted).toBe(false)
  })

  it('nests replies under a loaded root and keeps replies to a retracted root', () => {
    const root = msg('m1', ADA, 'question', 100)
    const reply = msg('m2', ROWAN, 'answer', 110, { reply: refOf(root), thread: refOf(root) })
    const deeper = msg('m3', ADA, 'thanks', 120, { reply: refOf(reply), thread: refOf(root) })
    const retract = msg('r1', ADA, 'Retracted a message', 130, { retracts: 'm1' })
    const { stream, byKey } = resolveConversation([deeper, reply, root, retract])
    expect(stream).toHaveLength(1)
    expect(stream[0]!.retracted).toBe(true)
    expect(stream[0]!.replies.map((r) => r.original.id)).toEqual(['m2', 'm3'])
    expect(byKey.get(`${ADA}:m3`)!.reply).toEqual(refOf(reply))
  })

  it('a reply with no thread field takes its parent as the root, walking up to the top', () => {
    const root = msg('m1', ADA, 'root', 100)
    const child = msg('m2', ROWAN, 'child', 110, { reply: refOf(root) })
    const grandchild = msg('m3', ADA, 'grandchild', 120, { reply: refOf(child) })
    const { stream } = resolveConversation([root, child, grandchild])
    expect(stream).toHaveLength(1)
    expect(stream[0]!.replies.map((r) => r.original.id)).toEqual(['m2', 'm3'])
    expect(stream[0]!.replies[1]!.thread).toEqual(refOf(root))
  })

  it('a reply whose root is not loaded stays in the stream, marked', () => {
    const reply = msg('m2', ROWAN, 'answer', 110, { thread: { messageId: 'gone', participant: ADA } })
    const { stream } = resolveConversation([reply])
    expect(stream).toHaveLength(1)
    expect(stream[0]!.orphan).toBe(true)
    expect(stream[0]!.thread).toEqual({ messageId: 'gone', participant: ADA })
  })

  it('leaves reactions and invitations out of the conversation', () => {
    const root = msg('m1', ADA, 'hi', 100)
    const reaction = msg('x1', ROWAN, 'Reacted', 110, { reaction: { messageId: 'm1', participant: ADA, emoji: '👍', active: true, revision: 1 } })
    const invite = msg('i1', ROWAN, 'Started a private conversation', 120, { invite: { to: ADA, room: TALLY, link: 'c' } })
    const { stream } = resolveConversation([root, reaction, invite])
    expect(stream.map((m) => m.original.id)).toEqual(['m1'])
  })

  it('does not loop on a message that names itself as its thread', () => {
    const loop = msg('m1', ADA, 'ouroboros', 100, { thread: { messageId: 'm1', participant: ADA } })
    const { stream } = resolveConversation([loop])
    expect(stream).toHaveLength(1)
    expect(stream[0]!.orphan).toBe(true)
  })
})
