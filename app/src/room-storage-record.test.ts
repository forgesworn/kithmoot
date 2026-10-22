import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { signRoomStorage } from '../../src/room-storage.js'
import { GrantReceiver, buildGrant } from '../../src/group-grants.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { validateOrdinaryRoutingSnapshot } from './ordinary-routing-snapshot.js'
import { validateOrdinaryPrivateFamilySnapshot } from './ordinary-private-family-snapshot.js'
import { classifyOrdinaryPhysicalName } from './ordinary-physical-snapshot.js'
import {
  ROOM_STORAGE_PREFIX, adoptRoomStorage, forgetRoomStorageRecord, listedBaseOf, loadRoomStorageRecord, parseRoomStorageRecord,
  newerRoomStorage, recordFromAdmission, recordFromOp, storeRoomStorageRecord, usableGroupBase, type RoomStorageRecord,
} from './room-storage-record.js'

const ROOM = 'ab'.repeat(32)
const A = 'https://grove.example.net'
const B = 'https://hill.example.org:8443/wb'
const authoritySk = generateSecretKey()
const authority = getPublicKey(authoritySk)
const memory = () => {
  const map = new Map<string, string>()
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v) }, removeItem: (k: string) => { map.delete(k) } }
}
const SIG = 'c'.repeat(128)

describe('the room storage record', () => {
  it('is kept under the room and read back as it was', () => {
    const store = memory()
    expect(loadRoomStorageRecord(store, ROOM)).toBeUndefined()
    expect(storeRoomStorageRecord(store, ROOM, { nodes: [A, B], version: 1800 })).toBe(true)
    expect(store.map.get(ROOM_STORAGE_PREFIX + ROOM)).toBe(JSON.stringify({ nodes: [A, B], version: 1800 }))
    expect(loadRoomStorageRecord(store, ROOM)).toEqual({ nodes: [A, B], version: 1800 })
    storeRoomStorageRecord(store, ROOM, { nodes: [], version: 1900, sig: SIG })
    expect(loadRoomStorageRecord(store, ROOM)).toEqual({ nodes: [], version: 1900, sig: SIG })
    forgetRoomStorageRecord(store, ROOM)
    expect(store.map.size).toBe(0)
  })

  it('refuses anything that is not a record: a non-canonical list, a bad version, an extra key, a bad signature', () => {
    const bad: unknown[] = [
      { nodes: ['https://grove.example.net/'], version: 1 }, { nodes: [A, A], version: 1 }, { nodes: 'x', version: 1 },
      { nodes: [A], version: -1 }, { nodes: [A], version: 1.5 }, { nodes: [A], version: 1, extra: true },
      { nodes: [A], version: 1, sig: 'nothex' }, [], null, 'text',
    ]
    for (const value of bad) expect(parseRoomStorageRecord(JSON.stringify(value)), JSON.stringify(value)).toBeUndefined()
    expect(parseRoomStorageRecord('{broken')).toBeUndefined()
    expect(parseRoomStorageRecord(null)).toBeUndefined()
    expect(loadRoomStorageRecord(memory(), 'nothex')).toBeUndefined()
  })

  it('a store that throws leaves the record in force for the visit and is told so', () => {
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('full') }, removeItem: () => { throw new Error('denied') } }
    expect(storeRoomStorageRecord(broken, ROOM, { nodes: [A], version: 1 })).toBe(false)
    expect(loadRoomStorageRecord(broken, ROOM)).toBeUndefined()
    expect(() => forgetRoomStorageRecord(broken, ROOM)).not.toThrow()
  })
})

describe('which list this device holds (the record from the invitation and from the op)', () => {
  const held: RoomStorageRecord = { nodes: [A], version: 100 }

  it('the first list offered is held', () => {
    expect(adoptRoomStorage(undefined, { nodes: [A], version: 5 })).toEqual({ nodes: [A], version: 5 })
  })

  it('the newer version wins, from either carrier, and a withdrawn list is a list', () => {
    expect(adoptRoomStorage(held, { nodes: [A, B], version: 101, sig: SIG })).toEqual({ nodes: [A, B], version: 101, sig: SIG })
    expect(adoptRoomStorage(held, { nodes: [], version: 200 })).toEqual({ nodes: [], version: 200 })
  })

  it('an older version, replayed later, changes nothing', () => {
    expect(adoptRoomStorage({ nodes: [], version: 200 }, { nodes: [A], version: 100, sig: SIG })).toBeUndefined()
  })

  it('a tie keeps what is held, except that the op adds its signature to the same list', () => {
    expect(adoptRoomStorage(held, { nodes: [A, B], version: 100 })).toBeUndefined()
    expect(adoptRoomStorage(held, { nodes: [A], version: 100 })).toBeUndefined()
    expect(adoptRoomStorage(held, { nodes: [A], version: 100, sig: SIG })).toEqual({ nodes: [A], version: 100, sig: SIG })
    // A different list at the same version is not taken, signed or not.
    expect(adoptRoomStorage(held, { nodes: [B], version: 100, sig: SIG })).toBeUndefined()
    // Already signed: nothing to add.
    expect(adoptRoomStorage({ ...held, sig: SIG }, { nodes: [A], version: 100, sig: 'd'.repeat(128) })).toBeUndefined()
  })

  it('the record from an invitation copy is its storage list at its time', () => {
    expect(recordFromAdmission({})).toBeUndefined()
    expect(recordFromAdmission({ storage: [A, B], storageAt: 1_800_000_000 })).toEqual({ nodes: [A, B], version: 1_800_000_000 })
    expect(recordFromAdmission({ storage: [], storageAt: 7 })).toEqual({ nodes: [], version: 7 })
    expect(recordFromAdmission({ storage: [A] })).toEqual({ nodes: [A], version: 0 })
    expect(recordFromAdmission({ storage: ['https://grove.example.net/'] })).toBeUndefined()
  })

  it('the record from an op is taken only if the room authority signed that list, that version and that room', () => {
    const sig = signRoomStorage({ roomId: ROOM, version: 300, nodes: [A, B], authoritySk })
    const op = { nodes: [A, B], version: 300, sig }
    expect(recordFromOp(op, ROOM, authority)).toEqual({ nodes: [A, B], version: 300, sig })
    expect(recordFromOp({ ...op, sig: sig.toUpperCase() }, ROOM, authority)?.sig).toBe(sig)
    expect(recordFromOp(op, ROOM, getPublicKey(generateSecretKey()))).toBeUndefined()
    expect(recordFromOp(op, 'cd'.repeat(32), authority)).toBeUndefined()
    expect(recordFromOp({ ...op, version: 301 }, ROOM, authority)).toBeUndefined()
    // The order is signed: a member cannot put a node of their choosing first.
    expect(recordFromOp({ ...op, nodes: [B, A] }, ROOM, authority)).toBeUndefined()
    expect(recordFromOp({ ...op, nodes: [A, B, 'https://x.example.net'] }, ROOM, authority)).toBeUndefined()
  })
})

describe('what another tab wrote', () => {
  const old: RoomStorageRecord = { nodes: [A], version: 100 }
  const newer: RoomStorageRecord = { nodes: [A, B], version: 200, sig: SIG }

  it('the newer of two is the one kept, whichever way round, and a tie keeps the first', () => {
    expect(newerRoomStorage(old, newer)).toBe(newer)
    expect(newerRoomStorage(newer, old)).toBe(newer)
    expect(newerRoomStorage(old, { nodes: [B], version: 100 })).toBe(old)
  })

  it('a missing record yields the other: a removal by another tab does not remove what this tab holds', () => {
    expect(newerRoomStorage(old, undefined)).toBe(old)
    expect(newerRoomStorage(undefined, newer)).toBe(newer)
    expect(newerRoomStorage(undefined, undefined)).toBeUndefined()
  })

  it('a stale tab that writes an older list over a newer one is not believed', () => {
    const held = newerRoomStorage(newer, old)
    expect(adoptRoomStorage(held, { nodes: [A], version: 150, sig: SIG })).toBeUndefined()
  })
})

describe('which nodes this app can reach, and which files are on them', () => {
  it('only https, and never an onion address', () => {
    expect(usableGroupBase(A)).toBe(true)
    expect(usableGroupBase(B)).toBe(true)
    expect(usableGroupBase('http://localhost:3000')).toBe(false)
    expect(usableGroupBase('http://127.0.0.1:8080')).toBe(false)
    expect(usableGroupBase(`http://${'a'.repeat(56)}.onion`)).toBe(false)
    expect(usableGroupBase(`https://${'a'.repeat(56)}.onion`)).toBe(false)
    expect(usableGroupBase('not a url')).toBe(false)
  })

  const hash = 'f'.repeat(64)
  it('a file is a group file only at exactly <listed base>/<its hash>', () => {
    expect(listedBaseOf([A, B], `${A}/${hash}`, hash)).toBe(A)
    expect(listedBaseOf([A, B], `${B}/${hash}`, hash.toUpperCase())).toBe(B)
    expect(listedBaseOf([A, B], `https://blossom.example.com/${hash}`, hash)).toBeUndefined()
    expect(listedBaseOf([A], `${A}/${hash}.png`, hash)).toBeUndefined()
    expect(listedBaseOf([A], `${A}/x/${hash}`, hash)).toBeUndefined()
    expect(listedBaseOf([A], `${A}/${hash}?t=1`, hash)).toBeUndefined()
    // A node the room has since delisted is no longer a group node.
    expect(listedBaseOf([B], `${A}/${hash}`, hash)).toBeUndefined()
    expect(listedBaseOf([], `${A}/${hash}`, hash)).toBeUndefined()
    // A different host that merely starts the same way is not the base.
    expect(listedBaseOf([A], `https://grove.example.net.evil.test/${hash}`, hash)).toBeUndefined()
  })
})

describe('registered with the ordinary snapshots (a new kithmoot.* key must be)', () => {
  const name = ROOM_STORAGE_PREFIX + ROOM
  it('the record is a routing row and the grants are a private row', () => {
    expect(classifyOrdinaryPhysicalName(name, 'browser')?.family).toBe('routing')
    expect(classifyOrdinaryPhysicalName(`kithmoot.storage-grants.v1.${ROOM}`, 'browser')?.family).toBe('private')
    expect(() => classifyOrdinaryPhysicalName(name, 'tab')).toThrow(OrdinaryStateHold)
    expect(() => classifyOrdinaryPhysicalName(ROOM_STORAGE_PREFIX + 'xyz', 'browser')).toThrow(OrdinaryStateHold)
  })

  it('the routing validator counts a record and holds on a damaged one', () => {
    const ok = (value: unknown) => new Map([[name, JSON.stringify(value)]])
    expect(validateOrdinaryRoutingSnapshot(ok({ nodes: [A, B], version: 5 }), true, { kind: 'browser' }).storageRecords).toBe(1)
    expect(validateOrdinaryRoutingSnapshot(ok({ nodes: [], version: 5, sig: SIG }), true, { kind: 'browser' }).storageRecords).toBe(1)
    for (const value of [{ nodes: ['https://grove.example.net/'], version: 5 }, { nodes: [A] }, { nodes: [A], version: 5, junk: 1 }, { nodes: [A], version: 5, sig: 'x' }]) {
      expect(() => validateOrdinaryRoutingSnapshot(ok(value), true, { kind: 'browser' }), JSON.stringify(value)).toThrow(OrdinaryStateHold)
    }
    // Not canonical JSON (spaces): the physical row is what this device wrote, byte for byte.
    expect(() => validateOrdinaryRoutingSnapshot(new Map([[name, '{ "nodes": [], "version": 5 }']]), true, { kind: 'browser' })).toThrow(OrdinaryStateHold)
    expect(() => validateOrdinaryRoutingSnapshot(ok({ nodes: [], version: 5 }), true, { kind: 'tab' })).toThrow(OrdinaryStateHold)
  })

  it('the private validator counts a receiver snapshot and holds on a damaged one', () => {
    const device = getPublicKey(generateSecretKey())
    const receiver = new GrantReceiver({ authority, roomId: ROOM, device })
    const now = 1_800_000_000
    receiver.offer(buildGrant({ authoritySk, roomId: ROOM, device, server: 'grove.example.net', scopes: ['upload', 'get', 'delete'], bytes: 1_000_000, grantId: '11'.repeat(16), createdAt: now - 10, expiration: now + 86_400, status: 'active' }), now)
    const grantsName = `kithmoot.storage-grants.v1.${ROOM}`
    const raw = JSON.stringify(receiver.snapshot())
    expect(validateOrdinaryPrivateFamilySnapshot(new Map([[grantsName, raw]]), true, { kind: 'browser' }).grantJournals).toBe(1)
    const snapshot = receiver.snapshot()
    const damaged = [
      { ...snapshot, events: [{ ...snapshot.events[0]!, id: 'zz' }] },
      { ...snapshot, events: [snapshot.events[0], snapshot.events[0]] },
      { ...snapshot, acknowledged: ['no slash'] },
      { events: snapshot.events },
    ]
    for (const value of damaged) expect(() => validateOrdinaryPrivateFamilySnapshot(new Map([[grantsName, JSON.stringify(value)]]), true, { kind: 'browser' })).toThrow(OrdinaryStateHold)
  })
})
