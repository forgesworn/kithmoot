import { describe, expect, it, vi } from 'vitest'
import { base64, base64urlnopad } from '@scure/base'
import { BrowserLink } from './browser-link.js'
import { readLinkPairing } from './browser-link-pairing.js'
import { BrowserLinkVault, type LinkState } from './browser-link-vault.js'
import type { LinkEngine, LinkRoute, LinkPairing } from './browser-link-types.js'
import type { EncryptedRendezvousRecord } from './rendezvous-vault.js'

const account = 'a'.repeat(64)
function card() { const c = new Uint8Array(126); c.set(new TextEncoder().encode('FSL1')); c[4] = 1; c.fill(3, 5, 37); return c }
function route(): LinkRoute { return { routeId: 'box', card: card(), pairedRouteSecret: new Uint8Array(32).fill(5), cardSerial: 1n, cardVerifiedAt: 1n } }
function state(): LinkState { return { account, transportSeed: new Uint8Array(32).fill(9), relayUrls: ['wss://relay.example/link'], routes: [route()] } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function code(exp = Math.floor(Date.now() / 1000) + 120) { return 'bothy:' + base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({ v: 2, card: base64.encode(card()), secret: '1'.repeat(32), bothy: account, role: 'box', name: 'Test', exp }))) }
function setup() {
  const engine = { stop: vi.fn(async () => {}), pairRoute: vi.fn(async (_bundle: LinkPairing) => ({ ...route(), routeId: 'second' })), removeRoute: vi.fn(async () => {}),
    request: vi.fn(async () => ({ status: 404, body: new Uint8Array(), witnessRefused: false, path: { status: 'relayed', relay: null, direct: null, cause: '' } })),
    openSocket: vi.fn(), retireRoute: vi.fn(), finalizeRoute: vi.fn() } satisfies LinkEngine
  const vault = { read: vi.fn(async () => state()), write: vi.fn(async (_state: LinkState) => {}) }
  const release = vi.fn(), own = vi.fn(async (): Promise<() => void> => release), start = vi.fn(async () => engine)
  return { engine, vault, release, own, start, link: new BrowserLink(start, vault, own) }
}
describe('browser Link ownership', () => {
  it('coalesces resume and preserves the active engine', async () => {
    const s = setup(); const [a, b] = await Promise.all([s.link.resume(account), s.link.resume(account)])
    expect(a).toEqual(b); await s.link.resume(account)
    expect(s.start).toHaveBeenCalledTimes(1); expect(s.own).toHaveBeenCalledTimes(1); expect(s.engine.stop).not.toHaveBeenCalled()
    await s.link.stop(); expect(s.release).toHaveBeenCalledOnce()
  })
  it('refuses another account without starting or exposing its routes', async () => {
    const s = setup(); await expect(s.link.resume('b'.repeat(64))).rejects.toThrow('another account')
    expect(s.start).not.toHaveBeenCalled(); expect(s.release).toHaveBeenCalledOnce(); expect(s.link.boxes()).toEqual([])
  })
  it('never starts after cancellation during the ownership wait', async () => {
    const s = setup(), wait = deferred<() => void>(); s.own.mockReturnValue(wait.promise)
    const resume = s.link.resume(account); const rejected = expect(resume).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(s.own).toHaveBeenCalledOnce())
    const stop = s.link.stop(); wait.resolve(s.release); await rejected; await stop
    expect(s.start).not.toHaveBeenCalled(); expect(s.release).toHaveBeenCalledOnce()
  })
  it('stops a late engine before releasing ownership', async () => {
    const s = setup(), wait = deferred<typeof s.engine>(); s.start.mockReturnValue(wait.promise)
    const resume = s.link.resume(account); const rejected = expect(resume).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(s.start).toHaveBeenCalledOnce())
    const stop = s.link.stop(); expect(s.release).not.toHaveBeenCalled(); wait.resolve(s.engine)
    await rejected; await stop
    expect(s.engine.stop).toHaveBeenCalledOnce(); expect(s.release).toHaveBeenCalledOnce()
  })
  it('holds ownership throughout engine shutdown and permits a fresh resume afterwards', async () => {
    const s = setup(), wait = deferred<void>(); s.engine.stop.mockReturnValue(wait.promise)
    await s.link.resume(account); const stop = s.link.stop(); const resume = s.link.resume(account)
    await Promise.resolve(); expect(s.release).not.toHaveBeenCalled(); expect(s.start).toHaveBeenCalledTimes(1)
    wait.resolve(); await stop; await resume; expect(s.start).toHaveBeenCalledTimes(2); await s.link.stop()
  })
  it('does not persist a pairing that returned after stop', async () => {
    const s = setup(), wait = deferred<LinkRoute>(); s.engine.pairRoute.mockReturnValue(wait.promise)
    await s.link.resume(account); const pair = s.link.pair(code()); const rejected = expect(pair).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(s.engine.pairRoute).toHaveBeenCalledOnce())
    const stop = s.link.stop(); const r = route(); wait.resolve(r); await rejected; await stop
    expect(s.vault.write).not.toHaveBeenCalled(); expect(r.pairedRouteSecret.every(v => v === 0)).toBe(true)
    expect(s.engine.pairRoute.mock.calls[0][0].pairingSecret.every(v => v === 0)).toBe(true)
  })
  it('passes binary replies and bare refusals intact, and rejects a late reply', async () => {
    const s = setup(); await s.link.resume(account)
    const request = { routeId: 'box', method: 'GET' as const, path: '/vmls/v1/capabilities', authorization: 'Nostr test', body: new Uint8Array() }
    expect((await s.link.request(request)).status).toBe(404)
    const wait = deferred<Awaited<ReturnType<typeof s.engine.request>>>(); s.engine.request.mockReturnValue(wait.promise)
    const pending = s.link.request(request); const rejected = expect(pending).rejects.toThrow('cancelled'); await s.link.stop()
    wait.resolve({ status: 409, body: new Uint8Array(170), witnessRefused: true, path: { status: 'relayed', relay: null, direct: null, cause: '' } }); await rejected
  })
  it('refuses unpaired addresses before opening a socket', async () => {
    const s = setup(); await s.link.resume(account)
    await expect(s.link.openSocket('wss://public.example', 'box', {})).rejects.toThrow('not the paired')
    expect(s.engine.openSocket).not.toHaveBeenCalled(); await s.link.stop()
  })
})
describe('pairing and sealed storage', () => {
  it('bounds pairing expiry and hides capability input in errors', () => {
    expect(readLinkPairing(code()).pairingSecret.length).toBe(16)
    expect(() => readLinkPairing(code(1))).toThrow('current Bothy')
    expect(() => readLinkPairing(code(Math.floor(Date.now() / 1000) + 601))).toThrow('current Bothy')
    expect(() => readLinkPairing('bothy:secret')).toThrow(/^Use a current Bothy/)
  })
  it('round-trips exact u64 values with no plaintext account or route secret', async () => {
    let key: CryptoKey | undefined, record: EncryptedRendezvousRecord | undefined
    const storage = { key: async () => key, saveKey: async (k: CryptoKey) => { key = k }, record: async () => record,
      put: async (r: EncryptedRendezvousRecord) => { record = r }, remove: async () => { record = undefined } }
    const vault = new BrowserLinkVault(storage), value = state(); value.routes[0].cardSerial = 0xffffffffffffffffn
    await vault.write(value)
    expect(key!.extractable).toBe(false); expect(new TextDecoder().decode(record!.ciphertext)).not.toContain(account)
    expect(await vault.read()).toEqual(value)
    new Uint8Array(record!.ciphertext)[0] ^= 1
    await expect(vault.read()).rejects.toThrow()
  })
})
