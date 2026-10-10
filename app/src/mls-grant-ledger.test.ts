import { describe, expect, it, vi } from 'vitest'
import { base32nopad } from '@scure/base'
import { bytesToHex } from '@noble/hashes/utils.js'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { ParticipantIdentity } from '../../src/identity.js'
import { BrowserMlsGrantLedger, mlsBoxNode, mlsGrantReference, mlsGrantScope, planMlsGrant, removalGrantRefs, type MlsGrantRecord, type MlsGrantInstallationGate } from './mls-grant-ledger.js'
import { mlsKeeperGrantAuthority } from './mls-revocation-decision-store.js'
import { BrowserMlsKeeperAdmission } from './mls-keeper-admission.js'

const node = new Uint8Array(32).fill(31)
const box = { routeId: 'bothy-one', eventUrl: `ws://${base32nopad.encode(node).toLowerCase()}/events` }
const persona = '22'.repeat(32), device = '33'.repeat(32), leaf = '44'.repeat(32)
const room = { session: '66'.repeat(32), name: 'Planning room', leaf }
function signer(): ParticipantIdentity {
  const key = generateSecretKey()
  return { pubkey: getPublicKey(key), signEvent: async template => finalizeEvent(template, key) }
}
function admissionFor(identity: ParticipantIdentity) {
  return new BrowserMlsKeeperAdmission({ transact: async (_persona: string, work: any, current: () => boolean) => {
    if (!current()) return { state: 'pending', reason: 'stale', refused: false }
    const value = await work({ readVault: async () => undefined })
    return { state: 'active', value, marks: new Map() }
  } } as any, () => ({ vault: { principal: 'https://keeper.test', persona: identity.pubkey, generation: 0, revision: 'fixture' }, current: () => true, foreground: () => true }))
}
function fixture() {
  const identity = signer(), records: MlsGrantRecord[] = [], snapshots: MlsGrantRecord[] = [], published: string[] = []
  let fail = false, now = 1000
  const store = { all: async () => structuredClone(records), put: async (record: MlsGrantRecord) => {
    records.splice(0, records.length, ...records.filter(item => item.node !== record.node || item.device !== record.device), structuredClone(record)); snapshots.push(structuredClone(record))
  } }
  const link = { resume: vi.fn(async () => [box]), boxes: () => [box], pairedBoxes: vi.fn(async (_keeper: string) => [box]), openSocket: vi.fn() }
  const ledger = new BrowserMlsGrantLedger(() => identity, link as any, store, record => ({
    publish: async event => { published.push(event.id); if (fail) throw new Error('lost OK') }, close: () => undefined,
  }), () => now, async (_key, work) => work(), async (_device, _mode, work) => work(), admissionFor(identity))
  return { identity, records, snapshots, published, ledger, link, store, fail: (value: boolean) => { fail = value }, clock: (value: number) => { now = value } }
}

describe('browser VMLS grant ledger', () => {
  it('refuses noncanonical device-lock bindings and truthy compromised values before taking any lock or reading authority', async () => {
    const f = fixture(), gate = vi.fn(async (_device, _mode, work) => work()), all = vi.fn(f.store.all), put = vi.fn(f.store.put)
    const ledger = new BrowserMlsGrantLedger(() => f.identity, f.link as any, { all, put }, undefined, undefined, undefined, gate as MlsGrantInstallationGate)
    const valid: any[] = [bytesToHex(node), device, '55'.repeat(32), room.session, [leaf], true]
    for (const [index, value] of [[0, 'AA'.repeat(32)], [1, { toString: () => device }], [2, undefined], [3, 'wrong-room'], [4, { length: 1, some: () => false }], [5, 'false']] as const) {
      const args = [...valid]; args[index] = value
      await expect(ledger.withdraw(...args as [string, string, string, string, readonly string[], boolean])).rejects.toThrow('Invalid VMLS grant withdrawal')
    }
    const grant = await planMlsGrant(f.identity, box, persona, device, room, 1_000)
    await expect(ledger.withdrawRequestedDevice({ ...mlsKeeperGrantAuthority(grant), node: 'AA'.repeat(32) }, persona, device, () => true)).rejects.toThrow('current keeper account')
    expect(gate).not.toHaveBeenCalled(); expect(all).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(f.link.resume).not.toHaveBeenCalled()
  })
  it('keeps both withdrawal paths shared through persistence, uncertain publication and actual cleanup', async () => {
    for (const kind of ['room', 'requested'] as const) for (const refused of [false, true]) {
      const f = fixture(), installed = await f.ledger.install(box, persona, device, room), phases: string[] = []
      let held = false
      const check = (phase: string) => { expect(held).toBe(true); phases.push(phase) }
      const store = { all: async () => { check('read'); return f.store.all() }, put: async (record: MlsGrantRecord) => {
        check(record.state); await f.store.put(record); check(`saved-${record.state}`)
      } }
      const gate: MlsGrantInstallationGate = async (key, mode, work) => {
        expect(key).toBe(device); expect(mode).toBe('shared'); held = true
        try { return await work() } finally { held = false }
      }
      const ledger = new BrowserMlsGrantLedger(() => f.identity, { ...f.link, resume: async () => { check('resume') } } as any, store,
        () => ({ publish: async () => { check('publish'); await Promise.resolve(); check('published'); if (refused) throw new Error('uncertain') }, close: () => check('close') }),
        () => 1_000, async (_key, work) => { check('node-lock'); return work() }, gate)
      const pending = kind === 'room' ? ledger.withdraw(installed.node, device, mlsGrantReference(installed.node, installed.grantId), room.session, [leaf], true) :
        ledger.withdrawRequestedDevice(mlsKeeperGrantAuthority(installed), persona, device, () => true)
      if (refused) await expect(pending).rejects.toThrow('uncertain')
      else expect(await pending).toMatchObject({ result: 'revoked', record: { state: 'revoked' } })
      expect(held).toBe(false); expect(f.records[0]!.state).toBe(refused ? 'revoking' : 'revoked')
      expect(phases).toEqual(expect.arrayContaining(['node-lock', 'read', 'revoking', 'saved-revoking', 'resume', 'publish', 'published', 'close']))
      if (!refused) expect(phases.slice(-2)).toEqual(['revoked', 'saved-revoked'])
    }
  })
  it('rechecks the captured keeper after a queued shared withdrawal and before any ledger read', async () => {
    for (const kind of ['room', 'requested'] as const) {
      const f = fixture(), installed = await f.ledger.install(box, persona, device, room)
      const before = structuredClone(f.records[0])
      let identity = f.identity, release!: () => void
      const wait = new Promise<void>(resolve => { release = resolve }), all = vi.fn(f.store.all), publish = vi.fn(async () => undefined)
      const ledger = new BrowserMlsGrantLedger(() => identity, f.link as any, { ...f.store, all }, () => ({ publish, close: () => undefined }),
        () => 1_000, async (_key, work) => work(), async (_device, mode, work) => { expect(mode).toBe('shared'); await wait; return work() })
      const pending = kind === 'room' ? ledger.withdraw(installed.node, device, mlsGrantReference(installed.node, installed.grantId), room.session, [leaf], true) :
        ledger.withdrawRequestedDevice(mlsKeeperGrantAuthority(installed), persona, device, () => true)
      identity = signer(); release()
      await expect(pending).rejects.toThrow('keeper'); expect(all).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled()
      expect(f.records[0]).toEqual(before)
    }
  })
  it('never reports a foreign account revoked grant as this keeper withdrawal', async () => {
    const f = fixture(), installed = await f.ledger.install(box, persona, device, room)
    f.records[0]!.state = 'revoked'
    const identity = signer(), foreign = new BrowserMlsGrantLedger(() => identity, f.link as any, f.store, undefined, undefined,
      async (_key, work) => work(), async (_device, _mode, work) => work())
    await expect(foreign.withdraw(installed.node, device, mlsGrantReference(installed.node, installed.grantId), room.session, [leaf], true)).rejects.toThrow('did not issue')
    expect(f.published).toEqual([installed.active.id])
  })
  it('refuses mismatched stores, malformed devices and stale foreground before acquiring an install hold', async () => {
    const f = fixture(), work = vi.fn(async () => 'unsafe'), gate = vi.fn(async (_device, _mode, action) => action())
    const ledger = new BrowserMlsGrantLedger(() => f.identity, f.link as any, f.store, undefined, undefined, undefined, gate as MlsGrantInstallationGate)
    await expect(ledger.withDeviceInstallHold({ all: f.store.all }, f.identity.pubkey, device, () => true, work)).rejects.toThrow('different ledger')
    await expect(ledger.withDeviceInstallHold(f.store, f.identity.pubkey, device.toUpperCase() + 'x', () => true, work)).rejects.toThrow('different ledger')
    await expect(ledger.withDeviceInstallHold(f.store, '00', device, () => true, work)).rejects.toThrow('different ledger')
    await expect(ledger.withDeviceInstallHold(f.store, f.identity.pubkey, device, () => false, work)).rejects.toThrow('session changed')
    expect(gate).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled()
  })
  it('rechecks keeper identity after waiting for the exclusive install gate', async () => {
    const f = fixture(), work = vi.fn(async () => 'unsafe')
    let current = f.identity, release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    const gate: MlsGrantInstallationGate = async (_device, mode, action) => { expect(mode).toBe('exclusive'); await wait; return action() }
    const ledger = new BrowserMlsGrantLedger(() => current, f.link as any, f.store, undefined, undefined, undefined, gate)
    const pending = ledger.withDeviceInstallHold(f.store, f.identity.pubkey, device, () => true, work)
    current = signer(); release()
    await expect(pending).rejects.toThrow('session changed'); expect(work).not.toHaveBeenCalled()
  })
  it('keeps the exclusive gate through full callback settlement and rechecks foreground afterwards', async () => {
    const f = fixture()
    let held = false, live = true, release!: () => void, started!: () => void
    const wait = new Promise<void>(resolve => { release = resolve }), began = new Promise<void>(resolve => { started = resolve })
    const gate: MlsGrantInstallationGate = async (_device, mode, action) => {
      expect(mode).toBe('exclusive'); held = true
      try { return await action() } finally { held = false }
    }
    const ledger = new BrowserMlsGrantLedger(() => f.identity, f.link as any, f.store, undefined, undefined, undefined, gate)
    const pending = ledger.withDeviceInstallHold(f.store, f.identity.pubkey, device, () => live, async current => {
      started(); await wait; expect(held).toBe(true); expect(current()).toBe(false); return 'settled'
    })
    await began; live = false; await Promise.resolve(); expect(held).toBe(true); release()
    await expect(pending).rejects.toThrow('session changed'); expect(held).toBe(false)
  })
  it('retains shared ownership through signing, installing save, uncertain publication, cleanup and final active save', async () => {
    for (const refused of [false, true]) {
      const f = fixture(), phases: string[] = []
      let held = false
      const check = (phase: string) => { expect(held).toBe(true); phases.push(phase) }
      const identity = { pubkey: f.identity.pubkey, signEvent: async (template: Parameters<ParticipantIdentity['signEvent']>[0]) => {
        check('sign'); await Promise.resolve(); check('signed'); return f.identity.signEvent(template)
      } }
      const store = { all: async () => { check('read'); await Promise.resolve(); return f.store.all() }, put: async (record: MlsGrantRecord) => {
        check(record.state); await f.store.put(record); check(`saved-${record.state}`)
      } }
      const gate: MlsGrantInstallationGate = async (key, mode, action) => {
        expect(key).toBe(device); expect(mode).toBe('shared'); held = true
        try { return await action() } finally { held = false }
      }
      const ledger = new BrowserMlsGrantLedger(() => identity, f.link as any, store, () => ({
        publish: async () => { check('publish'); await Promise.resolve(); check('published'); if (refused) throw new Error('uncertain') },
        close: () => check('close'),
      }), () => 1_000, async (_key, action) => action(), gate, admissionFor(identity))
      if (refused) await expect(ledger.install(box, persona, device, room)).rejects.toThrow('uncertain')
      else expect((await ledger.install(box, persona, device, room)).state).toBe('active')
      expect(held).toBe(false); expect(phases).toEqual(expect.arrayContaining(['read', 'sign', 'signed', 'installing', 'saved-installing', 'publish', 'published', 'close']))
      expect(f.records[0]!.state).toBe(refused ? 'installing' : 'active')
      if (!refused) expect(phases.slice(-2)).toEqual(['active', 'saved-active'])
    }
  })
  it('reads exact account-bound pairings without starting Link or publishing a withdrawal', async () => {
    const f = fixture(), installed = await f.ledger.install(box, persona, device, room), authority = mlsKeeperGrantAuthority(installed)
    f.link.resume.mockClear()
    expect(await f.ledger.available(authority, persona, device, () => true)).toBe(true)
    expect(f.link.pairedBoxes).toHaveBeenCalledWith(f.identity.pubkey)
    for (const routes of [[], [{ ...box, routeId: 'another-route' }], [{ ...box, eventUrl: 'ws://different/events' }]]) {
      f.link.pairedBoxes.mockResolvedValueOnce(routes)
      expect(await f.ledger.available(authority, persona, device, () => true)).toBe(false)
    }
    expect(f.link.resume).not.toHaveBeenCalled(); expect(f.link.openSocket).not.toHaveBeenCalled()
    expect(f.published).toEqual([installed.active.id]); expect(f.records[0]!.state).toBe('active')
  })
  it('never turns missing, replaced or malformed grant storage into an absent route claim', async () => {
    const f = fixture(), installed = await f.ledger.install(box, persona, device, room), authority = mlsKeeperGrantAuthority(installed)
    f.records.length = 0
    await expect(f.ledger.available(authority, persona, device, () => true)).rejects.toThrow('no longer retained')
    f.records.push(await planMlsGrant(f.identity, box, persona, device, room, 1_001, { ...installed, state: 'revoked' }))
    await expect(f.ledger.available(authority, persona, device, () => true)).rejects.toThrow('authority or affected rooms changed')
    f.records[0] = { ...installed, active: { ...installed.active, sig: '00'.repeat(64) } }
    await expect(f.ledger.available(authority, persona, device, () => true)).rejects.toThrow('Invalid saved')
    expect(f.link.pairedBoxes).not.toHaveBeenCalled(); expect(f.published).toEqual([installed.active.id])
  })
  it('rechecks current account and exact authority after the asynchronous pairing read', async () => {
    const f = fixture(), installed = await f.ledger.install(box, persona, device, room), authority = mlsKeeperGrantAuthority(installed)
    let live = true
    f.link.pairedBoxes.mockImplementationOnce(async () => { live = false; return [] })
    await expect(f.ledger.available(authority, persona, device, () => live)).rejects.toThrow('session changed')
    live = true
    f.link.pairedBoxes.mockImplementationOnce(async () => {
      f.records[0] = await planMlsGrant(f.identity, box, persona, device, room, 1_001, { ...installed, state: 'revoked' }); return []
    })
    await expect(f.ledger.available(authority, persona, device, () => live)).rejects.toThrow('authority or affected rooms changed')
    f.records[0] = installed
    f.link.pairedBoxes.mockRejectedValueOnce(new Error('pairing vault unavailable'))
    await expect(f.ledger.available(authority, persona, device, () => live)).rejects.toThrow('pairing vault unavailable')
    const otherIdentity = signer(), otherLedger = new BrowserMlsGrantLedger(() => otherIdentity, f.link as any, f.store,
      undefined, () => 1_000, async (_key, work) => work())
    await expect(otherLedger.available(authority, persona, device, () => true)).rejects.toThrow('authority or affected rooms changed')
    expect(f.published).toEqual([installed.active.id])
  })
  it('revokes an approved ledger-only device immediately and retries the same immutable tombstone after uncertainty', async () => {
    const f = fixture(), installed = await f.ledger.install(box, persona, device, room)
    const stored = f.records[0]!; stored.rooms = []; stored.revokeAfter = 1_000 + 86400
    const authority = mlsKeeperGrantAuthority(stored)
    f.fail(true)
    await expect(f.ledger.withdrawRequestedDevice(authority, persona, device, () => true)).rejects.toThrow('lost OK')
    expect(f.records[0]!.state).toBe('revoking')
    f.fail(false)
    expect(await f.ledger.withdrawRequestedDevice(authority, persona, device, () => true)).toMatchObject({ result: 'revoked', record: { state: 'revoked' } })
    expect(f.published.slice(-2)).toEqual([installed.revocation.id, installed.revocation.id])
  })
  it('does not revoke replacement, foreign-person or expanded-room authority through an old approval', async () => {
    const f = fixture(), installed = await f.ledger.install(box, persona, device, room), authority = mlsKeeperGrantAuthority(installed)
    await expect(f.ledger.withdrawRequestedDevice(authority, '88'.repeat(32), device, () => true)).rejects.toThrow('authority or affected rooms changed')
    await f.ledger.install(box, persona, device, { session: '77'.repeat(32), name: 'Unreviewed room', leaf })
    await expect(f.ledger.withdrawRequestedDevice(authority, persona, device, () => true)).rejects.toThrow('authority or affected rooms changed')
    const replacement = await planMlsGrant(f.identity, box, persona, device, room, 1_002, { ...installed, state: 'revoked' })
    f.records[0] = replacement
    await expect(f.ledger.withdrawRequestedDevice(authority, persona, device, () => true)).rejects.toThrow('authority or affected rooms changed')
    expect(f.published).not.toContain(replacement.revocation.id)
  })
  it('leaves an account-invalidated withdrawal retryable instead of reporting revocation', async () => {
    const f = fixture(), installed = await f.ledger.install(box, persona, device, room), authority = mlsKeeperGrantAuthority(installed)
    let live = true
    const put = f.store.put
    f.store.put = async record => { await put(record); if (record.state === 'revoking') live = false }
    await expect(f.ledger.withdrawRequestedDevice(authority, persona, device, () => live)).rejects.toThrow('session changed')
    expect(f.records[0]!.state).toBe('revoking')
    expect(f.published).toEqual([installed.active.id])
  })
  it('signs a device-wide VMLS scope and a retained withdrawal before use', async () => {
    const identity = signer(), record = await planMlsGrant(identity, box, persona, device, room, 1000)
    expect(record.node).toBe(bytesToHex(node))
    expect(record.active.tags).toContainEqual(['d', mlsGrantScope(device)])
    expect(record.active.tags).toContainEqual(['vmls', String(64 * 1024 * 1024)])
    expect(record.active.tags.some(tag => tag[0] === 'write')).toBe(false)
    expect(record.revocation.tags.at(-1)).toEqual(['status', 'revoked'])
    expect(record.revocation.created_at).toBeGreaterThan(record.active.created_at)
  })

  it('retries immutable installation and revocation events after uncertain acknowledgements', async () => {
    const f = fixture(); f.fail(true)
    await expect(f.ledger.install(box, persona, device, room)).rejects.toThrow('lost OK')
    expect(f.records[0].state).toBe('installing')
    const active = f.records[0].active.id
    f.fail(false); await f.ledger.install(box, persona, device, room)
    expect(f.published.slice(0, 2)).toEqual([active, active])
    const reference = mlsGrantReference(f.records[0].node, f.records[0].grantId)
    f.fail(true); await expect(f.ledger.withdraw(bytesToHex(node), device, reference, room.session, [leaf], true)).rejects.toThrow('lost OK')
    expect(f.records[0].state).toBe('revoking')
    const revoked = f.records[0].revocation.id
    f.fail(false); await f.ledger.withdraw(bytesToHex(node), device, reference, room.session, [leaf], true)
    expect(f.published.slice(-2)).toEqual([revoked, revoked])
    expect(f.records[0].state).toBe('revoked')
    expect(f.snapshots.map(record => record.state)).toEqual(['installing','active','revoking','revoked'])
  })

  it('lists only live grants issued by this keeper and hashes their stable grant ids', async () => {
    const f = fixture(), installed = await f.ledger.install(box, persona, device, room)
    const other = { ...installed, device: '44'.repeat(32), persona: f.identity.pubkey, grantId: '55'.repeat(16) }
    const refs = removalGrantRefs(f.identity.pubkey, [device, other.device], [installed, other])
    expect(refs).toHaveLength(1)
    expect(bytesToHex(refs[0].node)).toBe(mlsBoxNode(box))
    expect(bytesToHex(refs[0].grant)).toBe(mlsGrantReference(installed.node, installed.grantId))
    installed.state = 'revoked'
    expect(removalGrantRefs(f.identity.pubkey, [device], [installed])).toEqual([])
  })

  it('sorts a replacement grant after the terminal revocation on the same device scope', async () => {
    const identity = signer(), retired = await planMlsGrant(identity, box, persona, device, room, 1000)
    retired.state = 'revoked'
    const replacement = await planMlsGrant(identity, box, persona, device, room, 1000, retired)
    expect(replacement.grantId).not.toBe(retired.grantId)
    expect(replacement.active.created_at).toBeGreaterThan(retired.revocation.created_at)
  })

  it('retains a shared normal grant, then gives its last room a durable 24-hour grace', async () => {
    const f = fixture(), other = { session: '77'.repeat(32), name: 'Finance room', leaf: '55'.repeat(32) }
    const first = await f.ledger.install(box, persona, device, room)
    const shared = await f.ledger.install(box, persona, device, other)
    const reference = mlsGrantReference(shared.node, shared.grantId)
    expect(shared.rooms.map(use => use.name)).toEqual(['Planning room', 'Finance room'])
    expect((await f.ledger.withdraw(shared.node, device, reference, room.session, [room.leaf], false)).result).toBe('retained')
    const grace = await f.ledger.withdraw(shared.node, device, reference, other.session, [other.leaf], false)
    expect(grace).toMatchObject({ result: 'grace', record: { rooms: [], revokeAfter: 87400, state: 'active' } })
    expect(f.published).toEqual([first.active.id])
    f.clock(87399); expect((await f.ledger.withdraw(shared.node, device, reference, other.session, [other.leaf], false)).result).toBe('grace')
    f.clock(87400); expect((await f.ledger.withdraw(shared.node, device, reference, other.session, [other.leaf], false)).result).toBe('revoked')
    expect(f.published.at(-1)).toBe(shared.revocation.id)
  })

  it('refuses to withdraw a replacement that does not match the reviewed reference', async () => {
    const f = fixture(), reviewed = await f.ledger.install(box, persona, device, room)
    const reference = mlsGrantReference(reviewed.node, reviewed.grantId)
    const replacement = await planMlsGrant(f.identity, box, persona, device, room, 1002, { ...reviewed, state: 'revoked' })
    f.records[0] = replacement
    await expect(f.ledger.withdraw(reviewed.node, device, reference, room.session, [leaf], true)).rejects.toThrow('changed before withdrawal')
    expect(f.published).toEqual([reviewed.active.id])
  })

  it('preserves every room through uncertain installation and expired renewal', async () => {
    const f = fixture(), other = { session: '77'.repeat(32), name: 'Finance room', leaf: '55'.repeat(32) }
    f.fail(true); await expect(f.ledger.install(box, persona, device, room)).rejects.toThrow('lost OK')
    f.fail(false)
    const recovered = await f.ledger.install(box, persona, device, other)
    expect(recovered.rooms).toEqual([room, other])
    f.clock(recovered.expiration + 1)
    const renewed = await f.ledger.install(box, persona, device, room, recovered.expiration + 1)
    expect(renewed.rooms).toEqual([room, other])
  })

  it('does not let an old removal detach a later admission in the same room', async () => {
    const f = fixture(), installed = await f.ledger.install(box, persona, device, room)
    const reference = mlsGrantReference(installed.node, installed.grantId)
    expect((await f.ledger.withdraw(installed.node, device, reference, room.session, [room.leaf], false)).result).toBe('grace')
    const admitted = { ...room, leaf: '55'.repeat(32) }
    const restored = await f.ledger.install(box, persona, device, admitted)
    expect(restored).toMatchObject({ rooms: [admitted], revokeAfter: null, state: 'active' })
    f.clock(1000 + 2 * 86400)
    const stale = await f.ledger.withdraw(installed.node, device, reference, room.session, [room.leaf], false)
    expect(stale).toMatchObject({ result: 'retained', record: { rooms: [admitted], revokeAfter: null, state: 'active' } })
    expect(f.published).toEqual([installed.active.id])
  })
})
