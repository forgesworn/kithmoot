import { afterEach, describe, it, expect, vi } from 'vitest'
import { BrowserRoomRoutes, TextRoomRelay } from './browser-room-routes.js'
import type { RoomConsent } from './browser-room-consent.js'
import type { BrowserLink } from './browser-link.js'
import type { ParticipantIdentity } from '../../src/identity.js'
vi.mock('./browser-link-relay.js', () => ({ BrowserLinkRelay: class {
  subscribe(_filters: unknown, _receive: unknown, eose: () => void) { eose(); return () => {} }
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
