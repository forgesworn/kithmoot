import { describe, it, expect, vi } from 'vitest'
import { TextRoomRelay } from './browser-room-routes.js'
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
