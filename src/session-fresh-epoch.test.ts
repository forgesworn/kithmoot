import { afterEach, describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { encodeEpochGrant } from './epoch.js'
import { RoomSession } from './session.js'
import { RoomAgent } from './agent.js'
import { LiveKeeperJournal } from './live-keeper.js'
import { localIdentity } from './identity.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { KINDS } from './kinds.js'

const NOW = 1_800_000_000, now = () => NOW
const agents: RoomAgent[] = [], sessions: RoomSession[] = [], journals: LiveKeeperJournal[] = []
afterEach(async () => { await Promise.all(sessions.splice(0).map(s => s.leave())); await Promise.all(agents.splice(0).map(a => a.leave())); await Promise.all(journals.splice(0).map(j => j.close())) })
async function setup(host = true, dropGrants = 0) {
  let raw: string | undefined
  const journal = LiveKeeperJournal.create({ load: () => raw, save: value => { raw = value }, close: () => {} }, { now })
  journals.push(journal)
  const relay = new SimRelay({ replay: true }), state = journal.snapshot()
  class RootTransport extends SimTransport { override async publish(e: Event) {
    if (e.kind === KINDS.EPOCH_GRANT && dropGrants-- > 0) return
    await super.publish(e)
  } }
  let root: RoomAgent | undefined
  if (host) { root = await RoomAgent.create({ name: 'Root', base: 'https://room.example/', liveKeeper: journal, transport: () => new RootTransport(relay), now, announceJitterMs: 0 }); agents.push(root) }
  const sent: Event[] = []
  class ClientTransport extends SimTransport { override async publish(event: Event) { sent.push(event); await super.publish(event) } }
  const create = (extra: Partial<ConstructorParameters<typeof RoomSession>[0]> = {}) => {
    const session = new RoomSession({ transport: new ClientTransport(relay), secret: state.secret, authority: getPublicKey(state.inviterSk),
      identity: localIdentity(generateSecretKey()), deviceSk: generateSecretKey(), name: 'New client', now, announceJitterMs: 0,
      expectedEpoch: 0, epochSettleMs: 0, requireFreshEpoch: true, epochRequestTimeoutMs: 100, ...extra } as ConstructorParameters<typeof RoomSession>[0])
    sessions.push(session); return session
  }
  return { journal, state, relay, root, sent, create }
}
const outcome = (p: Promise<void>) => p.then(() => undefined, error => error as Error)

describe('fresh root epoch gate', () => {
  it('requires a root round trip at epoch zero before publishing roster or chat', async () => {
    const f = await setup(), client = f.create()
    await client.join([], {})
    expect(f.sent[0]!.kind).toBe(KINDS.EPOCH_REQUEST)
    const requestAt = f.relay.published.findIndex(e => e.id === f.sent[0]!.id)
    const grantAt = f.relay.published.findIndex(e => e.kind === KINDS.EPOCH_GRANT)
    const rosterAt = f.relay.published.findIndex(e => e.kind === KINDS.ROSTER && e.pubkey === client.device)
    expect(grantAt).toBeGreaterThan(requestAt)
    expect(rosterAt).toBeGreaterThan(grantAt)
    await client.chat.send('fresh client')
    expect(f.root!.chat.messages().some(m => m.text === 'fresh client')).toBe(true)
  })

  it('EOSE and silence at epoch zero never release presence, chat or farewell', async () => {
    const f = await setup(false), client = f.create()
    await expect(client.join([], {})).rejects.toThrow()
    expect(() => client.chat).toThrow(/join/)
    expect(f.sent.length).toBeGreaterThan(0)
    expect(f.sent.every(e => e.kind === KINDS.EPOCH_REQUEST)).toBe(true)
  })

  it('recovers two lost grants using three fresh requests to the existing root desk', async () => {
    const f = await setup(true, 2), client = f.create({ epochRequestTimeoutMs: 600 })
    await client.join([], {})
    const requests = f.sent.filter(e => e.kind === KINDS.EPOCH_REQUEST)
    expect(requests).toHaveLength(3)
    expect(new Set(requests.map(e => e.id)).size).toBe(3)
    expect(f.sent.slice(0, 3).every(e => e.kind === KINDS.EPOCH_REQUEST)).toBe(true)
    await client.chat.send('after two lost grants')
    expect(f.root!.chat.messages().some(m => m.text === 'after two lost grants')).toBe(true)
  })

  it('a late grant to a superseded request cannot open the fresh gate', async () => {
    const f = await setup(false), client = f.create({ epochRequestTimeoutMs: 300 })
    let held: Event | undefined
    f.relay.subscribe([{ kinds: [KINDS.EPOCH_REQUEST] }], request => {
      if (held) f.relay.publish(held)
      else held = encodeEpochGrant({ roomId: client.roomId, authoritySk: f.state.inviterSk,
        device: request.pubkey, request: request.id, epoch: { epoch: 0, secret: f.state.secret }, removed: [], now: NOW })
    })
    await expect(client.join([], {})).rejects.toThrow()
    expect(f.sent.every(e => e.kind === KINDS.EPOCH_REQUEST)).toBe(true)
    expect(() => client.chat).toThrow(/join/)
  })

  it.each(['removed', 'unknown'])('keeps the root %s policy instead of letting in a challenge identity', async refused => {
    const f = await setup(), identity = localIdentity(generateSecretKey())
    await f.root!.remove(refused === 'removed' ? identity.pubkey : getPublicKey(generateSecretKey()))
    const client = f.create({ identity })
    await expect(client.join([], {})).rejects.toThrow()
    expect(f.sent.every(e => e.kind === KINDS.EPOCH_REQUEST)).toBe(true)
    expect(f.root!.session.knows(identity.pubkey)).toBe(false)
  })

  it('ignores a valid root grant below the invitation hint', async () => {
    const f = await setup(false), client = f.create({ expectedEpoch: 1 })
    f.relay.subscribe([{ kinds: [KINDS.EPOCH_REQUEST] }], request => {
      f.relay.publish(encodeEpochGrant({ roomId: client.roomId, authoritySk: f.state.inviterSk,
        device: request.pubkey, request: request.id, epoch: { epoch: 0, secret: f.state.secret }, removed: [], now: NOW }))
    })
    await expect(client.join([], {})).rejects.toThrow()
    expect(f.sent.every(e => e.kind === KINDS.EPOCH_REQUEST)).toBe(true)
  })

  it('refuses a root grant with a different key for the already-known epoch', async () => {
    const f = await setup(false), client = f.create({ epoch: { epoch: 1, secret: generateSecretKey() }, expectedEpoch: 1 })
    f.relay.subscribe([{ kinds: [KINDS.EPOCH_REQUEST] }], request => {
      f.relay.publish(encodeEpochGrant({ roomId: client.roomId, authoritySk: f.state.inviterSk,
        device: request.pubkey, request: request.id, epoch: { epoch: 1, secret: generateSecretKey() }, removed: [], now: NOW }))
    })
    await expect(client.join([], {})).rejects.toThrow()
    expect(f.sent.every(e => e.kind === KINDS.EPOCH_REQUEST)).toBe(true)
  })

  it.each(['signal', 'leave'])('cancels through %s and cannot resume when a late grant arrives', async mode => {
    const f = await setup(false), controller = new AbortController(), client = f.create({ admissionSignal: controller.signal, epochRequestTimeoutMs: 20_000 })
    let entered!: () => void
    const started = new Promise<void>(r => { entered = r })
    f.relay.subscribe([{ kinds: [KINDS.EPOCH_REQUEST] }], () => entered())
    const joining = outcome(client.join([], {}))
    await started
    await expect(client.advertise([], {})).rejects.toThrow(/not confirmed/)
    if (mode === 'signal') controller.abort(); else await client.leave()
    expect(await joining).toBeInstanceOf(Error)
    const request = f.sent[0]!
    f.relay.publish(encodeEpochGrant({ roomId: client.roomId, authoritySk: f.state.inviterSk, device: client.device,
      request: request.id, epoch: { epoch: 0, secret: f.state.secret }, now: NOW }))
    await Promise.resolve()
    expect(f.sent.every(e => e.kind === KINDS.EPOCH_REQUEST)).toBe(true)
    expect(() => client.chat).toThrow(/join/)
  })

  it('refuses a fresh gate without a pinned authority', async () => {
    const f = await setup(false)
    expect(() => f.create({ authority: undefined })).toThrow(/pinned authority/)
    expect(f.sent).toHaveLength(0)
  })
})
