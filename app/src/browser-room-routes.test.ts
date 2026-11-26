import { afterEach, describe, it, expect, vi } from 'vitest'
import { BrowserRoomRoutes, TextRoomRelay } from './browser-room-routes.js'
import type { RoomConsent } from './browser-room-consent.js'
import type { BrowserLink } from './browser-link.js'
import type { ParticipantIdentity } from '../../src/identity.js'
const published: unknown[] = []
vi.mock('./browser-link-relay.js', () => ({ BrowserLinkRelay: class {
  subscribe(_filters: unknown, _receive: unknown, eose: () => void) { eose(); return () => {} }
  async publish(event: unknown) { published.push(event) }
} }))
describe('Bothy text history completeness', () => {
  const room = 'a'.repeat(64), channel = 'b'.repeat(64)
  const relay = () => new TextRoomRelay({} as BrowserLink, { scopes:[room,channel] } as RoomConsent, {} as ParticipantIdentity)
  it('does not claim complete history after dropping unsupported kinds or scopes', () => {
    for (const filter of [{ kinds:[1460,1], '#d':[room] }, { kinds:[1460], '#d':[room,'c'.repeat(64)] }, { '#d':[room] }]) {
      const done = vi.fn(); relay().subscribe([filter], () => {}, done); expect(done).not.toHaveBeenCalled()
    }
  })
  it('reports completion only after all supported scopes complete', () => {
    const done = vi.fn(); relay().subscribe([{ kinds:[1460], '#d':[room,channel] }], () => {}, done)
    expect(done).toHaveBeenCalledOnce()
  })
})

describe('the room’s board over a Bothy route', () => {
  const room = 'a'.repeat(64), control = 'b'.repeat(64), board = 'c'.repeat(64)
  const change = { kind: 1460, tags: [['d', board]], content: '', created_at: 1, pubkey: 'd'.repeat(64), id: 'e'.repeat(64), sig: 'f'.repeat(128) }
  const route = (scopes: string[]) => new TextRoomRelay({} as BrowserLink, { scopes } as RoomConsent, {} as ParticipantIdentity)
  it('sends and reads the board’s stream on a route granted it', async () => {
    published.length = 0
    await route([room, control, board]).publish(change)
    expect(published).toEqual([change])
    const done = vi.fn(); route([room, control, board]).subscribe([{ kinds: [1460], '#d': [board] }], () => {}, done)
    expect(done).toHaveBeenCalledOnce()
  })
  it('holds the board on a route set up with chat and control only, and never calls its history complete', async () => {
    published.length = 0
    await expect(route([room, control]).publish(change)).rejects.toThrow('not granted')
    expect(published).toEqual([])
    const done = vi.fn(); route([room, control]).subscribe([{ kinds: [1460], '#d': [board] }], () => {}, done)
    expect(done).not.toHaveBeenCalled()
  })
})

describe('resuming Bothy routes', () => {
  const routes = () => {
    // Construction opens no database, but the consent store insists one exists.
    vi.stubGlobal('indexedDB', {})
    const found = new BrowserRoomRoutes(() => undefined, {} as BrowserLink, async () => {})
    const woken = vi.fn(), broadcast = vi.spyOn(found.barrier, 'changed')
    found.barrier.listen(woken)
    return { found, woken, broadcast }
  }
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
  it('wakes this tab only when nothing was paused, so another tab restoring its account does not interrupt public work here', () => {
    const { found, woken, broadcast } = routes()
    found.resume()
    expect(woken).toHaveBeenCalledOnce()
    expect(broadcast).not.toHaveBeenCalled()
  })
  it('tells every tab when routes come back after a pause', () => {
    const { found, broadcast } = routes()
    found.pause()
    broadcast.mockClear()
    found.resume()
    expect(broadcast).toHaveBeenCalledOnce()
  })
})
