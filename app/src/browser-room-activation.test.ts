import { describe, it, expect, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { BrowserRoomActivation, confirmedReadback } from './browser-room-activation.js'
import { planRoomGrants, validateConsent, type RoomConsent } from './browser-room-consent.js'
import type { BrowserLink } from './browser-link.js'
import type { RelayTransport } from '../../src/relay-pool.js'

const room = 'a'.repeat(64), box = { routeId: 'route', eventUrl: `ws://${'a'.repeat(52)}/events` }
function fixture() {
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
  const link = { resume: async () => [box], boxes: () => [box] } as unknown as BrowserLink
  const controller = new BrowserRoomActivation(() => identity, link, store, barrier, carrier, () => now, async (_room, work) => work())
  const input = { room, box, device: getPublicKey(deviceKey), scopes: [room], aliases: [], guests: [{ persona: guest, device: guest }],
    readiness: async () => finalizeEvent({ kind: 20461, created_at: now, tags: [['d',room]], content: 'encrypted roster fixture' }, deviceKey) }
  return { controller, input, publications, snapshots, store, signer, barrier, get saved() { return saved }, set saveFails(v: boolean) { refuseSave = v }, set writeFails(v: boolean) { refuseWrite = v }, signOut: () => { identity = undefined }, advance: (n: number) => { now += n } }
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
