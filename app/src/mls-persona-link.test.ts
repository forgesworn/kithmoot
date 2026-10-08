import { describe, expect, it, vi } from 'vitest'
import { base64, base64urlnopad } from '@scure/base'
import { BrowserPersonaLinks } from './mls-persona-link.js'
import type { LinkConfig, LinkEngine, LinkPairing, LinkResponse, LinkRoute } from './browser-link-types.js'
import type { PersonaWitnessRoute } from './mls-persona-store.js'

const seed = new Uint8Array(32).fill(9)
const route: PersonaWitnessRoute = { routeId: 'witness', card: '01'.repeat(126), pairedRouteSecret: '02'.repeat(32), cardSerial: '7', cardVerifiedAt: '10', relayUrls: ['wss://chosen.example/link'] }
const reply: LinkResponse = { status: 403, body: new Uint8Array(), witnessRefused: true, path: { status: 'Ready', relay: null, direct: null, cause: '' } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function code() { return 'bothy:' + base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({ v: 2, bothy: '01'.repeat(32), secret: '02'.repeat(16), role: 'phone', name: 'witness', exp: Math.floor(Date.now() / 1000) + 120, card: base64.encode(new Uint8Array(126)) }))) }
function setup() {
  const engine = { stop: vi.fn(async () => {}), request: vi.fn(async () => structuredClone(reply)), pairRoute: vi.fn(async (bundle: LinkPairing): Promise<LinkRoute> => ({ routeId: bundle.routeId, card: bundle.serverCard, pairedRouteSecret: new Uint8Array(32).fill(3), cardSerial: 1n, cardVerifiedAt: 2n })),
    openSocket: vi.fn(), removeRoute: vi.fn(), retireRoute: vi.fn(), finalizeRoute: vi.fn() } satisfies LinkEngine
  const start = vi.fn(async (_config: LinkConfig) => engine), allowed = vi.fn(() => true)
  const links = new BrowserPersonaLinks(allowed, start)
  return { engine, start, allowed, links, open: (current = () => true) => links.channels('persona', seed, route, current) }
}
describe('persona Link lifetime', () => {
  it('uses only the supplied writer and chosen relays, then wipes temporary seed and route secret copies', async () => {
    const s = setup(), snapshots: LinkConfig[] = []
    s.start.mockImplementation(async config => { snapshots.push(structuredClone(config)); return s.engine })
    const channel = (await s.open())!
    expect(snapshots[0]).toMatchObject({ transportSeed: seed, relayUrls: route.relayUrls, routes: [{ routeId: route.routeId, cardSerial: 7n, cardVerifiedAt: 10n }] })
    expect(s.start.mock.calls[0][0].transportSeed.every(n => n === 0)).toBe(true)
    expect(s.start.mock.calls[0][0].routes[0].pairedRouteSecret.every(n => n === 0)).toBe(true)
    expect(seed[0]).toBe(9)
    expect(await channel.read(new Uint8Array([1]))).toEqual({ type: 'refused' })
    await channel.close!(); await channel.close!()
    expect(s.engine.stop).toHaveBeenCalledOnce()
    expect(await channel.advance(new Uint8Array([1]))).toEqual({ type: 'unavailable' })
    expect(s.engine.request).toHaveBeenCalledOnce()
  })
  it('refuses absent routes, stale accounts and disallowed modes before startup', async () => {
    const s = setup()
    expect(await s.links.channels('persona', seed, null, () => true)).toBeNull()
    expect(await s.open(() => false)).toBeNull()
    s.allowed.mockReturnValue(false); expect(await s.open()).toBeNull()
    expect(await s.links.pair(seed, 'never parse this private code', route.relayUrls, () => true)).toBeNull()
    expect(s.start).not.toHaveBeenCalled()
  })
  it('drains a late startup and shutdown before pause resolves or resume is permitted', async () => {
    const s = setup(), started = deferred<typeof s.engine>(), stopped = deferred<void>()
    s.start.mockReturnValue(started.promise); s.engine.stop.mockReturnValue(stopped.promise)
    const opening = s.open(); await vi.waitFor(() => expect(s.start).toHaveBeenCalledOnce())
    let paused = false; const pausing = s.links.pause().then(() => { paused = true })
    expect(() => s.links.resume()).toThrow('still stopping'); expect(paused).toBe(false)
    started.resolve(s.engine); await vi.waitFor(() => expect(s.engine.stop).toHaveBeenCalledOnce())
    expect(paused).toBe(false); expect(await s.open()).toBeNull()
    stopped.resolve(); expect(await opening).toBeNull(); await pausing
    s.links.resume(); expect(await s.open()).not.toBeNull(); await s.links.pause()
  })
  it('stops a startup that became stale without needing a pause notification', async () => {
    const s = setup(), started = deferred<typeof s.engine>(); s.start.mockReturnValue(started.promise)
    let current = true
    const opening = s.open(() => current); await vi.waitFor(() => expect(s.start).toHaveBeenCalledOnce())
    current = false; started.resolve(s.engine)
    expect(await opening).toBeNull(); expect(s.engine.stop).toHaveBeenCalledOnce()
  })
  it('does not dispatch a queued startup after pause', async () => {
    const s = setup(), opening = s.open(), rejected = expect(opening).rejects.toThrow('unavailable')
    await s.links.pause(); await rejected
    expect(s.start).not.toHaveBeenCalled()
  })
  it('suppresses replies after a privacy mode change', async () => {
    const s = setup(), response = deferred<LinkResponse>(); s.engine.request.mockReturnValue(response.promise)
    const channel = (await s.open())!, pending = channel.read(new Uint8Array([1]))
    s.allowed.mockReturnValue(false); response.resolve(reply)
    expect(await pending).toEqual({ type: 'unavailable' }); await channel.close!()
  })
  it('cleans failed starts without leaking the writer seed', async () => {
    const s = setup(); s.start.mockRejectedValue(new Error('offline'))
    await expect(s.open()).rejects.toThrow('offline')
    expect(s.start.mock.calls[0][0].transportSeed.every(n => n === 0)).toBe(true)
    await s.links.pause(); s.links.resume()
  })
  it('pairs on a disposable writer endpoint and returns only the verified route with explicit relays', async () => {
    const s = setup(), pairing = code()
    const paired = await s.links.pair(seed, pairing, route.relayUrls, () => true)
    expect(s.start.mock.calls[0][0].routes).toEqual([])
    expect(paired).toMatchObject({ pairedRouteSecret: '03'.repeat(32), relayUrls: route.relayUrls, cardSerial: '1', cardVerifiedAt: '2' })
    expect(s.engine.stop).toHaveBeenCalledOnce()
    expect(s.engine.pairRoute.mock.calls[0][0].pairingSecret.every(n => n === 0)).toBe(true)
  })
  it('does not return a route that became stale while the pairing engine was stopping', async () => {
    const s = setup(); let current = true
    s.engine.stop.mockImplementation(async () => { current = false })
    expect(await s.links.pair(seed, code(), route.relayUrls, () => current)).toBeNull()
  })
  it('persists the relay choice used for pairing even if the caller changes its array', async () => {
    const s = setup(), chosen = [...route.relayUrls]
    s.start.mockImplementation(async () => { chosen[0] = 'wss://changed.example'; return s.engine })
    expect((await s.links.pair(seed, code(), chosen, () => true))?.relayUrls).toEqual(route.relayUrls)
  })
  it('holds uncertain pairing failures without reusing their short-lived secret', async () => {
    const s = setup(); s.engine.pairRoute.mockRejectedValue(new Error('lost reply'))
    await expect(s.links.pair(seed, code(), route.relayUrls, () => true)).rejects.toThrow('lost reply')
    expect(s.engine.stop).toHaveBeenCalledOnce()
    expect(s.engine.pairRoute.mock.calls[0][0].pairingSecret.every(n => n === 0)).toBe(true)
  })
})
