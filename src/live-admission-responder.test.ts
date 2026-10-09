import { afterEach, describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { deriveRoom, encodeLivePersistentDescriptor, encodeLivePersistentRequest } from '@forgesworn/fold-kit'
import { LiveAdmissionBudget } from './live-admission-responder.js'
import { LiveKeeperJournal, type LiveKeeperStore } from './live-keeper.js'
import { RoomAgent } from './agent.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'

const NOW = 1_800_000_000
const agents: RoomAgent[] = [], hosts: { close(): void }[] = [], journals: LiveKeeperJournal[] = [], budgets: LiveAdmissionBudget[] = []
afterEach(async () => {
  await Promise.all(agents.splice(0).map(a => a.leave()))
  hosts.splice(0).forEach(h => h.close())
  await Promise.all(journals.splice(0).map(j => j.close()))
  await tick()
  budgets.splice(0).forEach(b => b.close())
})
function disk() {
  let raw: string | undefined, fail: 'before' | 'after' | undefined
  return { open: (): LiveKeeperStore => ({ load: () => raw, save: s => { if (fail === 'before') throw new Error('write failed'); raw = s; if (fail === 'after') throw new Error('uncertain save') }, close: () => {} }),
    read: () => JSON.parse(raw!), fail: (where: 'before' | 'after' = 'after') => { fail = where } }
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
function ledger(store = disk(), now = () => NOW) {
  const b = LiveAdmissionBudget.create(store.open(), now); budgets.push(b); return b
}
function room(now = () => NOW) {
  const store = disk(), j = LiveKeeperJournal.create(store.open(), { now }); journals.push(j)
  const state = j.snapshot(), context = { roomId: deriveRoom(state.secret).roomId,
    invitation: { bearer: state.bearer, inviter: getPublicKey(state.inviterSk), persistent: true as const } }
  const request = () => encodeLivePersistentRequest({ ...context, requesterSk: generateSecretKey(), now: now() })
  return { j, store, context, request }
}
function serve(b: LiveAdmissionBudget, j: LiveKeeperJournal, errors: unknown[] = []) {
  const relay = new SimRelay(), transport = new SimTransport(relay)
  const host = b.host(j, transport, e => errors.push(e)); hosts.push(host)
  return { relay, transport, host, errors, answers: () => relay.published.filter(e => e.kind === 20467) }
}
async function offer(s: ReturnType<typeof serve>, e: Event) { s.relay.publish(e); await tick(); await tick() }

describe('aggregate durable live admission responder', () => {
  it('shares the 16-challenge allowance across rooms and ledger reopening', async () => {
    const store = disk(), b = ledger(store), a = room(), c = room(), one = serve(b, a.j), two = serve(b, c.j)
    for (let i = 0; i < 16; i++) await offer(i % 2 ? one : two, i % 2 ? a.request() : c.request())
    expect(one.answers().length + two.answers().length).toBe(16)
    await offer(one, a.request()); expect(one.answers()).toHaveLength(8)
    one.host.close(); two.host.close(); await tick(); b.close()
    const back = LiveAdmissionBudget.open(store.open(), () => NOW); budgets.push(back)
    const again = serve(back, a.j)
    await offer(again, a.request()); expect(again.answers()).toHaveLength(0)
  })

  it('spends pre-crypto work on invalid signatures across rooms', async () => {
    const store = disk(), b = ledger(store), a = room(), c = room(), one = serve(b, a.j), two = serve(b, c.j)
    const bad = a.request(); bad.sig = '0'.repeat(128)
    for (let i = 0; i < 64; i++) await offer(one, bad)
    await offer(two, c.request())
    expect(one.answers()).toHaveLength(0); expect(two.answers()).toHaveLength(0)
    expect(store.read().reservations.filter((r: { checks: number }) => r.checks).length).toBe(64)
  })

  it('charges duplicate answer bytes globally without re-signing', async () => {
    const store = disk(), b = ledger(store), a = room(), c = room(), one = serve(b, a.j), two = serve(b, c.j)
    for (let i = 0; i < 16; i++) {
      const s = i % 2 ? one : two, req = i % 2 ? a.request() : c.request()
      for (let n = 0; n < 3; n++) await offer(s, req)
    }
    const replies = [...one.answers(), ...two.answers()]
    const bytes = replies.reduce((n, e) => n + new TextEncoder().encode(JSON.stringify(e)).length, 0)
    expect(replies.length).toBeGreaterThan(16); expect(replies.length).toBeLessThan(48)
    expect(bytes).toBeLessThanOrEqual(65536)
    const reservations = store.read().reservations as { bytes: number }[]
    expect(reservations.reduce((n, r) => n + r.bytes, 0)).toBe(bytes)
    const ids = new Map<string, number>()
    for (const reply of replies) ids.set(reply.id, (ids.get(reply.id) ?? 0) + 1)
    expect([...ids.values()].every(n => n <= 3)).toBe(true)
    expect([...ids.values()].some(n => n === 3)).toBe(true)
  })

  it('refuses duplicate runtime owners, nine rooms and a duplicate room', () => {
    const b = ledger(), rooms = Array.from({ length: 9 }, () => room())
    expect(() => ledger()).toThrow(/already owns/)
    const first = serve(b, rooms[0]!.j)
    expect(() => serve(b, rooms[0]!.j)).toThrow(/capacity|duplicate/)
    rooms.slice(1, 8).forEach(r => serve(b, r.j))
    expect(() => serve(b, rooms[8]!.j)).toThrow(/capacity/)
    expect(() => b.close()).toThrow(/close live admission rooms/)
    first.host.close(); serve(b, rooms[8]!.j)
  })

  it('poisons uncertain budget writes before any answer handoff and preserves charges', async () => {
    const store = disk(), b = ledger(store), a = room(), s = serve(b, a.j)
    store.fail(); await offer(s, a.request())
    expect(s.answers()).toHaveLength(0); expect(s.errors).toHaveLength(1)
    expect(store.read().reservations[0].checks).toBe(1)
    expect(() => serve(b, room().j)).toThrow(/unavailable/)
  })

  it('a write failure before persistence produces no answer and cannot be retried through the poisoned owner', async () => {
    const store = disk(), b = ledger(store), a = room(), s = serve(b, a.j)
    store.fail('before'); await offer(s, a.request())
    expect(s.answers()).toHaveLength(0); expect(s.errors).toHaveLength(1)
    expect(store.read().reservations).toHaveLength(0)
    expect(() => serve(b, a.j)).toThrow(/unavailable/)
  })

  it('requires an existing valid ledger on reopen and never imports room state as a budget', () => {
    expect(() => LiveAdmissionBudget.open(disk().open())).toThrow(/missing/)
    const wrong = disk(); wrong.open().save(JSON.stringify({ v: 1, kind: 'live-admission-budget', id: 'a'.repeat(64), lastAt: NOW, reservations: [{ at: NOW, checks: 65, challenges: 0, bytes: 0 }] }))
    expect(() => LiveAdmissionBudget.open(wrong.open())).toThrow(/invalid/)
    expect(() => LiveAdmissionBudget.open(room().store.open())).toThrow(/invalid/)
  })

  it('refuses rollback and frees an exhausted window only when time advances', async () => {
    let at = NOW
    const store = disk(), b = ledger(store, () => at), a = room(() => at), s = serve(b, a.j)
    await offer(s, a.request()); at--
    await offer(s, a.request()); expect(s.answers()).toHaveLength(1); expect(s.errors).toHaveLength(1)
    at += 61
    const again = serve(b, a.j); await offer(again, a.request()); expect(again.answers()).toHaveLength(1)
    expect(store.read().reservations.every((r: { at: number }) => r.at === at)).toBe(true)
  })

  it('holds a room slot until a blocked handoff drains and rejects queued output on close', async () => {
    const b = ledger(), a = room(), relay = new SimRelay()
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(r => { entered = r }), blocked = new Promise<void>(r => { release = r })
    const transport = new SimTransport(relay)
    transport.publish = async () => { entered(); await blocked }
    const h = b.host(a.j, transport, () => {}); hosts.push(h)
    relay.publish(a.request()); await waiting
    for (let i = 0; i < 20; i++) relay.publish(a.request())
    h.close()
    expect(() => serve(b, a.j)).toThrow(/duplicate/)
    release(); await a.j.checkpoint(a.j.snapshot()); await tick()
    serve(b, a.j)
  })

  it('actual RoomAgent.joinLive reaches the production responder and exchanges chat both ways', async () => {
    const b = ledger(), a = room(), relay = new SimRelay(), routes: string[][] = []
    const transport = (r: string[]) => { routes.push(r); return new SimTransport(relay) }
    const root = await RoomAgent.create({ name: 'Root', base: 'https://room.example/j/', liveKeeper: a.j,
      liveAdmission: b, transport, now: () => NOW, announceJitterMs: 0 }); agents.push(root)
    const client = await RoomAgent.joinLive({ name: 'Guest', link: root.url, descriptor: encodeLivePersistentDescriptor(a.context),
      deviceSk: generateSecretKey(), transport, now: () => NOW, announceJitterMs: 0 }); agents.push(client)
    await client.chat.send('from nearby guest')
    expect(root.chat.messages().some(m => m.text === 'from nearby guest')).toBe(true)
    await root.chat.send('from root')
    expect(client.chat.messages().some(m => m.text === 'from root')).toBe(true)
    expect(routes.every(r => r.length === 0)).toBe(true)
    await root.retireInvitation()
    const replies = relay.published.filter(e => e.kind === 20467).length
    relay.publish(a.request()); await tick()
    expect(relay.published.filter(e => e.kind === 20467)).toHaveLength(replies)
  })
})
