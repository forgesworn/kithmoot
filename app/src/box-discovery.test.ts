import { describe, expect, it } from 'vitest'
import { finalizeEvent, type Event } from 'nostr-tools/pure'
import { matchFilters, type Filter } from 'nostr-tools/filter'
import { boxFixture } from '../../test/box-status-fixture.js'
import type { RelayTransport } from '../../src/relay-pool.js'
import { BOX_STATUS_MAX_AGE } from '../../src/box-status.js'
import { BoxDiscovery, boxDiscoveryRevision } from './box-discovery.js'
import { addContactFromCard, contactFor, forgetContact } from './contact-store.js'
import { memoryDeviceStore } from './device-store.js'
import { RelayConnections } from './relay-settings.js'

class Relay implements RelayTransport {
  closed = false
  subscriptions: { filters: Filter[]; receive: (e: Event) => void; ready: () => void; stopped: boolean }[] = []
  async publish(): Promise<void> { throw new Error('Discovery must never publish') }
  subscribe(filters: Filter[], receive: (e: Event) => void, ready = () => {}) {
    const sub = { filters, receive, ready, stopped: false }; this.subscriptions.push(sub)
    return () => { sub.stopped = true }
  }
  send(event: Event) { for (const s of [...this.subscriptions]) if (!s.stopped && matchFilters(s.filters, event)) s.receive(event) }
  eose() { for (const s of this.subscriptions) if (!s.stopped) s.ready() }
  close() { this.closed = true; for (const s of this.subscriptions) s.stopped = true }
}
function setup() {
  const f = boxFixture(), store = memoryDeviceStore(), pools: Relay[] = []
  let clock = f.now
  expect(addContactFromCard(store, f.contactCard, clock).ok).toBe(true)
  const options = { store, now: () => clock, ticking: false, transport: () => { const p = new Relay(); pools.push(p); return p }, changed: () => {} }
  const book = new BoxDiscovery(options)
  const start = () => { book.setEnabled(f.master, f.p, true); return pools.at(-1)! }
  const verify = (pool: Relay) => { pool.send(f.claim); pool.send(f.status()); pool.eose() }
  return { ...f, store, options, book, pools, start, verify, clock: (value: number) => { clock = value } }
}

describe('box discovery lifecycle', () => {
  it('makes no request without opt-in and waits for current claim/status history', () => {
    const f = setup(); f.book.reconcile(); expect(f.pools).toHaveLength(0)
    const pool = f.start(); pool.send(f.claim); pool.send(f.status())
    expect(f.book.circleRelays().size).toBe(0)
    expect(pool.subscriptions.some(s => s.filters[0]?.authors?.[0] === f.master && s.filters[0]?.['#d']?.[0] === f.p)).toBe(true)
    pool.eose()
    expect([...f.book.circleRelays().keys()]).toEqual(['wss://owned.example/drops'])
    expect(f.book.circleRelays().has('wss://transport.example/')).toBe(false)
    f.book.close()
  })
  it('invalidates retirement and refuses subsequent active events, including after a restart', () => {
    const f = setup(), pool = f.start(); f.verify(pool)
    const retired = finalizeEvent({ ...f.claim, created_at: f.now + 1, tags: f.claim.tags.filter(t => !(t[0] === 'p' && t[3] === 'stash')).map(t => t[0] === 'status' ? ['status', 'retired'] : t) }, f.masterKey)
    pool.send(retired)
    expect(f.book.circleRelays().size).toBe(0)
    expect(f.book.message(f.master, f.p)).toContain('retired')
    pool.send(finalizeEvent({ ...f.claim, created_at: f.now + 2 }, f.masterKey))
    expect(f.book.message(f.master, f.p)).toContain('retired')
    f.book.close()
    const again = new BoxDiscovery(f.options); again.reconcile()
    const reopened = f.pools.at(-1)!; f.verify(reopened)
    expect(again.circleRelays().size).toBe(0)
    expect(again.message(f.master, f.p)).toContain('retired')
    again.close()
  })
  it('detects an older retirement even when newer active history arrived first', () => {
    const f = setup(), pool = f.start(); f.verify(pool)
    pool.send(finalizeEvent({ ...f.claim, created_at: f.now + 20 }, f.masterKey))
    const retired = finalizeEvent({ ...f.claim, created_at: f.now + 10, tags: f.claim.tags.filter(t => !(t[0] === 'p' && t[3] === 'stash')).map(t => t[0] === 'status' ? ['status', 'retired'] : t) }, f.masterKey)
    pool.send(retired)
    expect(f.book.message(f.master, f.p)).toContain('retired'); f.book.close()
  })
  it('drops ownership when switched off or when a newer signed status is malformed', () => {
    const f = setup(), pool = f.start(); f.verify(pool)
    pool.send(f.status(f.withTag('drops', ['off']), f.now + 1))
    expect(f.book.circleRelays().size).toBe(0)
    pool.send(f.status(f.tags, f.now + 2))
    expect(f.book.circleRelays().size).toBe(1)
    pool.send(f.status(f.withTag('drops', ['on', 'ws://wrong.example']), f.now + 3))
    expect(f.book.circleRelays().size).toBe(0)
    pool.send(f.status(f.tags, f.now + 2))
    expect(f.book.circleRelays().size).toBe(0); f.book.close()
  })
  it('retains the newest signed denial across restart even if its payload is malformed', () => {
    const f = setup(), pool = f.start(); f.verify(pool)
    pool.send(f.status(f.withTag('drops', ['on', 'ws://wrong.example']), f.now + 1))
    f.book.close()
    const again = new BoxDiscovery(f.options); again.reconcile(); f.verify(f.pools.at(-1)!)
    expect(again.circleRelays().size).toBe(0)
    f.pools.at(-1)!.send(f.status(f.tags, f.now + 2))
    expect(again.circleRelays().size).toBe(1); again.close()
  })
  it('removes an expired lane at use time even if a sleeping tab missed its timers', () => {
    const f = setup(), pool = f.start(); f.verify(pool)
    const connections = new RelayConnections({ getItem: () => null, setItem: () => {} }, ['wss://owned.example/drops'], url => f.book.circleRelays().has(url))
    const live = connections.pool('default')
    expect(live.describe()[0]?.circle).toBe(true)
    f.clock(f.now + BOX_STATUS_MAX_AGE)
    expect(live.describe()[0]?.circle).toBeUndefined()
    expect(f.book.circleRelays().size).toBe(0)
    live.close(); f.book.close()
  })
  it('requires fresh network history after restart despite saved valid status', () => {
    const f = setup(), pool = f.start(); f.verify(pool); f.book.close()
    const again = new BoxDiscovery(f.options); again.reconcile()
    expect(again.circleRelays().size).toBe(0)
    f.verify(f.pools.at(-1)!)
    expect(again.circleRelays().size).toBe(1); again.close()
  })
  it('forgets state and refuses late callbacks without resurrecting the contact', () => {
    const f = setup(), pool = f.start(); f.verify(pool)
    const late = pool.subscriptions.map(s => s.receive)
    forgetContact(f.store, f.master); f.book.reconcile()
    for (const receive of late) receive(f.status(f.tags, f.now + 1))
    expect(f.book.circleRelays().size).toBe(0)
    expect(f.store.keys().filter(k => k.startsWith('kithmoot.box-discovery.'))).toEqual([])
    expect(pool.closed).toBe(true); f.book.close()
  })
  it('a replaced card disables the previous consent and rejects pending results', () => {
    const f = setup(), pool = f.start(); pool.send(f.claim)
    expect(addContactFromCard(f.store, f.contactCard, f.now + 1).ok).toBe(true)
    pool.send(f.status()); pool.eose()
    expect(f.book.circleRelays().size).toBe(0)
    f.book.reconcile(); expect(pool.closed).toBe(true)
    expect(f.book.enabled(f.master, f.p)).toBe(false); f.book.close()
  })
  it('a same-time conflict stays untrusted through EOSE and restart until a newer status', () => {
    const f = setup(), pool = f.start(); pool.send(f.claim); pool.send(f.status())
    pool.send(f.status(f.withTag('drops', ['off']))); pool.eose()
    expect(f.book.circleRelays().size).toBe(0); f.book.close()
    const again = new BoxDiscovery(f.options); again.reconcile(); const reopened = f.pools.at(-1)!; f.verify(reopened)
    expect(again.circleRelays().size).toBe(0)
    reopened.send(f.status(f.tags, f.now + 1))
    expect(again.circleRelays().size).toBe(1); again.close()
  })
  it('a confirmation for the previous card cannot opt its replacement into relay reads', () => {
    const f = setup(), original = contactFor(f.store, f.master)!
    const consent = boxDiscoveryRevision(original, original.boxes[0]!)
    expect(addContactFromCard(f.store, f.contactCard, f.now + 1).ok).toBe(true)
    expect(() => f.book.setEnabled(f.master, f.p, true, consent)).toThrow('This card changed')
    expect(f.pools).toHaveLength(0)
    expect(f.book.enabled(f.master, f.p)).toBe(false)
    const current = contactFor(f.store, f.master)!
    f.book.setEnabled(f.master, f.p, true, boxDiscoveryRevision(current, current.boxes[0]!))
    expect(f.pools).toHaveLength(1); f.book.close()
  })
  it('stopping discovery closes subscriptions and removes the automatic label', () => {
    const f = setup(), pool = f.start(); f.verify(pool)
    f.book.setEnabled(f.master, f.p, false)
    expect(pool.closed).toBe(true); expect(f.book.circleRelays().size).toBe(0); f.book.close()
  })
  it('stops network reads even when the preference cannot be saved', () => {
    const f = setup(), pool = f.start(); f.verify(pool)
    const save = f.store.set
    f.store.set = () => { throw new Error('storage full') }
    expect(() => f.book.setEnabled(f.master, f.p, false)).toThrow('storage full')
    expect(pool.closed).toBe(true); expect(f.book.circleRelays().size).toBe(0)
    expect(f.book.enabled(f.master, f.p)).toBe(false)
    f.store.set = save; f.book.tick(); f.book.restart()
    expect(f.pools).toHaveLength(1)
    f.book.setEnabled(f.master, f.p, true)
    expect(f.pools).toHaveLength(2); f.book.close()
  })
})
