import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { createRoomInvitation, generateRoomSecret } from '@forgesworn/fold-kit'
import type { Event } from 'nostr-tools/pure'
import { RoomAgent } from './agent.js'
import type { KeeperState } from './agent.js'
import { CONTROL_CHANNEL, decodeControl, encodeControl } from './control.js'
import type { GroupGrantsConfig } from './group-grants-keeper.js'
import { decodePersistentInvitation } from './persistent-invitation.js'
import { verifyRoomStorage } from './room-storage.js'
import { KINDS } from './kinds.js'
import { localIdentity } from './identity.js'
import { parseKeeperState, serialiseKeeperState } from './keeper-state.js'
import { SimRelay, SimTransport } from '../test/sim-relay.js'
import { FakeNodes, MemoryStore, waitFor } from '../test/group-grants-fixtures.js'

const BASE = 'https://example.test/j/'
const A = 'https://node-a.test:8080'
const B = 'https://node-b.test'
const C = 'https://node-c.test/wb/one'

const transportFor = (relay: SimRelay) => () => new SimTransport(relay)

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

function config(nodes: FakeNodes, urls: string[], store = new MemoryStore(), over: Partial<GroupGrantsConfig> = {}): GroupGrantsConfig {
  return {
    nodes: urls, bytes: 1_000_000, store, fetch: nodes.fetch,
    backoff: { baseMs: 5, maxMs: 20 }, pushBudgetMs: 200, rosterDelayMs: 5, sweepIntervalMs: 3_600_000, ...over,
  }
}

/** A keeper on a shared relay with a controllable clock, whose state writes are kept. */
function harness() {
  const relay = new SimRelay({ replay: true })
  const fake = new FakeNodes('')
  let clock = 1_800_000_000
  const states: KeeperState[] = []
  const store = new MemoryStore()
  let latest: RoomAgent | undefined
  const start = async (over: Partial<Parameters<typeof RoomAgent.create>[0]> = {}) => {
    latest = await RoomAgent.create({
      base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: transportFor(relay), announceJitterMs: 0,
      now: () => clock, onState: (s) => { states.push(s) }, ...over,
    })
    return latest
  }
  const join = (link: string, name = 'Ada') =>
    RoomAgent.join({ link, name, identity: localIdentity(generateSecretKey()), deviceSk: generateSecretKey(), transport: transportFor(relay), announceJitterMs: 0, now: () => clock, timing: { heartbeatIntervalMs: 40 } })
  const invitations = (): Event[] => relay.published.filter((e) => e.kind === KINDS.GROUP_INVITATION)
  const ops = (agent: RoomAgent) => agent.channel(CONTROL_CHANNEL).messages().flatMap((m) => {
    const c = decodeControl(m.text)
    return c?.op === 'storage' ? [c] : []
  })
  return { relay, fake, store, states, start, join, invitations, ops, tick: (s: number) => { clock += s }, get clock() { return clock }, last: () => latest!.keeperState! }
}

describe('a keeper that lists the room\'s storage nodes', { timeout: 30_000 }, () => {
  it('a new room publishes a plain copy, then the copy with storage, and posts the op at the second copy\'s time', async () => {
    const h = harness()
    let publishedAtFirstWrite = -1
    const keeper = await h.start({
      groupGrants: config(h.fake, [A, B, C], h.store),
      onState: (s) => { if (publishedAtFirstWrite < 0) publishedAtFirstWrite = h.invitations().length; h.states.push(s) },
    })
    // The state naming the list is written before the first copy goes to a relay.
    expect(publishedAtFirstWrite).toBe(0)
    const invitation = keeper.link.invitation!
    const copies = h.invitations()
    expect(copies.length).toBe(2)
    const [plain, listed] = copies.map((e) => decodePersistentInvitation(e, invitation)!)
    expect(plain.storage).toBeUndefined()
    expect(listed.storage).toEqual([A, B, C])
    expect(copies[0]!.created_at).toBe(h.clock - 1)
    expect(copies[1]!.created_at).toBe(h.clock)
    expect(listed.storageAt).toBe(h.clock)
    expect(plain.relays).toEqual(listed.relays)
    expect(plain.secret).toEqual(listed.secret)

    await waitFor(() => h.ops(keeper).length === 1)
    const op = h.ops(keeper)[0]!
    expect(op.nodes).toEqual([A, B, C])
    expect(op.version).toBe(h.clock)
    expect(verifyRoomStorage({ roomId: keeper.roomId, version: op.version, nodes: op.nodes, sig: op.sig, authority: invitation.inviter })).toBe(true)
    expect(keeper.storageNodes).toEqual([A, B, C])

    // The state records the list and the signed invitation, before a restart needs them.
    const state = h.last()
    expect(state.storage).toEqual([A, B, C])
    expect(state.invitation?.id).toBe(copies[1]!.id)
    expect(parseKeeperState(serialiseKeeperState(state)).storage).toEqual([A, B, C])
    await keeper.leave()
  })

  it('a member learns the list from the invitation at join, and from the op', async () => {
    const h = harness()
    const keeper = await h.start({ groupGrants: config(h.fake, [A, B], h.store) })
    const ada = await h.join(keeper.url)
    expect(ada.storageNodes).toEqual([A, B])
    await keeper.leave()
    await ada.leave()
  })

  it('a restart with the same flags republishes the stored invitation unchanged and posts the op with the same version', async () => {
    const h = harness()
    const first = await h.start({ groupGrants: config(h.fake, [A, B], h.store) })
    const stored = h.invitations().at(-1)!
    const url = first.url
    await first.leave()
    h.tick(3600)
    const again = await h.start({ state: h.last(), groupGrants: config(h.fake, [A, B], h.store) })
    expect(again.url).toBe(url)
    const copies = h.invitations()
    // One more event, the very same one: no fresh copy was signed.
    expect(copies.length).toBe(3)
    expect(copies[2]).toEqual(stored)
    await waitFor(() => h.ops(again).length >= 1)
    expect(h.ops(again).every((o) => o.version === stored.created_at)).toBe(true)
    await again.leave()
  })

  it('a restart that changes the list signs one new copy, and its op carries the new version', async () => {
    const h = harness()
    const first = await h.start({ groupGrants: config(h.fake, [A, B], h.store) })
    await first.leave()
    h.tick(3600)
    const again = await h.start({ state: h.last(), groupGrants: config(h.fake, [B, A, C], h.store) })
    const copies = h.invitations()
    expect(copies.length).toBe(3)
    const fresh = decodePersistentInvitation(copies[2]!, again.link.invitation!)!
    expect(fresh.storage).toEqual([B, A, C])
    expect(copies[2]!.created_at).toBe(h.clock)
    expect(h.last().storage).toEqual([B, A, C])
    await waitFor(() => h.ops(again).some((o) => o.version === h.clock))
    expect(again.storageNodes).toEqual([B, A, C])
    await again.leave()
  })

  it('refuses to start without the flags while the room lists nodes, naming the hosts and both ways out', async () => {
    const h = harness()
    const first = await h.start({ groupGrants: config(h.fake, [A, B], h.store) })
    await first.leave()
    const before = h.invitations().length
    await expect(h.start({ state: h.last() })).rejects.toThrow(
      'this room lists group storage nodes (node-a.test, node-b.test); start the keeper with the same --group-node and --group-bytes flags, or with --group-withdraw to stop listing them',
    )
    expect(h.invitations().length).toBe(before)
  })

  it('withdrawing signs an empty list into the invitation and the op, records it, and signs [] again on every start', async () => {
    const h = harness()
    const first = await h.start({ groupGrants: config(h.fake, [A, B], h.store) })
    await first.leave()
    h.tick(3600)
    const withdrawn = await h.start({ state: h.last(), groupWithdraw: true })
    const empty = h.invitations().at(-1)!
    expect(decodePersistentInvitation(empty, withdrawn.link.invitation!)!.storage).toEqual([])
    expect(h.last().storage).toEqual([])
    await waitFor(() => h.ops(withdrawn).some((o) => o.nodes.length === 0))
    expect(withdrawn.storageNodes).toEqual([])
    await withdrawn.leave()

    // A later start with no group flags at all: the room still lists nothing, and says so again, with the very same copy.
    h.tick(3600)
    const quiet = await h.start({ state: h.last() })
    expect(h.invitations().at(-1)).toEqual(empty)
    await waitFor(() => h.ops(quiet).filter((o) => o.nodes.length === 0).length >= 1)
    expect(quiet.storageNodes).toEqual([])
    expect(h.last().storage).toEqual([])
    await quiet.leave()
  })

  it('group flags cannot be combined with --group-withdraw', async () => {
    const h = harness()
    await expect(h.start({ groupGrants: config(h.fake, [A], h.store), groupWithdraw: true })).rejects.toThrow('cannot be withdrawn while group nodes are given')
  })

  it('a member takes the newest signed op, ignores an older, forged or reposted-stale one, and lets a reposted newer one stand', async () => {
    const h = harness()
    const keeper = await h.start({ groupGrants: config(h.fake, [A, B], h.store) })
    const ada = await h.join(keeper.url)
    const bob = await h.join(keeper.url, 'Bob')
    const op = h.ops(keeper)[0]!
    expect(ada.storageNodes).toEqual([A, B])
    // A forged newer op from a member: not signed by the authority.
    await ada.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'storage', nodes: [C], version: op.version + 1000, sig: 'ab'.repeat(64) }))
    await settle()
    expect(bob.storageNodes).toEqual([A, B])
    // The keeper restarts with a new list; bob, still in the room, hears the newer op.
    await keeper.leave()
    h.tick(60)
    const again = await h.start({ state: h.last(), groupGrants: config(h.fake, [C], h.store) })
    await waitFor(() => bob.storageNodes?.[0] === C)
    expect(bob.storageNodes).toEqual([C])
    // A member reposting the OLD signed op cannot undo the newer one.
    await ada.channel(CONTROL_CHANNEL).send(encodeControl(op))
    await settle()
    expect(bob.storageNodes).toEqual([C])
    for (const a of [again, ada, bob]) await a.leave()
  })

  it('a second keeper copy that signed another list is warned about and never adopted', async () => {
    const h = harness()
    const lines: string[] = []
    const keeper = await h.start({ groupGrants: config(h.fake, [A, B], h.store, { log: (l) => lines.push(l) }) })
    // The same authority (a second instance on the same state) restarts with another list and posts its op.
    const other = await h.start({ state: h.last(), groupGrants: config(h.fake, [C], new MemoryStore()) })
    await waitFor(() => lines.some((l) => l.includes('another keeper copy signed a different storage list')))
    expect(keeper.storageNodes).toEqual([A, B])
    for (const a of [keeper, other]) await a.leave()
  })
})

describe('a keeper without group flags and without storage in its state', { timeout: 30_000 }, () => {
  it('signs a plain invitation with no storage key and no op, as before', async () => {
    const h = harness()
    const keeper = await h.start()
    const copies = h.invitations()
    expect(copies.length).toBe(1)
    const decoded = decodePersistentInvitation(copies[0]!, keeper.link.invitation!)!
    expect('storage' in decoded).toBe(false)
    expect(copies[0]!.created_at).toBe(h.clock)
    await settle()
    expect(h.ops(keeper)).toEqual([])
    expect(keeper.storageNodes).toBeUndefined()
    expect(h.last().storage).toBeUndefined()
    expect(h.last().invitation?.id).toBe(copies[0]!.id)
    await keeper.leave()
  })

  it('A8: a restart republishes the stored copy unchanged; a state from before the upgrade signs one fresh copy and keeps it', async () => {
    const h = harness()
    const first = await h.start()
    const stored = h.invitations()[0]!
    await first.leave()
    h.tick(3600)
    const again = await h.start({ state: h.last() })
    expect(h.invitations().length).toBe(2)
    expect(h.invitations()[1]).toEqual(stored)
    await again.leave()

    // A state written before this field existed: nothing to reuse, so one fresh copy, then it is kept.
    const { invitation: _dropped, ...older } = h.last()
    h.tick(3600)
    const upgraded = await h.start({ state: older })
    expect(h.invitations().length).toBe(3)
    const fresh = h.invitations()[2]!
    expect(fresh.created_at).toBe(h.clock)
    expect(fresh.id).not.toBe(stored.id)
    expect(h.last().invitation?.id).toBe(fresh.id)
    await upgraded.leave()
    h.tick(3600)
    const later = await h.start({ state: h.last() })
    expect(h.invitations().length).toBe(4)
    expect(h.invitations()[3]).toEqual(fresh)
    await later.leave()
  })

  it('a changed body (the room\'s end) is signed anew', async () => {
    const h = harness()
    const first = await h.start({ endsAt: 1_800_000_000 + 7200 })
    await first.leave()
    h.tick(60)
    const again = await h.start({ state: { ...h.last(), endsAt: 1_800_000_000 + 9000 } })
    expect(h.invitations().length).toBe(2)
    expect(h.invitations()[1]!.id).not.toBe(h.invitations()[0]!.id)
    await again.leave()
  })
})

describe('a withdrawn room and its grant ledger', { timeout: 30_000 }, () => {
  it('mints and renews nothing for a new device, but a removal still revokes at the nodes the ledger names', async () => {
    const h = harness()
    h.fake.clock = () => h.clock
    const store = h.store
    const first = await h.start({ groupGrants: config(h.fake, [A, B], store) })
    h.fake.keeper = first.link.invitation!.inviter
    const ada = await h.join(first.url)
    await waitFor(() => (first.groupGrantLedger?.grants.length ?? 0) === 2)
    await waitFor(() => h.fake.posts.filter((p) => p.status === 201).length === 2)
    await first.leave()
    h.tick(60)

    const withdrawn = await h.start({
      state: h.last(), groupWithdraw: true,
      groupGrants: { nodes: [], bytes: '', withdrawn: true, store, fetch: h.fake.fetch, backoff: { baseMs: 5, maxMs: 20 }, pushBudgetMs: 200, rosterDelayMs: 5 },
    })
    expect(withdrawn.storageNodes).toEqual([])
    // A grant keeper is running over the old ledger.
    expect(withdrawn.groupGrantLedger?.grants.length).toBe(2)
    const bob = await h.join(withdrawn.url, 'Bob')
    await settle()
    await withdrawn.sweepGroupGrants()
    expect(withdrawn.groupGrantLedger!.grants.length).toBe(2)
    expect(withdrawn.groupGrantLedger!.resets.length).toBe(0)

    // Removing Ada still ends her grants at both nodes.
    const seen = h.fake.posts.length
    await ada.leave().catch(() => {})
    await withdrawn.remove(ada.participant)
    await waitFor(() => h.fake.posts.slice(seen).filter((p) => p.event.tags.some((t) => t[0] === 'status' && t[1] === 'revoked') && p.status === 201).length === 2)
    expect(withdrawn.groupGrantLedger!.grants.every((g) => g.status === 'revoked')).toBe(true)
    await bob.leave()
    await withdrawn.leave()
  })

  it('with no ledger the grant keeper does not run, and withdrawal still signs the empty list', async () => {
    const h = harness()
    const keeper = await h.start({
      groupGrants: { nodes: [], bytes: '', withdrawn: true, store: new MemoryStore(), fetch: h.fake.fetch },
    })
    expect(keeper.groupGrantLedger).toBeUndefined()
    expect(keeper.storageNodes).toEqual([])
    expect(decodePersistentInvitation(h.invitations().at(-1)!, keeper.link.invitation!)!.storage).toEqual([])
    await keeper.leave()
  })
})


describe('a keeper whose clock is behind', { timeout: 30_000 }, () => {
  it('a changed list is signed later than the copy it replaces, so members take it', async () => {
    const h = harness()
    const first = await h.start({ groupGrants: config(h.fake, [A, B], h.store) })
    const ada = await h.join(first.url)
    const stored = h.last().invitation!.created_at
    await first.leave()
    h.tick(-120)
    const again = await h.start({ state: h.last(), groupGrants: config(h.fake, [C], h.store) })
    const copy = h.invitations().at(-1)!
    expect(copy.created_at).toBe(stored + 1)
    expect(h.last().invitation!.created_at).toBe(stored + 1)
    await waitFor(() => ada.storageNodes?.[0] === C)
    expect(ada.storageNodes).toEqual([C])
    // A member joining afterwards reads the new list from the merged invitation.
    const bob = await h.join(again.url, 'Bob')
    expect(bob.storageNodes).toEqual([C])
    for (const a of [again, ada, bob]) await a.leave()
  })

  it('two lists signed in the same second are still ordered', async () => {
    const h = harness()
    const first = await h.start({ groupGrants: config(h.fake, [A], h.store) })
    await first.leave()
    const again = await h.start({ state: h.last(), groupGrants: config(h.fake, [B], h.store) })
    expect(h.invitations().at(-1)!.created_at).toBe(h.clock + 1)
    await again.leave()
  })

  it('a room with no invitation (v2) keeps its list\'s version in state: same list, same version; changed list, later than the last', async () => {
    const h = harness()
    const host = createRoomInvitation(true)
    const v2: KeeperState = { secret: generateRoomSecret(), inviterSk: host.inviterSk, bearer: host.invitation.bearer }
    const first = await h.start({ state: v2, groupGrants: config(h.fake, [A], h.store) })
    const at = h.clock
    expect(h.last().storageAt).toBe(at)
    expect(h.invitations()).toEqual([])
    await waitFor(() => h.ops(first).length === 1)
    expect(h.ops(first)[0]!.version).toBe(at)
    await first.leave()

    h.tick(100)
    const same = await h.start({ state: h.last(), groupGrants: config(h.fake, [A], h.store) })
    expect(h.last().storageAt).toBe(at)
    await waitFor(() => h.ops(same).some((o) => o.version === at))
    await same.leave()

    h.tick(-500)
    const changed = await h.start({ state: h.last(), groupGrants: config(h.fake, [B], h.store) })
    expect(h.last().storageAt).toBe(at + 1)
    await waitFor(() => h.ops(changed).some((o) => o.version === at + 1 && o.nodes[0] === B))
    expect(getPublicKey(host.inviterSk)).toBe(changed.link.invitation!.inviter)
    await changed.leave()
  })
})

describe('the plain copy of a new room', { timeout: 30_000 }, () => {
  it('goes out on a later start if the first publish failed, once, and is then forgotten', async () => {
    const relay = new SimRelay({ replay: true })
    const fake = new FakeNodes('')
    let failing = true
    const states: KeeperState[] = []
    let latest: RoomAgent | undefined
    const flaky = () => {
      const t = new SimTransport(relay)
      const publish = t.publish.bind(t)
      t.publish = async (e: Event) => { if (failing && e.kind === KINDS.GROUP_INVITATION) throw new Error('relay refused'); return publish(e) }
      return t
    }
    const start = async (state?: KeeperState, nodes: string[] = [A, B]) => {
      latest = await RoomAgent.create({
        base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: flaky, announceJitterMs: 0, state,
        onState: (s) => { states.push(s) }, groupGrants: config(fake, nodes),
      })
      return latest
    }
    await expect(start()).rejects.toThrow()
    // Before anything was published the state already held both copies.
    expect(states[0]!.storage).toEqual([A, B])
    expect(states[0]!.invitation).toBeDefined()
    expect(states[0]!.compat).toBeDefined()
    const inv = () => relay.published.filter((e) => e.kind === KINDS.GROUP_INVITATION)
    expect(inv()).toEqual([])

    failing = false
    const again = await start(states[0]!)
    const copies = inv()
    expect(copies.length).toBe(2)
    const invitation = again.link.invitation!
    expect(decodePersistentInvitation(copies[0]!, invitation)!.storage).toBeUndefined()
    expect(decodePersistentInvitation(copies[1]!, invitation)!.storage).toEqual([A, B])
    expect(copies[0]!.id).toBe(states[0]!.compat!.id)
    expect(again.keeperState!.compat).toBeUndefined()
    await again.leave()

    const third = await start(latest!.keeperState!)
    expect(inv().length).toBe(3)
    expect(inv()[2]!.id).toBe(copies[1]!.id)
    await third.leave()
  })

  it('if the list changes before the plain copy went out, the stale one is dropped and a new plain copy is signed for the new body, once', async () => {
    const relay = new SimRelay({ replay: true })
    const fake = new FakeNodes('')
    let failing = true
    const states: KeeperState[] = []
    const flaky = () => {
      const t = new SimTransport(relay)
      const publish = t.publish.bind(t)
      t.publish = async (e: Event) => { if (failing && e.kind === KINDS.GROUP_INVITATION) throw new Error('relay refused'); return publish(e) }
      return t
    }
    const start = (state: KeeperState | undefined, nodes: string[]) => RoomAgent.create({
      base: BASE, name: 'Keeper', relays: ['wss://sim'], transport: flaky, announceJitterMs: 0, state,
      onState: (s) => { states.push(s) }, groupGrants: config(fake, nodes),
    })
    await expect(start(undefined, [A])).rejects.toThrow()
    const stalePlain = states[0]!.compat!
    failing = false
    const again = await start(states[0]!, [A, B])
    const copies = relay.published.filter((e) => e.kind === KINDS.GROUP_INVITATION)
    const decoded = copies.map((e) => decodePersistentInvitation(e, again.link.invitation!)!)
    // Exactly two copies: a plain one signed for the new body, then the one with the new list. The stored plain copy never went out.
    expect(decoded.length).toBe(2)
    expect('storage' in decoded[0]!).toBe(false)
    expect(decoded[1]!.storage).toEqual([A, B])
    expect(copies.some((e) => e.id === stalePlain.id)).toBe(false)
    expect(copies[0]!.created_at).toBe(copies[1]!.created_at - 1)
    expect(again.keeperState!.compat).toBeUndefined()
    await again.leave()
  })
})

describe('republishing only when the body is unchanged', { timeout: 30_000 }, () => {
  it('new relays sign a new copy', async () => {
    const h = harness()
    const first = await h.start({ relays: ['wss://sim'] })
    await first.leave()
    h.tick(60)
    const again = await h.start({ state: h.last(), relays: ['wss://sim', 'wss://sim-two'] })
    expect(h.invitations().length).toBe(2)
    const [one, two] = h.invitations().map((e) => decodePersistentInvitation(e, again.link.invitation!)!)
    expect(one!.relays).toEqual(['wss://sim/'])
    expect(two!.relays).toEqual(['wss://sim/', 'wss://sim-two/'])
    await again.leave()
  })

  it('newly asking for self-destruct signs a new copy', async () => {
    const h = harness()
    const first = await h.start()
    await first.leave()
    h.tick(60)
    const again = await h.start({ state: h.last(), destruct: true })
    expect(h.invitations().length).toBe(2)
    const [one, two] = h.invitations().map((e) => decodePersistentInvitation(e, again.link.invitation!)!)
    expect(one!.destruct).toBeUndefined()
    expect(two!.destruct).toBe(true)
    await again.leave()
  })
})

describe('an unreadable ledger in a withdrawn room', { timeout: 30_000 }, () => {
  const withdrawn = (h: ReturnType<typeof harness>, store: MemoryStore, reset: boolean): GroupGrantsConfig => ({
    nodes: [], bytes: '', withdrawn: true, store, fetch: h.fake.fetch, ...(reset ? { resetUnreadable: true } : {}),
  })

  it('stops the start, naming the flags that work together', async () => {
    const h = harness()
    const store = new MemoryStore('not a ledger')
    await expect(h.start({ groupGrants: withdrawn(h, store, false) })).rejects.toThrow(/--group-withdraw --group-reset/)
    expect(store.text).toBe('not a ledger')
    expect(store.moved).toEqual([])
  })

  it('with the reset it is moved aside, never deleted, and the room starts withdrawn with no grant keeper', async () => {
    const h = harness()
    const store = new MemoryStore('not a ledger')
    const keeper = await h.start({ groupGrants: withdrawn(h, store, true) })
    expect(store.moved.length).toBe(1)
    expect(store.moved[0]!.text).toBe('not a ledger')
    expect(keeper.groupGrantLedger).toBeUndefined()
    expect(keeper.storageNodes).toEqual([])
    await keeper.leave()
  })
})
