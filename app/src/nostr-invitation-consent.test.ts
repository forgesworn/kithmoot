import { afterEach, expect, it } from 'vitest'
import { base64 } from '@scure/base'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { wrapEvent } from 'nostr-tools/nip59'
import { createRoomInvitation } from '../../src/invitation.js'
import { deriveRoom, generateRoomSecret } from '../../src/room.js'
import { encodeRoomLink } from '../../src/link.js'
import { dmPolicy, localPeerCrypt } from '../../src/dm.js'
import { encryptEnvelope } from '../../src/attachment.js'
import { contactInvitationRumor, wrapContactInvitation } from '../../src/contact-invitation.js'
import { ContactInbox } from './contact-inbox.js'
import { memoryDeviceStore } from './device-store.js'
import { NostrMessageInbox } from './nostr-message-inbox.js'
import { openAccountMessage, openedInvitationRumor, type OpenedInvitation } from './nostr-opened-message.js'

function identity() {
  const key = generateSecretKey()
  return { key, pubkey: getPublicKey(key), ...localPeerCrypt(key), signEvent: async (event: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(event, key) }
}
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
function room(a: string, b: string) {
  const { invitation } = createRoomInvitation(true), { roomId } = deriveRoom(generateRoomSecret())
  return { room: roomId, link: encodeRoomLink('https://kithmoot.example/j/', { invitation, relays: ['wss://relay.example'], iceUrls: [], policy: dmPolicy(a, b) }) }
}
const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
function fixture() {
  const self = identity(), peer = identity(), store = memoryDeviceStore(), calls: string[] = []
  let now = 1_800_000_000, view = true, account = true, blocked = false, journalDecrypts = 0, releases = 0, pools = 0
  let beforeDecrypt = async (_call: number) => {}
  let beforeEncrypt = async (_peer: string, _text: string) => {}
  let incoming: (event: Event) => void = () => {}
  const journal = new ContactInbox({ identity: { ...self,
    decrypt: async (peer, text) => { journalDecrypts++; return self.decrypt(peer, text) },
    encrypt: async (peer, text) => { await beforeEncrypt(peer, text); return self.encrypt(peer, text) } }, store,
    acquire: async () => () => { releases++ }, pool: () => { pools++; throw Error('No publication requested') },
    current: () => account, allowed: () => account && !blocked, blocked: () => blocked, changed: () => {}, now: () => now })
  const decrypt = async (peer: string, text: string, current: () => boolean) => {
    if (!current()) throw Error('Revoked before provider start')
    calls.push(text); await beforeDecrypt(calls.length)
    const result = await self.decrypt(peer, text)
    if (!current()) throw Error('Revoked before provider handoff')
    return result
  }
  const make = () => new NostrMessageInbox({ account: self.pubkey, store, acquire: async () => () => { releases++ },
    receive: async () => ({ close() {}, subscribe: (_filters, receive) => { incoming = receive; return () => { incoming = () => {} } } }),
    current: () => view && account, blocked: () => blocked, changed: () => {}, decrypt, now: () => now,
    keepInvitation: (token, current) => journal.keepOpenedInvitation(token, current) })
  const inbox = make()
  cleanup.push(() => { inbox.close(); journal.close() })
  const invitation = async () => {
    const r = room(peer.pubkey, self.pubkey), rumor = contactInvitationRumor(peer.pubkey, self.pubkey, r.room, r.link, now)
    return { ...r, rumor, copy: await wrapContactInvitation(rumor, peer, self.pubkey, now, () => true) }
  }
  const ordinary = () => wrapEvent({ kind: 14, created_at: now, tags: [['p', self.pubkey]], content: 'Ordinary Nostr text' }, peer.key, self.pubkey)
  const token = async (copy: Event) => {
    const result = await openAccountMessage(copy, self.pubkey, decrypt, () => view && account, () => blocked, () => now)
    if (result.kind !== 'invitation') throw Error('Expected invitation')
    return result.token
  }
  return { self, peer, store, journal, inbox, make, calls, decrypt, invitation, ordinary, token, now: () => now,
    receive: (copy: Event) => incoming(copy), account: () => { account = false }, navigate: () => { view = false }, block: () => { blocked = true },
    advance: (seconds: number) => { now += seconds }, journalDecrypts: () => journalDecrypts, pools: () => pools, releases: () => releases,
    delayDecrypt: (work: typeof beforeDecrypt) => { beforeDecrypt = work }, delayEncrypt: (work: typeof beforeEncrypt) => { beforeEncrypt = work } }
}

it('composes both real readers without an arrival decrypt, opens each type exactly twice and leaves a sender copy unopened', async () => {
  const f = fixture(), invite = await f.invitation(), text = f.ordinary()
  const selfCopy = wrapEvent({ kind: 14, created_at: f.now(), tags: [['p', f.peer.pubkey]], content: 'Unopened sender copy' }, f.self.key, f.self.pubkey)
  await f.journal.open(); await f.inbox.open()
  for (const copy of [text, invite.copy, selfCopy]) f.receive(copy)
  expect(f.calls).toEqual([]); expect(f.journalDecrypts()).toBe(0); expect(f.pools()).toBe(0)
  expect(f.journal.snapshot().invitations).toEqual([])
  await f.inbox.openMessage(text.id)
  expect(f.calls).toHaveLength(2)
  expect(f.inbox.snapshot().messages.find(row => row.copy === text.id)?.message?.text).toBe('Ordinary Nostr text')
  expect(f.journal.snapshot().invitations).toEqual([])
  await f.inbox.openMessage(invite.copy.id)
  expect(f.calls).toHaveLength(4); expect(f.calls).not.toContain(selfCopy.content)
  expect(f.journalDecrypts()).toBe(0); expect(f.pools()).toBe(0)
  expect(f.journal.snapshot().invitations[0]?.id).toBe(invite.rumor.id)
  const row = f.inbox.snapshot().messages.find(row => row.copy === invite.copy.id)!
  expect(row.message).toBeUndefined(); expect(row.invitation).toMatchObject({ id: invite.rumor.id, kept: true })
  expect(JSON.stringify(row)).not.toContain(invite.link)
  expect(f.store.get(f.journal.key)).not.toContain(invite.link)
  f.inbox.close()
  const restarted = f.make(); cleanup.push(() => restarted.close()); await restarted.open()
  expect(f.calls).toHaveLength(4)
  expect(restarted.snapshot().messages.every(row => row.status === 'sealed' && !row.invitation && !row.message)).toBe(true)
})

it('does not fall back to ordinary text for a malformed encrypted invitation marker', async () => {
  const f = fixture(), copy = wrapEvent({ kind: 14, created_at: f.now(), tags: [['p', f.self.pubkey], ['kithmoot-invitation', '1', 'a'.repeat(64)]], content: 'Not a capability link' }, f.peer.key, f.self.pubkey)
  await f.journal.open(); await f.inbox.open(); f.receive(copy); await f.inbox.openMessage(copy.id)
  expect(f.calls).toHaveLength(2); expect(f.journal.snapshot().invitations).toEqual([])
  expect(f.inbox.snapshot().messages).toEqual([{ copy: copy.id, status: 'refused' }])
})

it('rejects fabricated and cross-account invitation tokens without changing the journal', async () => {
  const f = fixture(), invite = await f.invitation(); await f.journal.open()
  const token = await f.token(invite.copy), head = f.store.get(f.journal.key)
  expect(openedInvitationRumor(token, f.peer.pubkey, f.now(), () => true)).toBeUndefined()
  await expect(f.journal.keepOpenedInvitation({ invitation: token.invitation } as OpenedInvitation, () => true)).rejects.toThrow('no longer available')
  expect(f.store.get(f.journal.key)).toBe(head)
})

for (const boundary of ['view', 'account', 'block', 'expiration'] as const) it(`rejects a minted token after its originating ${boundary} changes`, async () => {
  const f = fixture(), invite = await f.invitation()
  // Preserve a real two-layer message while adding outer-wrapper expiry.
  const outerKey = generateSecretKey(), crypt = localPeerCrypt(outerKey)
  const seal = await f.self.decrypt(invite.copy.pubkey, invite.copy.content)
  const expiring = finalizeEvent({ kind: 1059, created_at: f.now(), tags: [['p', f.self.pubkey], ['expiration', String(f.now() + 5)]], content: await crypt.encrypt(f.self.pubkey, seal) }, outerKey)
  await f.journal.open(); const token = await f.token(boundary === 'expiration' ? expiring : invite.copy), head = f.store.get(f.journal.key)
  if (boundary === 'view') f.navigate(); else if (boundary === 'account') f.account(); else if (boundary === 'block') f.block(); else f.advance(5)
  await expect(f.journal.keepOpenedInvitation(token, () => true)).rejects.toThrow('no longer available')
  expect(f.store.get(f.journal.key)).toBe(head)
})

for (const boundary of ['close', 'account', 'block', 'navigate'] as const) it(`does not keep an invitation returned by a pending inner decrypt after ${boundary}`, async () => {
  const f = fixture(), invite = await f.invitation(), gate = deferred(), entered = deferred()
  f.delayDecrypt(async call => { if (call === 2) { entered.release(); await gate.promise } })
  await f.journal.open(); await f.inbox.open(); f.receive(invite.copy)
  const head = f.store.get(f.journal.key), task = f.inbox.openMessage(invite.copy.id)
  await entered.promise
  if (boundary === 'close') f.inbox.close(); else if (boundary === 'account') f.account(); else if (boundary === 'block') f.block(); else f.navigate()
  gate.release(); await task
  expect(f.calls).toHaveLength(2); expect(f.store.get(f.journal.key)).toBe(head)
  expect(f.journal.snapshot().invitations).toEqual([])
  expect(f.inbox.snapshot().messages.every(row => !row.invitation && !row.message)).toBe(true)
})

it('rechecks the originating view when invitation adoption waits behind an outbox write', async () => {
  const f = fixture(), invite = await f.invitation(), outgoing = room(f.self.pubkey, f.peer.pubkey)
  await f.journal.open(); const token = await f.token(invite.copy)
  const gate = deferred(), entered = deferred()
  f.delayEncrypt(async (peer, text) => { if (peer === f.peer.pubkey && text.includes('kithmoot-invitation')) { entered.release(); await gate.promise } })
  const sending = f.journal.enqueue(f.peer.pubkey, outgoing.room, outgoing.link, ['wss://relay.example'], ['wss://relay.example'])
  await entered.promise
  const adoption = f.journal.keepOpenedInvitation(token, () => true)
  const refused = expect(adoption).rejects.toThrow('no longer available')
  f.navigate(); gate.release(); await sending; await refused
  expect(f.journal.snapshot().invitations.map(entry => entry.id)).not.toContain(invite.rumor.id)
  expect(f.journal.snapshot().pending).toHaveLength(2)
})

it('preserves unknown or concurrently replaced invitation storage without overwriting it', async () => {
  const f = fixture(), invite = await f.invitation(); await f.journal.open(); const token = await f.token(invite.copy)
  f.store.set(f.journal.key, 'A different writer owns this head')
  await expect(f.journal.keepOpenedInvitation(token, () => true)).rejects.toThrow('changed in another view')
  expect(f.store.get(f.journal.key)).toBe('A different writer owns this head')
  f.journal.close()
  const g = fixture(); g.store.set(g.journal.key, JSON.stringify({ v: 2, account: g.self.pubkey }))
  const head = g.store.get(g.journal.key); await g.journal.open()
  expect(g.journal.snapshot().ready).toBe(false); expect(g.store.get(g.journal.key)).toBe(head)
})

it('restores a pre-existing encrypted v1 journal without dismissed ids and only unwraps its self-sealed storage key', async () => {
  const f = fixture(), invite = await f.invitation(), key = generateSecretKey()
  const keyHex = Array.from(key, byte => byte.toString(16).padStart(2, '0')).join('')
  const oldJournal = { v: 1, invitations: [{ rumor: invite.rumor, dismissed: false }], pending: [] }
  const sealed = encryptEnvelope(new TextEncoder().encode(JSON.stringify(oldJournal)), { name: 'private-invitations.json', type: 'application/json' }, { key })
  f.store.set(f.journal.key, JSON.stringify({ v: 1, account: f.self.pubkey, key: await f.self.encrypt(f.self.pubkey, keyHex), body: base64.encode(sealed.envelope) }))
  const original = f.store.get(f.journal.key)
  await f.journal.open()
  expect(f.journal.snapshot().invitations[0]?.id).toBe(invite.rumor.id)
  expect(f.journalDecrypts()).toBe(1); expect(f.calls).toEqual([]); expect(f.pools()).toBe(0)
  expect(f.store.get(f.journal.key)).toBe(original)
  await f.journal.dismiss(invite.rumor.id); expect(f.journal.snapshot().invitations).toEqual([])
})
