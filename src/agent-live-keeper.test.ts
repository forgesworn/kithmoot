import { afterEach, describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { encodeInvitationRequest } from '@forgesworn/fold-kit'
import { RoomAgent } from './agent.js'
import { RoomSession } from './session.js'
import { LiveKeeperJournal, type LiveKeeperStore } from './live-keeper.js'
import { localIdentity } from './identity.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { KINDS } from './kinds.js'

const NOW = 1_800_000_000, now = () => NOW
const agents: RoomAgent[] = [], sessions: RoomSession[] = [], journals: LiveKeeperJournal[] = []
afterEach(async () => {
  await Promise.all(agents.splice(0).map(a => a.leave()))
  await Promise.all(sessions.splice(0).map(s => s.leave()))
  await Promise.all(journals.splice(0).map(j => j.close()))
})
function storage() {
  let raw: string | undefined, owned = false
  const disk = { fail: '' }
  const open = (): LiveKeeperStore => {
    if (owned) throw new Error('owned')
    owned = true
    return { load: () => raw, save: value => {
      if (disk.fail === 'before') throw new Error('disk failed')
      raw = value
      if (disk.fail === 'after') throw new Error('uncertain save')
    }, close: () => { owned = false } }
  }
  const create = () => { const j = LiveKeeperJournal.create(open(), { now }); journals.push(j); return j }
  const reopen = () => { const j = LiveKeeperJournal.open(open(), now); journals.push(j); return j }
  return { disk, create, reopen }
}
async function root(journal: LiveKeeperJournal, relay: SimRelay, make = (_relays: string[]) => new SimTransport(relay)) {
  const a = await RoomAgent.create({ name: 'Keeper', base: 'https://room.example/j/', liveKeeper: journal, transport: make, now, announceJitterMs: 0 })
  agents.push(a); return a
}
async function member(journal: LiveKeeperJournal, relay: SimRelay) {
  const state = journal.snapshot()
  const s = new RoomSession({ transport: new SimTransport(relay), secret: state.secret,
    authority: getPublicKey(state.inviterSk), expectedEpoch: 0, identity: localIdentity(generateSecretKey()),
    deviceSk: generateSecretKey(), name: 'Member', now, announceJitterMs: 0 })
  sessions.push(s); await s.join([], {}); return s
}
const sameBytes = (a?: Uint8Array, b?: Uint8Array) => a !== undefined && b !== undefined && Buffer.from(a).equals(Buffer.from(b))

// Real RoomAgent and RoomSession, in-process transport; no physical or public-network claim.
describe('root room owned by a live keeper journal', () => {
  it('uses only the explicit route and never starts the delegated invitation responder', async () => {
    const store = storage(), j = store.create(), relay = new SimRelay(), routes: string[][] = []
    const a = await root(j, relay, r => { routes.push(r); return new SimTransport(relay) })
    expect(routes).toEqual([[]])
    await expect(root(j, relay)).rejects.toThrow(/already belongs/)
    expect(j.status).toBe('active')
    expect(a.hosting).toBe(false)
    expect(relay.published.some(e => e.kind === KINDS.GROUP_INVITATION)).toBe(false)
    const state = j.snapshot()
    relay.publish(encodeInvitationRequest({ invitation: a.link.invitation!, requesterSk: generateSecretKey(), participant: getPublicKey(generateSecretKey()), now: NOW }))
    await new Promise(r => setTimeout(r, 0))
    expect(relay.published.some(e => e.kind === KINDS.INVITATION_GRANT)).toBe(false)
    expect(sameBytes(j.snapshot().secret, state.secret)).toBe(true)
  })

  it('persists actual session rekeys, member metadata and channels before reopening', async () => {
    const store = storage(), j = store.create(), relay = new SimRelay(), a = await root(j, relay)
    const b = await member(j, relay)
    await a.setChannel('radio', true)
    const nudge = getPublicKey(generateSecretKey())
    await a.amendKeeperState({ nudge: [nudge] })
    await a.session.rekey({ authoritySk: j.snapshot().inviterSk, scheduled: true })
    expect(a.session.epoch).toBe(1)
    expect(j.snapshot().epoch).toBe(1)
    expect(sameBytes(j.snapshot().epochSecret, a.session.currentEpoch().secret)).toBe(true)
    expect(j.snapshot().members).toContain(b.participant)
    await a.leave()
    const back = store.reopen(), again = await root(back, relay)
    expect(again.session.epoch).toBe(1)
    expect(again.session.knows(b.participant)).toBe(true)
    expect(back.snapshot().channels).toEqual(['radio'])
    expect(back.snapshot().nudge).toEqual([nudge])
    expect(again.session.pastSecrets().map(e => e.epoch)).toContain(0)
  })

  it('blocks ordinary publication and competing rekeys until the retained handoff finishes', async () => {
    const store = storage(), j = store.create(), relay = new SimRelay()
    let release!: () => void, entered!: () => void
    const started = new Promise<void>(r => { entered = r })
    class Held extends SimTransport {
      override async publish(event: Event) {
        if (event.kind === KINDS.ROOM_REKEY) {
          entered(); await new Promise<void>(r => { release = r })
        }
        await super.publish(event)
      }
    }
    const a = await root(j, relay, () => new Held(relay)), sk = j.snapshot().inviterSk
    const moving = a.session.rekey({ authoritySk: sk })
    await started
    expect(j.status).toBe('pending')
    const id = j.pendingEvents()[0]!.id
    await expect(a.session.rekey({ authoritySk: sk })).rejects.toThrow(/changing epoch/)
    await expect(a.chat.send('must wait')).rejects.toThrow(/blocks publication/)
    expect(j.pendingEvents()[0]!.id).toBe(id)
    release(); await moving
    expect(a.session.epoch).toBe(1)
    expect(j.status).toBe('active')
    await a.chat.send('after transition')
    expect(relay.published.filter(e => e.kind === KINDS.ROOM_REKEY).map(e => e.id)).toEqual([id])
  })

  it('keeps new-epoch chat replayed while its own handoff finishes', async () => {
    const store = storage(), j = store.create(), relay = new SimRelay({ replay: true })
    let peer: RoomSession | undefined
    class ReplyBeforeAcceptance extends SimTransport {
      override async publish(event: Event) {
        await super.publish(event)
        if (event.kind === KINDS.ROOM_REKEY) {
          expect(peer!.epoch).toBe(1)
          await peer!.chat.send('arrived before keeper committed')
        }
      }
    }
    const a = await root(j, relay, () => new ReplyBeforeAcceptance(relay))
    peer = await member(j, relay)
    void a.chat
    await a.session.rekey({ authoritySk: j.snapshot().inviterSk })
    expect(a.chat.messages().some(m => m.text === 'arrived before keeper committed')).toBe(true)
  })

  it('stops on uncertain handoff and drains the same event before the restarted roster', async () => {
    const store = storage(), j = store.create(), relay = new SimRelay()
    class Uncertain extends SimTransport {
      override async publish(event: Event) {
        await super.publish(event)
        if (event.kind === KINDS.ROOM_REKEY) throw new Error('lost acceptance')
      }
    }
    const a = await root(j, relay, () => new Uncertain(relay))
    await expect(a.session.rekey({ authoritySk: j.snapshot().inviterSk })).rejects.toThrow('lost acceptance')
    const id = j.pendingEvents()[0]!.id
    await expect(a.session.rekey({ authoritySk: j.snapshot().inviterSk })).rejects.toThrow(/unavailable/)
    const before = relay.published.length, back = store.reopen(), again = await root(back, relay)
    const sent = relay.published.slice(before)
    expect(sent[0]!.id).toBe(id)
    expect(sent.findIndex(e => e.kind === KINDS.ROSTER)).toBeGreaterThan(0)
    expect(again.session.epoch).toBe(1)
    expect(sameBytes(back.snapshot().epochSecret, again.session.currentEpoch().secret)).toBe(true)
    expect(relay.published.filter(e => e.kind === KINDS.ROOM_REKEY).map(e => e.id)).toEqual([id, id])
  })

  it.each(['before', 'after'])('stops the real root on %s-save failure without handing off a rekey', async failure => {
    const store = storage(), j = store.create(), relay = new SimRelay(), a = await root(j, relay)
    store.disk.fail = failure
    await expect(a.session.rekey({ authoritySk: j.snapshot().inviterSk })).rejects.toThrow()
    expect(relay.published.some(e => e.kind === KINDS.ROOM_REKEY)).toBe(false)
    await expect(a.session.rekey({ authoritySk: j.snapshot().inviterSk })).rejects.toThrow(/unavailable/)
    store.disk.fail = ''
    const back = store.reopen(), again = await root(back, relay)
    expect(again.session.epoch).toBe(failure === 'after' ? 1 : 0)
  })

  it('keeps retirement sticky across an actual room restart and later rekey', async () => {
    const store = storage(), j = store.create(), relay = new SimRelay(), a = await root(j, relay)
    await a.retireInvitation()
    expect(j.status).toBe('retired')
    await a.leave()
    const back = store.reopen(), again = await root(back, relay)
    expect(back.status).toBe('retired')
    await again.session.rekey({ authoritySk: back.snapshot().inviterSk })
    expect(back.status).toBe('retired')
    expect(back.snapshot().epoch).toBe(1)
    expect(relay.published.some(e => e.kind === KINDS.GROUP_INVITATION)).toBe(false)
  })

  it('stages close and retirement together, and recovery never publishes a new roster', async () => {
    const store = storage(), j = store.create(), relay = new SimRelay()
    class LostClose extends SimTransport {
      override async publish(event: Event) {
        if (event.kind === KINDS.INVITATION_RETIREMENT) throw new Error('retirement uncertain')
        await super.publish(event)
      }
    }
    const a = await root(j, relay, () => new LostClose(relay))
    await expect(a.closeRoom(undefined, { destruct: true })).rejects.toThrow('retirement uncertain')
    const ids = j.pendingEvents().map(e => e.id)
    expect(j.pendingEvents().map(e => e.kind)).toEqual([KINDS.INVITATION_RETIREMENT, KINDS.ROOM_REKEY])
    const before = relay.published.length, back = store.reopen()
    await expect(root(back, relay)).rejects.toThrow(/not available/)
    expect(relay.published.slice(before).map(e => e.id)).toEqual(ids)
    const closed = store.reopen()
    expect(closed.status).toBe('closed')
    expect(closed.snapshot().destruct).toBe(true)
  })

  it('closes transport and releases the journal when session construction fails', async () => {
    const store = storage(), j = store.create()
    let closed = false
    await expect(RoomAgent.create({ name: 'Keeper', base: 'https://room.example/', liveKeeper: j, deviceSk: new Uint8Array(32),
      transport: () => ({ publish: async () => {}, subscribe: () => () => {}, close: () => { closed = true } }) })).rejects.toThrow()
    expect(closed).toBe(true)
    const back = store.reopen()
    expect(back.status).toBe('active')
  })

  it('refuses implicit routing and conflicting keeper options before opening transport', async () => {
    const store = storage(), j = store.create()
    await expect(RoomAgent.create({ name: 'Keeper', base: 'https://room.example/', liveKeeper: j })).rejects.toThrow(/explicit transport/)
    const again = store.reopen()
    let opened = false
    await expect(RoomAgent.create({ name: 'Keeper', base: 'https://room.example/', liveKeeper: again, relays: [],
      transport: () => { opened = true; return new SimTransport(new SimRelay()) } })).rejects.toThrow(/explicit transport/)
    expect(opened).toBe(false)
  })
})
