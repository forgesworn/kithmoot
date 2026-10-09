import { afterEach, describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { deriveRoom, encodeLivePersistentDescriptor, encodeInvitationRetirement } from '@forgesworn/fold-kit'
import { RoomAgent } from './agent.js'
import { LiveKeeperJournal } from './live-keeper.js'
import { localIdentity } from './identity.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { KINDS } from './kinds.js'

const agents: RoomAgent[] = [], stops: Array<() => void> = [], journals: LiveKeeperJournal[] = []
afterEach(async () => { stops.splice(0).forEach(f => f()); await Promise.all(agents.splice(0).map(a => a.leave())); await Promise.all(journals.splice(0).map(j => j.close())) })
function fixture() {
  let raw: string | undefined, at = 1_800_000_000
  const now = () => at, storage = () => ({ load: () => raw, save: (s: string) => { raw = s }, close: () => {} })
  const rootIdentity = localIdentity(generateSecretKey()), identity = localIdentity(generateSecretKey()), deviceSk = generateSecretKey()
  const journal = LiveKeeperJournal.create(storage(), { now }); journals.push(journal)
  const state = journal.snapshot(), descriptor = encodeLivePersistentDescriptor({ invitation: { bearer: state.bearer, inviter: getPublicKey(state.inviterSk), persistent: true }, roomId: deriveRoom(state.secret).roomId })
  const routes: string[][] = [], sent: Event[] = []
  async function start(j: LiveKeeperJournal, dropEpoch = false) {
    const relay = new SimRelay({ replay: true })
    class RootTransport extends SimTransport { override async publish(e: Event) { if (!dropEpoch || e.kind !== KINDS.EPOCH_GRANT) await super.publish(e) } }
    const root = await RoomAgent.create({ base: 'https://room.example/j/', name: 'Root', identity: rootIdentity, liveKeeper: j, transport: r => { routes.push(r); return new RootTransport(relay) }, now, announceJitterMs: 0 })
    agents.push(root)
    // One authority fixture: its per-journal allowance is the entire responder budget.
    // Production multi-room hosting still needs its shared durable quota owner.
    const reply = new RootTransport(relay)
    const stop = relay.subscribe([{ kinds: [20466] }], e => { void j.answer(e, event => reply.publish(event)).catch(() => {}) })
    stops.push(stop)
    const factory = (r: string[]) => {
      routes.push(r)
      return { publish: async (e: Event) => { sent.push(e); relay.publish(e) },
        subscribe: (filters: Parameters<SimTransport['subscribe']>[0], handler: Parameters<SimTransport['subscribe']>[1], eose?: () => void) => {
          const off = relay.subscribe(filters, handler); eose?.(); return off
        }, close: () => {} }
    }
    const join = async (signal?: AbortSignal) => {
      const a = await RoomAgent.joinLive({ link: root.url, descriptor, name: 'Client', identity, deviceSk, now,
        transport: factory, signal, announceJitterMs: 0, epochRequestTimeoutMs: 1000 })
      agents.push(a); return a
    }
    return { root, relay, join, stop, factory }
  }
  return { journal, state, descriptor, identity, deviceSk, now, routes, sent, start,
    reopen: () => { at += 2; const j = LiveKeeperJournal.open(storage(), now); journals.push(j); return j } }
}

describe('fresh persistent RoomAgent admission', () => {
  it('joins and chats both ways, then repeats with both room endpoints and transport rebuilt', async () => {
    const f = fixture(), first = await f.start(f.journal), client = await first.join()
    expect(client.hosting).toBe(false)
    expect(f.routes.every(r => r.length === 0)).toBe(true)
    await client.chat.send('client via explicit route')
    expect(first.root.chat.messages().some(m => m.text === 'client via explicit route')).toBe(true)
    await first.root.chat.send('root reply')
    expect(client.chat.messages().some(m => m.text === 'root reply')).toBe(true)
    await first.root.remove(getPublicKey(generateSecretKey()))
    expect(client.session.epoch).toBe(1)
    const originalRequest = f.sent.find(e => e.kind === 20466)!
    await client.leave(); first.stop(); await first.root.leave()
    const again = await f.start(f.reopen()), back = await again.join()
    expect(back.session.epoch).toBe(1)
    await back.chat.send('after both restarted')
    expect(again.root.chat.messages().some(m => m.text === 'after both restarted')).toBe(true)
    const latestRequest = f.sent.filter(e => e.kind === 20466).at(-1)!
    expect(latestRequest.id).not.toBe(originalRequest.id)
    expect(latestRequest.pubkey).not.toBe(originalRequest.pubkey)
    expect(f.sent.some(e => e.kind === KINDS.EPOCH_REQUEST)).toBe(true)
  })

  it('a retirement learned between live proof and epoch confirmation cancels the whole join', async () => {
    const f = fixture(), host = await f.start(f.journal, true)
    let entered!: () => void
    const started = new Promise<void>(r => { entered = r })
    host.relay.subscribe([{ kinds: [KINDS.EPOCH_REQUEST] }], () => entered())
    const result = host.join().then(() => undefined, error => error as Error)
    await started
    host.relay.publish(encodeInvitationRetirement({ invitation: host.root.link.invitation!, inviterSk: f.state.inviterSk, now: f.now() }))
    expect((await result)?.message).toMatch(/retired/)
    expect(f.sent.every(e => e.kind === 20466 || e.kind === KINDS.EPOCH_REQUEST)).toBe(true)
  })

  it('rejects mismatched descriptors before any route is opened', async () => {
    const f = fixture(), host = await f.start(f.journal)
    const opened = f.routes.length
    await expect(RoomAgent.joinLive({ link: host.root.url, descriptor: 'invalid', name: 'Client', deviceSk: f.deviceSk,
      transport: host.factory })).rejects.toThrow(/descriptor/)
    expect(f.routes.length).toBe(opened)
  })

  it('closes the entered room if disposing the temporary admission route fails', async () => {
    const f = fixture(), host = await f.start(f.journal)
    let opened = 0, subscriptions = 0
    const closed = new Set<number>()
    const transport = (relays: string[]) => {
      const index = opened++, base = host.factory(relays)
      return { ...base,
        subscribe: (...args: Parameters<typeof base.subscribe>) => {
          const off = base.subscribe(...args); subscriptions++
          let active = true
          return () => { if (active) { active = false; subscriptions--; off() } }
        },
        close: () => { closed.add(index); base.close(); if (index === 0) throw new Error('initial close failed') },
      }
    }
    await expect(RoomAgent.joinLive({ link: host.root.url, descriptor: f.descriptor, name: 'Client',
      identity: f.identity, deviceSk: f.deviceSk, now: f.now, transport,
      announceJitterMs: 0, epochRequestTimeoutMs: 1000 })).rejects.toThrow(/route cleanup failed/)
    expect(opened).toBeGreaterThan(1)
    expect(closed.size).toBe(opened)
    expect(subscriptions).toBe(0)
  })
})
