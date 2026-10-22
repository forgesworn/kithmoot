import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { GrantReceiver, buildGrant, buildRevocation, parseGroupEvent } from '../../src/group-grants.js'
import {
  GRANT_WARNING_SECONDS, STORAGE_GRANTS_PREFIX, forgetGrantReceiver, grantsEndingSoon, grantsEndingWords, holdsAnyGrant, loadGrantReceiver, saveGrantReceiver,
} from './group-room-grants.js'

const ROOM = 'ab'.repeat(32)
const NOW = 1_800_000_000
const A = 'https://grove.example.net'
const B = 'https://hill.example.org:8443/wb'
const authoritySk = generateSecretKey()
const authority = getPublicKey(authoritySk)
const deviceSk = generateSecretKey()
const device = getPublicKey(deviceSk)
const memory = () => {
  const map = new Map<string, string>()
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v) }, removeItem: (k: string) => { map.delete(k) } }
}
const grant = (server: string, id: string, expiration: number, who = device) =>
  buildGrant({ authoritySk, roomId: ROOM, device: who, server, scopes: ['upload', 'get', 'delete'], bytes: 1_000_000, grantId: id.repeat(16), createdAt: NOW - 100, expiration, status: 'active' })

describe('the grants this device holds for its room', () => {
  it('survive a reload: the receiver is rebuilt from what was kept, and each event is checked again', () => {
    const store = memory()
    const receiver = loadGrantReceiver(store, ROOM, { authority, device })
    expect(receiver.offer(grant('grove.example.net', '11', NOW + 86_400), NOW)).toBe(true)
    expect(saveGrantReceiver(store, ROOM, receiver)).toBe(true)
    const again = loadGrantReceiver(store, ROOM, { authority, device })
    expect(again.grantsFor('grove.example.net', NOW)).toHaveLength(1)
    expect(again.grantsFor('hill.example.org', NOW)).toHaveLength(0)
  })

  it('a receiver that holds nothing leaves no row, and one that did and no longer does takes its row away', () => {
    const store = memory()
    const receiver = new GrantReceiver({ authority, roomId: ROOM, device })
    expect(saveGrantReceiver(store, ROOM, receiver)).toBe(true)
    expect(store.map.size).toBe(0)
    receiver.offer(grant('grove.example.net', '11', NOW + 86_400), NOW)
    saveGrantReceiver(store, ROOM, receiver)
    expect(store.map.has(STORAGE_GRANTS_PREFIX + ROOM)).toBe(true)
    forgetGrantReceiver(store, ROOM)
    expect(store.map.size).toBe(0)
  })

  it('a row altered on the device, or signed by anybody but the room’s authority, is dropped, not trusted for having been stored', () => {
    const store = memory()
    const receiver = loadGrantReceiver(store, ROOM, { authority, device })
    receiver.offer(grant('grove.example.net', '11', NOW + 86_400), NOW)
    saveGrantReceiver(store, ROOM, receiver)
    const snapshot = JSON.parse(store.map.get(STORAGE_GRANTS_PREFIX + ROOM)!)
    snapshot.events[0].tags = snapshot.events[0].tags.map((t: string[]) => (t[0] === 'expiration' ? ['expiration', String(NOW + 90 * 86_400)] : t))
    store.map.set(STORAGE_GRANTS_PREFIX + ROOM, JSON.stringify(snapshot))
    expect(loadGrantReceiver(store, ROOM, { authority, device }).grantsFor('grove.example.net', NOW)).toHaveLength(0)
    // The same row read under another room's authority is not accepted either.
    saveGrantReceiver(store, ROOM, receiver)
    expect(loadGrantReceiver(store, ROOM, { authority: getPublicKey(generateSecretKey()), device }).grantsFor('grove.example.net', NOW)).toHaveLength(0)
  })

  it('unreadable text is an empty receiver, never an error', () => {
    const store = memory()
    store.map.set(STORAGE_GRANTS_PREFIX + ROOM, '{not json')
    expect(loadGrantReceiver(store, ROOM, { authority, device }).grantsFor('grove.example.net', NOW)).toEqual([])
    expect(loadGrantReceiver(store, 'nothex', { authority, device }).grantsFor('grove.example.net', NOW)).toEqual([])
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('full') }, removeItem: () => { throw new Error('denied') } }
    expect(loadGrantReceiver(broken, ROOM, { authority, device }).grantsFor('grove.example.net', NOW)).toEqual([])
    expect(saveGrantReceiver(broken, ROOM, loadGrantReceiver(memory(), ROOM, { authority, device }))).toBe(false)
  })
})

describe('whether the keeper has gone quiet', () => {
  const receiver = (...events: ReturnType<typeof grant>[]) => {
    const r = new GrantReceiver({ authority, roomId: ROOM, device })
    for (const e of events) r.offer(e, NOW)
    return r
  }

  it('says when the newest grant at every node the device holds one at ends within a week, and when group files stop', () => {
    const soon = NOW + 3 * 86_400, sooner = NOW + 86_400
    const r = receiver(grant('grove.example.net', '11', sooner), grant('hill.example.org', '22', soon))
    expect(grantsEndingSoon(r, [A, B], NOW)).toBe(soon)
  })

  it('says nothing while any node still has a grant good for longer than a week', () => {
    const r = receiver(grant('grove.example.net', '11', NOW + 86_400), grant('hill.example.org', '22', NOW + 30 * 86_400))
    expect(grantsEndingSoon(r, [A, B], NOW)).toBeUndefined()
    expect(grantsEndingSoon(receiver(grant('grove.example.net', '11', NOW + GRANT_WARNING_SECONDS + 1)), [A], NOW)).toBeUndefined()
    expect(grantsEndingSoon(receiver(grant('grove.example.net', '11', NOW + GRANT_WARNING_SECONDS)), [A], NOW)).toBe(NOW + GRANT_WARNING_SECONDS)
  })

  it('a renewal that has arrived is the newest grant, so there is nothing to say', () => {
    const r = receiver(grant('grove.example.net', '11', NOW + 86_400), grant('grove.example.net', '33', NOW + 30 * 86_400))
    expect(grantsEndingSoon(r, [A], NOW)).toBeUndefined()
  })

  it('a device with no grant at all, or only an ended or revoked one, has a missing grant, not an expiring one', () => {
    expect(grantsEndingSoon(receiver(), [A, B], NOW)).toBeUndefined()
    expect(grantsEndingSoon(receiver(grant('grove.example.net', '11', NOW - 5)), [A], NOW)).toBeUndefined()
    const ev = grant('grove.example.net', '44', NOW + 86_400)
    const verdict = parseGroupEvent(ev)
    if (!verdict.ok || verdict.parsed.type !== 'grant') throw new Error('test grant did not parse')
    expect(grantsEndingSoon(receiver(ev, buildRevocation(verdict.parsed, authoritySk, NOW - 50)), [A], NOW)).toBeUndefined()
  })

  it('looks only at the room’s nodes, and only at this device’s grants', () => {
    const r = receiver(grant('elsewhere.example.net', '11', NOW + 86_400), grant('grove.example.net', '22', NOW + 86_400, getPublicKey(generateSecretKey())))
    expect(grantsEndingSoon(r, [A, B], NOW)).toBeUndefined()
    expect(holdsAnyGrant(r, [A, B], NOW)).toBe(false)
    expect(holdsAnyGrant(receiver(grant('hill.example.org', '55', NOW + 86_400)), [A, B], NOW)).toBe(true)
  })

  it('words the warning with the date group files stop', () => {
    expect(grantsEndingWords(Date.UTC(2026, 10, 3, 12) / 1000, 'en-GB')).toBe('The group’s keeper has not been online for a while. Group files stop working on 3 November 2026 unless it comes back.')
  })
})
