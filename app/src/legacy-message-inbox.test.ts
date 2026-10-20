import { describe, expect, it } from 'vitest'
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import { encrypt, decrypt } from 'nostr-tools/nip04'
import { Nip07Signer, type SignetSession } from 'signet-login'
import type { RelayTransport } from '../../src/relay-pool.js'
import { captureLegacyMessage, LegacyMessageInbox, LEGACY_MESSAGE_WARNING } from './legacy-message-inbox.js'
import { legacyMessageDecrypt } from './legacy-message-signer.js'

// Public test identities only; these are never offered to production account UI.
const key = (last: number) => Uint8Array.from([...Array<number>(31).fill(0), last])
const recipient = key(1), sender = key(2), other = key(3)
const account = getPublicKey(recipient), author = getPublicKey(sender)
async function message(text = 'An older message', to = account): Promise<Event> {
  return finalizeEvent({ kind: 4, created_at: 1_800_000_000, tags: [['p', to]],
    content: await encrypt(sender, to, text) }, sender)
}
function fixture(open?: (peer: string, ciphertext: string) => Promise<string>, supported = true) {
  let live = true, blocked = false, closed = 0, unsubscribed = 0, calls = 0, signs = 0, sends = 0
  let receive: Parameters<RelayTransport['subscribe']>[1] = () => {}
  let changed = () => {}
  const signer = new Nip07Signer(account, {
    getPublicKey: async () => account,
    signEvent: async () => { signs++; throw Error('This receive test cannot sign') },
    nip04: {
      encrypt: async () => { sends++; throw Error('This receive test cannot encrypt') },
      decrypt: async (peer, ciphertext) => { calls++; return open ? open(peer, ciphertext) : decrypt(recipient, peer, ciphertext) },
    },
  })
  const session: SignetSession = { pubkey: account, method: 'nip07', signer,
    authEvent: finalizeEvent({ kind: 21236, created_at: 1_800_000_000, tags: [], content: 'Public test session' }, recipient) as SignetSession['authEvent'] }
  let selected: SignetSession | undefined = session
  const bridge = supported ? legacyMessageDecrypt(session, () => selected) : undefined
  const inbox = new LegacyMessageInbox({ account, decrypt: bridge,
    transport: { subscribe: (_filters, incoming) => { receive = incoming; return () => { unsubscribed++ } }, close: () => { closed++ } },
    current: () => live && selected === session, blocked: () => blocked, changed: () => changed() })
  inbox.open()
  return { inbox, session, signer, receive: (event: Event) => receive(event), calls: () => calls,
    sends: () => sends, signs: () => signs, closed: () => closed, unsubscribed: () => unsubscribed,
    revoke: () => { live = false }, block: () => { blocked = true }, switchAccount: () => { selected = undefined },
    onChange: (fn: () => void) => { changed = fn } }
}

describe('legacy receive-only inbox and actual pinned SDK NIP-07 boundary', () => {
  it('receives real ciphertext without prompting, explicitly decrypts once and keeps the warning with literal text', async () => {
    const text = '<img src="https://not-fetched.invalid/"> An older message', event = await message(text), f = fixture()
    f.receive(event); f.receive(event)
    expect(f.calls()).toBe(0)
    expect(f.inbox.snapshot().messages).toEqual([{ id: event.id, author, sentAt: event.created_at, status: 'sealed', warning: LEGACY_MESSAGE_WARNING }])
    await f.inbox.openMessage(event.id)
    await f.inbox.openMessage(event.id)
    expect(f.calls()).toBe(1)
    expect(f.inbox.snapshot().messages[0]).toMatchObject({ status: 'opened', text, warning: LEGACY_MESSAGE_WARNING })
    expect(f.signs()).toBe(0); expect(f.sends()).toBe(0)
    f.inbox.close()
    expect(f.inbox.snapshot().messages).toEqual([])
    expect(f.closed()).toBe(1); expect(f.unsubscribed()).toBe(1)
  })
  it('refuses bad signature, wrong recipient and malformed ciphertext before provider dispatch', async () => {
    const valid = await message(), f = fixture()
    const malformed = finalizeEvent({ kind: 4, created_at: valid.created_at, tags: [['p', account]], content: 'not ciphertext' }, sender)
    for (const invalid of [{ ...valid, sig: '0'.repeat(128) }, await message('Someone else', getPublicKey(other)), malformed]) f.receive(invalid)
    expect(f.inbox.snapshot().messages).toEqual([])
    expect(f.calls()).toBe(0); expect(f.signs()).toBe(0); expect(f.sends()).toBe(0)
    f.inbox.close()
  })
  it('does not trust cached verification symbols or caller aliases/getters', async () => {
    const valid = await message(), forged = { ...valid, sig: '0'.repeat(128) }
    for (const symbol of Object.getOwnPropertySymbols(valid)) Object.defineProperty(forged, symbol, { value: true })
    expect(captureLegacyMessage(forged, account)).toBeUndefined()
    let getters = 0
    const getter = { ...valid }; Object.defineProperty(getter, 'content', { get: () => { getters++; return valid.content } })
    expect(captureLegacyMessage(getter, account)).toBeUndefined(); expect(getters).toBe(0)
    const copy = { ...valid, tags: valid.tags.map(tag => [...tag]) }, captured = captureLegacyMessage(copy, account)!
    copy.tags[0]![1] = getPublicKey(other)
    expect(captured.tags[0]![1]).toBe(account)
    expect(Object.isFrozen(captured)).toBe(true); expect(Object.isFrozen(captured.tags[0])).toBe(true)
  })
  it('preserves addressed historical messages with extra mention tags', async () => {
    const original = await message()
    const mentioned = finalizeEvent({ kind: 4, created_at: 1, tags: [['p', account], ['p', getPublicKey(other)]], content: original.content }, sender)
    const f = fixture(); f.receive(mentioned); await f.inbox.openMessage(mentioned.id)
    expect(f.inbox.snapshot().messages[0]).toMatchObject({ status: 'opened', text: 'An older message' })
    f.inbox.close()
  })
  it('shows unsupported and refused results without provider error or plaintext disclosure', async () => {
    const event = await message(), unsupported = fixture(undefined, false)
    unsupported.receive(event); await unsupported.inbox.openMessage(event.id)
    expect(unsupported.inbox.snapshot().messages[0]).toMatchObject({ status: 'unavailable', warning: LEGACY_MESSAGE_WARNING })
    expect(unsupported.calls()).toBe(0); unsupported.inbox.close()
    const refused = fixture(async () => { throw Error('Sensitive provider failure details') })
    refused.receive(event); await refused.inbox.openMessage(event.id)
    expect(refused.inbox.snapshot().messages[0]).toMatchObject({ status: 'refused', warning: LEGACY_MESSAGE_WARNING })
    expect(JSON.stringify(refused.inbox.snapshot())).not.toContain('Sensitive')
    expect(refused.inbox.snapshot().messages[0]?.text).toBeUndefined()
    refused.inbox.close()
  })
  it.each(['revoke', 'block', 'switchAccount'] as const)('refuses a %s before provider start', async action => {
    const event = await message(), f = fixture(); f.receive(event); f[action]()
    await f.inbox.openMessage(event.id)
    expect(f.calls()).toBe(0)
    f.inbox.close()
  })
  it('rechecks view lifetime after a reentrant UI notification and before provider start', async () => {
    const event = await message(), f = fixture(); f.receive(event)
    f.onChange(() => { if (f.inbox.snapshot().busy) f.inbox.close() })
    await f.inbox.openMessage(event.id)
    expect(f.calls()).toBe(0); expect(f.inbox.snapshot().messages).toEqual([])
  })
  it.each(['close', 'block', 'switchAccount'] as const)('discards already-started provider completion after %s without retry', async action => {
    let resolve!: (text: string) => void
    const pending = new Promise<string>(yes => { resolve = yes })
    const event = await message(), f = fixture(async () => pending); f.receive(event)
    const work = f.inbox.openMessage(event.id)
    expect(f.calls()).toBe(1)
    if (action === 'close') f.inbox.close(); else f[action]()
    resolve('A late provider result'); await work
    expect(JSON.stringify(f.inbox.snapshot())).not.toContain('A late provider result')
    expect(f.calls()).toBe(1); expect(f.signs()).toBe(0); expect(f.sends()).toBe(0)
    f.inbox.close()
  })
  it('serialises explicit opens and rejects oversized provider results', async () => {
    let resolve!: (text: string) => void
    const event = await message(), second = await message('Another'), f = fixture(async () => new Promise<string>(yes => { resolve = yes }))
    f.receive(event); f.receive(second)
    const work = f.inbox.openMessage(event.id); await f.inbox.openMessage(second.id)
    expect(f.calls()).toBe(1)
    resolve('界'.repeat(12_000)); await work
    expect(f.inbox.snapshot().messages.find(row => row.id === event.id)).toMatchObject({ status: 'refused' })
    f.inbox.close()
  })
  it('bounds malformed-event verification work per view instead of accepting an unbounded relay stream', async () => {
    const valid = await message(), f = fixture()
    for (let index = 0; index < 513; index++) f.receive({ ...valid, sig: '0'.repeat(128) })
    f.receive(valid)
    expect(f.inbox.snapshot()).toMatchObject({ limited: true, messages: [] })
    expect(f.calls()).toBe(0); f.inbox.close()
  })
  it('holds unqualified signer methods and changed crypto methods rather than falling back', async () => {
    const event = await message(), f = fixture(); f.receive(event)
    const otherMethod = { ...f.session, method: 'bunker' as const }
    expect(legacyMessageDecrypt(otherMethod, () => otherMethod)).toBeUndefined()
    f.signer.nip04!.decrypt = async () => 'Uncaptured replacement'
    await f.inbox.openMessage(event.id)
    expect(f.calls()).toBe(0)
    expect(f.inbox.snapshot().messages[0]).toMatchObject({ status: 'refused' })
    f.inbox.close()
  })
  it('requires the SDK provider-start contract and respects the captured Unix-ms expiry', async () => {
    const f = fixture(), expiring = { ...f.session, expiresAt: 1000 }
    let at = 999
    const bridge = legacyMessageDecrypt(expiring, () => expiring, () => at)!
    at = 1000
    await expect(bridge(author, (await message()).content, () => true)).rejects.toThrow('no longer available')
    expect(f.calls()).toBe(0)
    Object.defineProperty(f.signer, 'providerEffectBoundary', { value: undefined })
    expect(legacyMessageDecrypt(f.session, () => f.session)).toBeUndefined()
    f.inbox.close()
  })
})
