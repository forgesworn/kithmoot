import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools/pure'
import { localIdentity } from '../../src/identity.js'
import { localPeerCrypt } from '../../src/dm.js'
import { dmRelayListTemplate } from '../../src/dm-relays.js'
import { wrapVmlsRevocationRequest } from '../../src/vmls-revocation-request.js'
import { readMlsMembership, saveMlsMembership } from './mls-membership-store.js'
import { InvalidPersonaRecord, type PersonaTransaction } from './mls-persona-coordinator.js'
import { BrowserMlsRevocationInbox } from './mls-revocation-inbox.js'
import { BrowserMlsKeeperInboxFetch } from './mls-keeper-inbox-fetch.js'
import type { MlsKeeperInboxQuery } from './mls-keeper-inbox-relay.js'

class MemoryTransaction implements PersonaTransaction {
  installation = '66'.repeat(32)
  constructor(readonly vault = new Map<string, Uint8Array>()) {}
  async readVault(id: string) { return this.vault.get(id)?.slice() }
  async putVault(id: string, bytes: Uint8Array) { this.vault.set(id, bytes.slice()) }
  async dropVault(id: string) { this.vault.delete(id) }
  async readSession() { return undefined }
  async putSession() {}
  async dropSession() {}
}
async function fixture(relays = ['wss://keeper-one.test/', 'wss://keeper-two.test/']) {
  const secret = generateSecretKey(), identity = { ...localIdentity(secret), ...localPeerCrypt(secret) }
  const tx = new MemoryTransaction(), wrappers: Event[] = []
  let now = 1_000_000, generation = 1, foreground = true, pending = false, complete = true
  let directory: Event[] = [finalizeEvent(dmRelayListTemplate(relays, now), secret)]
  const context = () => ({ vault: { principal: 'https://test', persona: identity.pubkey, generation, revision: 'one' }, current: () => true, foreground: () => foreground })
  const coordinator = { transact: async (_persona: string, work: (tx: PersonaTransaction) => Promise<unknown>, current: () => boolean) => {
    if (pending || !current()) return { state: 'pending', reason: 'witness-unavailable', refused: false }
    const candidate = new MemoryTransaction(new Map([...tx.vault].map(([key, bytes]) => [key, bytes.slice()])))
    const value = await work(candidate)
    if (!current()) return { state: 'pending', reason: 'stale', refused: false }
    tx.vault.clear(); for (const [key, bytes] of candidate.vault) tx.vault.set(key, bytes)
    return { state: 'active', value, marks: new Map() }
  } }
  const transport = { directory: vi.fn(async () => structuredClone(directory)), page: vi.fn(async (query: MlsKeeperInboxQuery) => ({ complete,
    events: wrappers.filter(event => event.created_at >= query.since && event.created_at <= query.until).sort((a, b) => b.created_at - a.created_at).slice(0, 64) })) }
  const restart = () => {
    const inbox = new BrowserMlsRevocationInbox(coordinator as any, { all: async () => [] }, context, () => now)
    return { inbox, fetch: new BrowserMlsKeeperInboxFetch(coordinator as any, inbox, transport, context, () => now) }
  }
  const signer = { ...identity, decrypt: vi.fn(identity.decrypt) }
  const wrap = (at = now - 10) => finalizeEvent({ kind: 1059, created_at: at, content: 'unrelated or unsupported private traffic', tags: [['p', identity.pubkey]] }, generateSecretKey())
  return { tx, identity, signer, transport, wrappers, restart, wrap, relays,
    clock: (value: number) => { now = value }, now: () => now, hold: () => { pending = true }, hide: () => { foreground = false }, change: () => { generation++ },
    incomplete: () => { complete = false }, directory: (events: Event[]) => { directory = events }, secret }
}

describe('witnessed keeper stored inbox scans', () => {
  it('reserves eight signer attempts across repeated checks, restart and direct intake; seen ids use no allowance', async () => {
    const f = await fixture([ 'wss://keeper-one.test/' ])
    f.wrappers.push(...Array.from({ length: 12 }, () => f.wrap()))
    expect(await f.restart().fetch.check(f.signer)).toMatchObject({ state: 'active', value: { status: 'checked', complete: false } })
    expect(f.signer.decrypt).toHaveBeenCalledTimes(8)
    expect(await f.restart().fetch.check(f.signer)).toMatchObject({ value: { status: 'rate-limited' } })
    await f.restart().inbox.receive(f.wrappers, f.signer)
    expect(f.signer.decrypt).toHaveBeenCalledTimes(8); expect(f.transport.page).toHaveBeenCalledTimes(1)
    expect(f.transport.directory).toHaveBeenCalledTimes(1)
    f.clock(f.now() + 60)
    expect(await f.restart().fetch.check(f.signer)).toMatchObject({ value: { complete: true } })
    expect(f.signer.decrypt).toHaveBeenCalledTimes(12)
    expect(f.transport.directory).toHaveBeenCalledTimes(1)
    expect((await readMlsMembership(f.tx)).inbox!.seen).toHaveLength(12)
  })
  it('budgets both decryption layers, not just malformed outer ciphertext, across restart', async () => {
    const f = await fixture([ 'wss://keeper-one.test/' ]), memberSecret = generateSecretKey(), member = { ...localIdentity(memberSecret), ...localPeerCrypt(memberSecret) }
    f.wrappers.push(...await Promise.all(Array.from({ length: 9 }, () => wrapVmlsRevocationRequest(member, { sender: member.pubkey, keeper: f.identity.pubkey,
      device: '33'.repeat(32), sessions: ['55'.repeat(32)], boxes: ['44'.repeat(32)], createdAt: f.now(), expiration: f.now() + 600 }, () => 0))))
    await f.restart().fetch.check(f.signer)
    expect(f.signer.decrypt).toHaveBeenCalledTimes(16)
    await f.restart().inbox.receive(f.wrappers, f.signer)
    expect(f.signer.decrypt).toHaveBeenCalledTimes(16)
    f.clock(f.now() + 60); await f.restart().fetch.check(f.signer)
    expect(f.signer.decrypt).toHaveBeenCalledTimes(18)
  })
  it('takes turns after incomplete pages and keeps each relay cursor independent', async () => {
    const f = await fixture(); f.wrappers.push(f.wrap()); f.incomplete()
    await f.restart().fetch.check(f.signer)
    const first = f.transport.page.mock.calls[0]![0]
    f.clock(f.now() + 60); await f.restart().fetch.check(f.signer)
    const second = f.transport.page.mock.calls[1]![0]
    expect(first.relay.url).toBe(f.relays[0]); expect(second.relay.url).toBe(f.relays[1])
    f.clock(f.now() + 60); await f.restart().fetch.check(f.signer)
    expect(f.transport.page.mock.calls[2]![0].until).toBe(first.until)
    expect((await readMlsMembership(f.tx)).inbox!.scan!.cursors).toEqual([{ relay: f.relays[0], until: first.until }, { relay: f.relays[1], until: second.until }])
  })
  it('rereads the boundary second inclusively before moving past it and ignores future wraps', async () => {
    const f = await fixture([ 'wss://keeper-one.test/' ]), at = f.now() - 10
    f.wrappers.push(f.wrap(at), f.wrap(f.now() + 1))
    await f.restart().fetch.check(f.signer)
    expect((await readMlsMembership(f.tx)).inbox!.scan!.cursors[0]!.until).toBe(at)
    f.clock(f.now() + 60); await f.restart().fetch.check(f.signer)
    expect(f.transport.page.mock.calls[1]![0].until).toBe(at)
    expect((await readMlsMembership(f.tx)).inbox!.scan!.cursors[0]!.until).toBe(at - 1)
    expect(f.signer.decrypt).toHaveBeenCalledTimes(1)
  })
  it('uses only the verified latest own directory, caches it for fifteen minutes and honours an empty replacement', async () => {
    const f = await fixture(), scan = f.restart().fetch
    f.directory([finalizeEvent({ kind: 10050, created_at: f.now() + 100, tags: [['relay', 'wss://forged.test/']], content: '' }, generateSecretKey()),
      finalizeEvent(dmRelayListTemplate(f.relays, f.now()), f.secret)])
    await scan.check(f.signer); f.clock(f.now() + 60); await scan.check(f.signer)
    expect(f.transport.directory).toHaveBeenCalledTimes(1)
    f.directory([finalizeEvent({ kind: 10050, created_at: f.now(), content: '', tags: [] }, f.secret)])
    f.clock(1_000_900)
    expect(await scan.check(f.signer)).toMatchObject({ value: { status: 'no-list' } })
    expect(f.transport.directory).toHaveBeenCalledTimes(2); expect(f.transport.page).toHaveBeenCalledTimes(2)
  })
  it('makes no directory, socket or signer call without the witness or foreground account', async () => {
    const f = await fixture(); f.hold()
    expect(await f.restart().fetch.check(f.signer)).toMatchObject({ state: 'pending' })
    expect(f.transport.directory).not.toHaveBeenCalled(); expect(f.transport.page).not.toHaveBeenCalled(); expect(f.signer.decrypt).not.toHaveBeenCalled()
    f.hide(); await expect(f.restart().fetch.check(f.signer)).rejects.toThrow('foreground')
  })
  it('withholds a late directory after account change, with no recipient query', async () => {
    const f = await fixture()
    f.transport.directory.mockImplementation(async () => { f.change(); return [] })
    expect(await f.restart().fetch.check(f.signer)).toMatchObject({ state: 'pending', reason: 'stale' })
    expect(f.transport.page).not.toHaveBeenCalled()
  })
  it('cannot reset the page budget through a transport failure or clock rollback', async () => {
    const f = await fixture()
    f.transport.page.mockRejectedValueOnce(new Error('offline'))
    await expect(f.restart().fetch.check(f.signer)).rejects.toThrow('offline')
    expect(await f.restart().fetch.check(f.signer)).toMatchObject({ value: { status: 'rate-limited' } })
    f.clock(f.now() - 1); await expect(f.restart().fetch.check(f.signer)).rejects.toThrow('trusted request time')
  })
  it('persists failed directory reservations across restart without claiming a verified empty list', async () => {
    const f = await fixture()
    f.transport.directory.mockRejectedValueOnce(new Error('offline directory'))
    await expect(f.restart().fetch.check(f.signer)).rejects.toThrow('offline directory')
    await expect(f.restart().fetch.check(f.signer)).rejects.toThrow('unconfirmed')
    expect(f.transport.directory).toHaveBeenCalledTimes(1); expect(f.transport.page).not.toHaveBeenCalled()
    f.clock(f.now() + 900); await f.restart().fetch.check(f.signer)
    expect(f.transport.directory).toHaveBeenCalledTimes(2)
  })
  it.each(['yes', 1, null, {}])('does not treat malformed AUTH permission %j as consent', async authenticate => {
    const f = await fixture()
    await expect(f.restart().fetch.check(f.signer, [{ relay: { url: f.relays[0]!, read: true, write: false }, authenticate, current: () => true }] as any)).rejects.toThrow('read permissions')
    expect(f.transport.directory).not.toHaveBeenCalled(); expect(f.transport.page).not.toHaveBeenCalled(); expect(f.signer.decrypt).not.toHaveBeenCalled()
  })
  it('rejects corrupt persisted budgets rather than spending signer allowance', async () => {
    const f = await fixture(); await f.restart().inbox.view()
    const journal = await readMlsMembership(f.tx); journal.inbox!.attempts = Array(9).fill(f.now())
    await expect(saveMlsMembership(f.tx, journal)).rejects.toBeInstanceOf(InvalidPersonaRecord)
    expect(f.signer.decrypt).not.toHaveBeenCalled()
  })
})
