import { describe, it, expect } from 'vitest'
import { refKey, resolveConversation, refOf } from '../../src/messages.js'
import type { ChatMessage } from '../../src/chat.js'
import { quoteSnippet, replyQuoteOf } from './reply-quote.js'

const ADA = 'a'.repeat(64)
const ROWAN = 'b'.repeat(64)
const CRED = { kind: 20460, created_at: 0, tags: [], content: '', pubkey: '', id: '', sig: '' }
const msg = (id: string, participant: string, text: string, sentAt: number, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, participant, device: participant, credential: CRED, text, sentAt, ...extra })
const attachment = (type: string | undefined, name?: string) => ({ url: 'https://files.example/x', sha256: '0'.repeat(64), key: '1'.repeat(64), ...(type ? { type } : {}), ...(name ? { name } : {}) })

describe('quoteSnippet', () => {
  it('is the text on one line', () => {
    expect(quoteSnippet('Shall we  ship\n\non Friday?', {})).toBe('Shall we ship on Friday?')
  })
  it('cuts a long message without splitting a character', () => {
    const out = quoteSnippet('😀'.repeat(200), {})
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(161)
    expect(out).not.toMatch(/[\uD800-\uDBFF]…$/)
  })
  it('names an attachment when there are no words', () => {
    expect(quoteSnippet('', { attachments: [attachment('image/png', 'a.png')] })).toBe('Photo')
    expect(quoteSnippet('', { attachments: [attachment('audio/ogg')] })).toBe('Audio')
    expect(quoteSnippet('', { attachments: [attachment('video/mp4')] })).toBe('Video')
    expect(quoteSnippet('', { attachments: [attachment('application/pdf', 'plan.pdf')] })).toBe('File: plan.pdf')
    expect(quoteSnippet('  ', { attachments: [attachment(undefined)] })).toBe('File: Encrypted file')
  })
  it('prefers the words to the attachment', () => {
    expect(quoteSnippet('See attached', { attachments: [attachment('image/png')] })).toBe('See attached')
  })
})

describe('replyQuoteOf', () => {
  const original = msg('m1', ADA, 'Shall we ship?', 10)
  const reply = msg('m2', ROWAN, 'Yes', 20, { reply: refOf(original), thread: refOf(original) })
  it('is undefined for a message that answers nothing', () => {
    const c = resolveConversation([original])
    expect(replyQuoteOf(c.byKey.get(refKey(refOf(original)))!, c.byKey)).toBeUndefined()
  })
  it('quotes the latest edit of a loaded original', () => {
    const edit = msg('e1', ADA, 'Shall we ship on Friday?', 15, { replaces: 'm1' })
    const c = resolveConversation([original, edit, reply])
    const q = replyQuoteOf(c.byKey.get(refKey(refOf(reply)))!, c.byKey)
    expect(q).toMatchObject({ state: 'ready', snippet: 'Shall we ship on Friday?' })
  })
  it('says deleted when the original was retracted', () => {
    const gone = msg('r1', ADA, 'Retracted a message', 30, { retracts: 'm1' })
    const c = resolveConversation([original, reply, gone])
    expect(replyQuoteOf(c.byKey.get(refKey(refOf(reply)))!, c.byKey)?.state).toBe('deleted')
  })
  it('says missing when the original is not loaded, and still names its author', () => {
    const c = resolveConversation([reply])
    const q = replyQuoteOf(c.byKey.get(refKey(refOf(reply)))!, c.byKey)
    expect(q).toMatchObject({ state: 'missing', ref: { messageId: 'm1', participant: ADA } })
  })
  it('follows thread alone when no reply is named', () => {
    const bare = msg('m3', ROWAN, 'Agreed', 25, { thread: refOf(original) })
    const c = resolveConversation([original, bare])
    expect(replyQuoteOf(c.byKey.get(refKey(refOf(bare)))!, c.byKey)?.state).toBe('ready')
  })
})
