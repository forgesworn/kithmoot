import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { unwrapEvent } from 'nostr-tools/nip17'
import { NostrMessage, nostrMessageRecipient, type NostrMessageIdentity } from './nostr-message.js'

function fixture(rememberCopy?: (event: Event, current: () => boolean) => Promise<void>) {
  const sender = generateSecretKey(), recipient = generateSecretKey(), self = getPublicKey(sender), peer = getPublicKey(recipient)
  const now = Math.floor(Date.now() / 1000), wire: Event[] = [], encrypted: string[] = [], signed: number[] = []
  let live = true, blocked = false, reject = false, mode: 'good' | 'forged' | 'refuse-copy' = 'good'
  let beforeEncrypt = async () => {}
  const rejectRecipients = new Set<string>()
  const list = (author: Uint8Array, url: string, at = now) => finalizeEvent({ kind: 10050, created_at: at,
    content: '', tags: url ? [['relay', url]] : [] }, author)
  let statements: Event[] = [list(sender, 'wss://sender.example'), list(recipient, 'wss://recipient.example')]
  const identity: NostrMessageIdentity = { pubkey: self,
    encrypt: async (to, text, current) => {
      await beforeEncrypt(); if (!current()) throw Error('cancelled')
      encrypted.push(to)
      if (mode === 'refuse-copy' && to === self) throw Error('refused')
      return nip44.v2.encrypt(text, nip44.v2.utils.getConversationKey(sender, to))
    },
    signEvent: async (template, current) => {
      if (!current()) throw Error('cancelled')
      signed.push(template.kind)
      return finalizeEvent(mode === 'forged' ? { ...template, content: 'substituted' } : template, sender)
    },
  }
  const message = new NostrMessage({ identity, current: () => live, blocked: () => blocked,
    lookup: async () => statements, publish: async (event, relays, current) => {
      if (!current()) throw Error('cancelled')
      expect(relays).toEqual(event.tags[0]![1] === self ? ['wss://sender.example/'] : ['wss://recipient.example/'])
      wire.push(event)
      if (reject || rejectRecipients.has(event.tags[0]![1]!)) throw Error('lost ACK')
    }, rememberCopy, changed: () => {}, now: () => now })
  return { sender, recipient, self, peer, now, wire, encrypted, signed, message, list,
    replace: (rows: Event[]) => { statements = rows }, stop: () => { live = false }, block: () => { blocked = true },
    reject: (value: boolean) => { reject = value }, mode: (value: typeof mode) => { mode = value },
    rejectRecipient: (key: string, value: boolean) => { if (value) rejectRecipients.add(key); else rejectRecipients.delete(key) },
    beforeEncrypt: (work: () => Promise<void>) => { beforeEncrypt = work } }
}
describe('separate ordinary Nostr text message', () => {
  it('keeps the exact sender copy before either publish and binds a public reply to its parent rumor', async () => {
    let kept: Event | undefined, writesAtKeep = -1
    const f = fixture(async (event, current) => { expect(current()).toBe(true); kept = event; writesAtKeep = f.wire.length })
    await f.message.review(f.peer, 'An ordinary reply', 'a'.repeat(64)); await f.message.send()
    expect(writesAtKeep).toBe(0); expect(kept?.id).toBe(f.wire[1]?.id)
    expect(unwrapEvent(f.wire[0]!, f.recipient).tags).toEqual([['p', f.peer], ['e', 'a'.repeat(64)]])
  })
  it('does not publish either prepared envelope when the encrypted-copy write is refused', async () => {
    const f = fixture(async () => { throw Error('Synthetic quota failure') })
    await f.message.review(f.peer, 'Held for retained history'); await f.message.send()
    expect(f.wire).toEqual([]); expect(f.message.snapshot().status).toContain('Nothing was sent')
  })
  it('cannot publish after the account closes while its encrypted-copy writer lock is pending', async () => {
    let release!: () => void, reached!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { reached = resolve })
    const f = fixture(async () => { reached(); await pending })
    await f.message.review(f.peer, 'Cancelled before publishing')
    const sending = f.message.send()
    // Wait for the actual copy callback, not a timing guess about encryption.
    await entered
    f.stop(); release(); await sending; expect(f.wire).toEqual([])
  })
  it('requires explicit send, wraps one unsigned rumor for recipient and sender, and never sends kind4 or an invitation', async () => {
    const f = fixture()
    await f.message.review(f.peer, 'Exact ordinary Nostr text')
    expect(f.wire).toEqual([]); expect(f.encrypted).toEqual([]); expect(f.signed).toEqual([])
    await f.message.send()
    expect(f.wire.map(event => event.kind)).toEqual([1059, 1059]); expect(f.signed).toEqual([13, 13])
    const received = unwrapEvent(f.wire[0]!, f.recipient), copy = unwrapEvent(f.wire[1]!, f.sender)
    expect(received).toEqual(copy)
    expect(received).toMatchObject({ kind: 14, pubkey: f.self, content: 'Exact ordinary Nostr text', tags: [['p', f.peer]], created_at: f.now })
    expect(received).not.toHaveProperty('sig')
    expect(f.wire[0]!.pubkey).not.toBe(f.self); expect(f.wire[0]!.pubkey).not.toBe(f.wire[1]!.pubkey)
    expect(f.message.snapshot().status).toContain('does not confirm')
    await f.message.send(); expect(f.wire).toHaveLength(2)
  })
  it('holds when either published inbox is absent, with no default or NIP65 destination substitution', async () => {
    for (const missing of ['sender', 'recipient'] as const) {
      const f = fixture()
      f.replace([f.list(missing === 'sender' ? f.recipient : f.sender, 'wss://recipient.example')])
      await f.message.review(f.peer, 'Not sent'); await f.message.send()
      expect(f.message.snapshot().review).toBeUndefined(); expect(f.wire).toEqual([]); expect(f.signed).toEqual([])
    }
  })
  it('honours a newer empty inbox list rather than an old usable list', async () => {
    const f = fixture()
    f.replace([f.list(f.sender, 'wss://sender.example'), f.list(f.recipient, 'wss://recipient.example', f.now - 1), f.list(f.recipient, '')])
    await f.message.review(f.peer, 'Not sent'); await f.message.send(); expect(f.wire).toEqual([])
    expect(f.message.snapshot().status).toContain('No usable published')
  })
  it('does not trust a cached verification marker on a forged relay list', async () => {
    const f = fixture(), forged = f.list(f.recipient, 'wss://recipient.example')
    forged.content = 'changed after signing'
    f.replace([f.list(f.sender, 'wss://sender.example'), forged])
    await f.message.review(f.peer, 'Not sent'); await f.message.send(); expect(f.wire).toEqual([])
  })
  for (const refusal of ['forged', 'refuse-copy'] as const) it(`sends neither half after ${refusal}`, async () => {
    const f = fixture(); f.mode(refusal)
    await f.message.review(f.peer, 'Not sent'); await f.message.send()
    expect(f.wire).toEqual([]); expect(f.message.snapshot().status).toContain('Nothing was sent')
  })
  it('stops at a changed account while encryption is pending', async () => {
    const f = fixture(); let release!: () => void
    f.beforeEncrypt(() => new Promise<void>(resolve => { release = resolve }))
    await f.message.review(f.peer, 'Never publish stale work')
    const sending = f.message.send(); f.stop(); release(); await sending
    expect(f.wire).toEqual([]); expect(f.signed).toEqual([]); expect(f.message.snapshot().review).toBeUndefined()
  })
  it('refuses a newly blocked recipient before any signer request', async () => {
    const f = fixture(); await f.message.review(f.peer, 'Not sent'); f.block(); await f.message.send()
    expect(f.wire).toEqual([]); expect(f.encrypted).toEqual([])
  })
  it('requires manual retry and reuses exact uncertain envelopes', async () => {
    const f = fixture(); f.reject(true)
    await f.message.review(f.peer, 'Same encrypted retry'); await f.message.send()
    const first = [...f.wire]; expect(f.message.snapshot().retry).toBe(true)
    expect(f.message.snapshot().status).toContain('may have arrived')
    f.reject(false); await f.message.send()
    expect(f.wire.slice(2)).toEqual(first); expect(f.signed).toHaveLength(2)
    expect(f.message.snapshot().retry).toBe(false)
  })
  it('clears draft and retry state when closed', async () => {
    const f = fixture(); await f.message.review(f.peer, 'Ephemeral draft'); f.message.close(); await f.message.send()
    expect(f.wire).toEqual([]); expect(f.message.snapshot().review).toBeUndefined()
  })
  for (const uncertain of ['recipient', 'sender'] as const) it(`retries only the exact unconfirmed ${uncertain} copy after asymmetric acknowledgement`, async () => {
    const f = fixture(), target = uncertain === 'recipient' ? f.peer : f.self
    f.rejectRecipient(target, true)
    await f.message.review(f.peer, 'One accepted copy, one uncertain copy'); await f.message.send()
    const first = [...f.wire], pending = first.find(event => event.tags[0]![1] === target)!
    expect(first).toHaveLength(2); expect(f.message.snapshot().retry).toBe(true)
    expect(f.message.snapshot().status).toContain(uncertain === 'recipient' ? 'It may have arrived' : 'your encrypted history copy is unconfirmed')
    f.rejectRecipient(target, false); await f.message.send()
    expect(f.wire.slice(2)).toEqual([pending]); expect(f.wire[2]).toBe(pending)
    expect(f.encrypted).toHaveLength(2); expect(f.signed).toEqual([13, 13])
    expect(unwrapEvent(first[0]!, f.recipient)).toEqual(unwrapEvent(first[1]!, f.sender))
    expect(f.message.snapshot().retry).toBe(false); expect(f.message.snapshot().status).toContain('does not confirm')
    await f.message.send(); expect(f.wire).toHaveLength(3)
  })
  it('refuses self-messages, empty text and a multibyte payload exceeding the byte limit', async () => {
    const f = fixture()
    for (const [to, text] of [[f.self, 'hello'], [f.peer, '  '], [f.peer, '💬'.repeat(1025)]]) {
      await f.message.review(to!, text!); await f.message.send(); expect(f.message.snapshot().review).toBeUndefined()
    }
    expect(f.wire).toEqual([])
  })
  it('rejects secret keys and relay-hint URLs as recipient identities', () => {
    expect(() => nostrMessageRecipient('nsec1notapublickey')).toThrow()
    expect(() => nostrMessageRecipient('wss://recipient.example')).toThrow()
  })
})
