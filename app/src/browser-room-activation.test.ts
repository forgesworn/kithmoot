import { describe, it, expect, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { BrowserRoomActivation, confirmedReadback } from './browser-room-activation.js'
import { planRoomGrants, validateConsent, type RoomConsent } from './browser-room-consent.js'
import type { BrowserLink } from './browser-link.js'
import type { RelayTransport } from '../../src/relay-pool.js'

const room = 'a'.repeat(64), box = { routeId: 'route', eventUrl: `ws://${'a'.repeat(52)}/events` }
function fixture(route = box) {
  const key = generateSecretKey(), deviceKey = generateSecretKey(), guest = getPublicKey(generateSecretKey())
  let now = 1000
  const signer = { pubkey: getPublicKey(key), signEvent: async (e: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(e, key) }
  let identity: typeof signer | undefined = signer
  let saved: RoomConsent | undefined, refuseSave = false, refuseWrite = false
  const publications: Event[] = [], snapshots: RoomConsent[] = []
  const store = { all: async () => saved ? [structuredClone(saved)] : [], put: async (c: RoomConsent) => {
    if (refuseSave) throw new Error('disk full')
    validateConsent(c); saved = structuredClone(c); snapshots.push(structuredClone(c))
  } }
  const carrier = (): RelayTransport => {
    let receive: ((event: Event) => void) | undefined
    return { subscribe: (filters, listener) => {
      expect(filters[0]).toMatchObject({ kinds: [20461], '#d': [room] }); expect(filters[0].ids).toHaveLength(1)
      receive = listener; return () => { receive = undefined }
    }, publish: async e => {
      expect(saved).toBeDefined()
      if (e.kind === 24242) expect(saved!.grants.some(g => g.active.id === e.id || g.revoked.id === e.id)).toBe(true)
      publications.push(e)
      if (refuseWrite) throw new Error('lost OK')
      receive?.(e)
    }, close: () => {} }
  }
  const barrier = { changed: vi.fn(), closed: vi.fn(async (_room: string, work: () => Promise<void>) => work()) }
  const resume = vi.fn(async () => [route])
  const link = { resume, boxes: () => [route] } as unknown as BrowserLink
  const controller = new BrowserRoomActivation(() => identity, link, store, barrier, carrier, () => now, async (_room, work) => work())
  const input = { room, box: route, device: getPublicKey(deviceKey), scopes: [room], aliases: [], guests: [{ persona: guest, device: guest }],
    readiness: async () => finalizeEvent({ kind: 20461, created_at: now, tags: [['d',room]], content: 'encrypted roster fixture' }, deviceKey) }
  return { controller, input, publications, snapshots, store, signer, barrier, resume, get saved() { return saved }, set saveFails(v: boolean) { refuseSave = v }, set writeFails(v: boolean) { refuseWrite = v }, signOut: () => { identity = undefined }, advance: (n: number) => { now += n } }
}

describe('durable browser room activation', () => {
  it('retains exact active and withdrawal statements before publication, then requires scoped readback', async () => {
    const f = fixture(); await f.controller.activate({...f.input, aliases:['lookup:'+'d'.repeat(64)]})
    expect(f.barrier.closed.mock.calls.map(c => c[0])).toContain('d'.repeat(64))
    expect(f.snapshots.map(c => c.phase)).toEqual(['installing','active'])
    expect(f.saved!.grants).toHaveLength(2)
    expect(f.barrier.closed.mock.calls.map(c => c[0])).toContain(room)
    expect(f.publications.map(e => e.kind)).toEqual([24242,24242,20461])
  })
  it('activates standalone WSS without resuming a Bothy endpoint', async () => {
    const f = fixture({ routeId: 'standalone-wok', eventUrl: 'wss://relay.example.org/events' })
    await f.controller.activate(f.input)
    expect(f.resume).not.toHaveBeenCalled()
    expect(f.saved!.phase).toBe('active')
    expect(f.saved!.grants[0].active.tags.find(t => t[0] === 'server')).toEqual(['server', 'wss://relay.example.org/events'])
  })
  it('sends nothing if the durable save fails', async () => {
    const f = fixture(); f.saveFails = true
    await expect(f.controller.activate(f.input)).rejects.toThrow('disk full')
    expect(f.publications).toEqual([])
  })
  it('repeats the identical grant after an uncertain OK instead of changing its ID', async () => {
    const f = fixture(); f.writeFails = true
    await expect(f.controller.activate(f.input)).rejects.toThrow('lost OK')
    const initial = structuredClone(f.saved!)
    f.writeFails = false; await f.controller.activate(f.input)
    expect(f.saved!.grants).toEqual(initial.grants)
    expect(f.publications[0].id).toBe(f.publications[1].id)
    expect(f.saved!.phase).toBe('active')
  })
  it('retains withdrawal across a refusal and retires only after every acknowledgement', async () => {
    const f = fixture(); await f.controller.activate(f.input)
    f.writeFails = true; await expect(f.controller.withdraw(room)).rejects.toThrow('lost OK')
    expect(f.saved!.phase).toBe('withdrawing')
    await expect(f.controller.activate(f.input)).rejects.toThrow('withdrawing')
    f.writeFails = false; await f.controller.withdraw(room)
    expect(f.saved!.phase).toBe('retired')
  })
  it('renews the same scopes and IDs with later times and retained replacement withdrawals', async () => {
    const f = fixture(); await f.controller.activate(f.input)
    const initial = structuredClone(f.saved!)
    f.advance(86400); await f.controller.renew(room, f.input.readiness)
    expect(f.saved!.expires).toBeGreaterThan(initial.expires)
    expect(f.saved!.grants.map(g => g.active.tags.find(t => t[0] === 'grant'))).toEqual(initial.grants.map(g => g.active.tags.find(t => t[0] === 'grant')))
    expect(f.snapshots.at(-2)!.phase).toBe('renewing')
  })
  it('cannot activate after a failed closure barrier or account change', async () => {
    const f = fixture(); f.barrier.closed.mockRejectedValueOnce(new Error('frozen tab'))
    await expect(f.controller.activate(f.input)).rejects.toThrow('frozen tab')
    expect(f.saved!.phase).toBe('installing'); expect(f.publications).toEqual([])
    f.signOut(); await expect(f.controller.activate(f.input)).rejects.toThrow('Sign in')
  })
  it('keeps channel scopes separate through renewal', async () => {
    const f = fixture(), channel = 'e'.repeat(64)
    await f.controller.activate({ ...f.input, scopes:[room,channel] })
    expect(f.saved!.grants).toHaveLength(4)
    f.advance(86400); await f.controller.renew(room, f.input.readiness)
    expect(new Set(f.saved!.grants.map(g => g.active.tags.find(t => t[0] === 'd')![1]))).toEqual(new Set([room,channel]))
  })
  it('grants the room’s board as a scope of its own, for as many devices as two scopes allowed', async () => {
    const f = fixture(), control = 'e'.repeat(64), board = 'f'.repeat(64)
    // The keeper and seven guests: eight devices, as a room with only chat and control could hold.
    const guests = Array.from({ length: 7 }, () => { const guest = getPublicKey(generateSecretKey()); return { persona: guest, device: guest } })
    await f.controller.activate({ ...f.input, scopes: [room, control, board], guests })
    expect(f.saved!.grants).toHaveLength(24)
    expect(f.saved!.grants.filter(g => g.active.tags.some(t => t[0] === 'd' && t[1] === board))).toHaveLength(8)
    f.advance(86400); await f.controller.renew(room, f.input.readiness)
    expect(new Set(f.saved!.grants.map(g => g.active.tags.find(t => t[0] === 'd')![1]))).toEqual(new Set([room, control, board]))
    expect(f.saved!.grants).toHaveLength(24)
  })

  it('adds the board to a route activated without it, in place: the keeper renews for the same devices, a member adds it to its own selection', async () => {
    const control = 'e'.repeat(64), board = 'f'.repeat(64)
    const keeper = fixture()
    await keeper.controller.activate({ ...keeper.input, scopes: [room, control] })
    const before = structuredClone(keeper.saved!)
    const devicesIn = (scope: string) => keeper.saved!.grants.filter(g => g.active.tags.some(t => t[0] === 'd' && t[1] === scope))
      .map(g => g.active.tags.find(t => t[0] === 'device')![1]).sort()
    // Interrupted after the plan was saved: the next renewal finishes the same plan, board included.
    keeper.writeFails = true
    keeper.advance(60); await expect(keeper.controller.renew(room, keeper.input.readiness, [room, control, board])).rejects.toThrow('lost OK')
    expect(keeper.saved!.phase).toBe('renewing'); expect(keeper.saved!.scopes).toEqual([room, control, board])
    keeper.writeFails = false
    await keeper.controller.renew(room, keeper.input.readiness)
    expect(keeper.saved!.phase).toBe('active')
    expect(keeper.saved!.grants).toHaveLength(6)
    expect(devicesIn(board)).toEqual(devicesIn(room))
    // The streams it already carried keep their grant ids.
    const ids = (c: RoomConsent, scope: string) => c.grants.filter(g => g.active.tags.some(t => t[0] === 'd' && t[1] === scope)).map(g => g.active.tags.find(t => t[0] === 'grant')![1]).sort()
    expect(ids(keeper.saved!, room)).toEqual(ids(before, room)); expect(ids(keeper.saved!, control)).toEqual(ids(before, control))
    expect(keeper.publications.filter(e => e.kind === 24242 && e.tags.some(t => t[0] === 'd' && t[1] === board))).not.toHaveLength(0)

    const member = fixture()
    await member.controller.activate({ ...member.input, scopes: [room, control], guests: undefined })
    expect(member.saved!.grants).toEqual([])
    await member.controller.activate({ ...member.input, scopes: [room, control, board], guests: undefined })
    expect(member.saved!.scopes).toEqual([room, control, board])
    expect(member.saved!.grants).toEqual([])
    expect(member.publications.filter(e => e.kind === 24242)).toEqual([])
  })

  it('obtains and persists a fresh withdrawal after expiry, then requires server acknowledgement', async () => {
    const f = fixture(); await f.controller.activate(f.input)
    const original = structuredClone(f.saved!)
    f.advance(31*86400); await f.controller.withdraw(room)
    expect(f.saved!.phase).toBe('retired')
    expect(f.saved!.grants[0].active).toEqual(original.grants[0].active)
    expect(Number(f.saved!.grants[0].revoked.tags.find(t => t[0] === 'expiration')![1])).toBeGreaterThan(original.expires)
    expect(f.snapshots.at(-2)!.phase).toBe('withdrawing')
  })
  it('rejects a signer that changes a requested grant', async () => {
    const key = generateSecretKey()
    await expect(planRoomGrants({ pubkey: getPublicKey(key), signEvent: async e => finalizeEvent({ ...e, content: 'changed' }, key) }, box, room,
      [{ persona: getPublicKey(key), device: getPublicKey(key) }], 1000)).rejects.toThrow('signer changed')
  })
  it('requires both an OK and the matching signed readiness event, not EOSE alone', async () => {
    const key = generateSecretKey(), event = finalizeEvent({ kind:20461, created_at:1000, tags:[['d',room]], content:'fixture' }, key)
    const pool: RelayTransport = { publish: async () => {}, subscribe: (_f, _receive, eose) => { eose?.(); return () => {} }, close: () => {} }
    await expect(confirmedReadback(pool, event, 5)).rejects.toThrow('exact room readiness')
  })
})
