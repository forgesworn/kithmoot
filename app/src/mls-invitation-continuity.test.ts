import { afterEach, describe, expect, it, vi } from 'vitest'
import { invitationAnchor, invitationRestart } from './mls-invitation-continuity.js'
import type { MlsRoomRecord } from './mls-room-store.js'
import type { PersonaReader } from './mls-persona-coordinator.js'
function storage() { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, clear: () => values.clear() } as Storage }
afterEach(() => vi.unstubAllGlobals())
describe('protected invitation host restart disposition', () => {
  it('requires matching surviving local anchor and protected installation; never repairs loss on read', () => {
    const local = storage(); vi.stubGlobal('localStorage', local)
    const installation = '11'.repeat(32), tx = { installation } as PersonaReader
    expect(invitationAnchor(local)).toBeUndefined()
    const anchor = invitationAnchor(local, true)!
    const room = { invitation: { groupId: '22'.repeat(32), groupInstallation: '33'.repeat(32), hostInstallation: installation, localAnchor: anchor } } as MlsRoomRecord
    expect(invitationRestart(tx, room)).toBe('TrustedLocalRestart')
    expect(invitationRestart({ installation: '44'.repeat(32) } as PersonaReader, room)).toBe('DetectedImport')
    local.clear(); expect(invitationRestart(tx, room)).toBe('DetectedStateLoss'); expect(invitationAnchor(local)).toBeUndefined()
    invitationAnchor(local, true); expect(invitationRestart(tx, room)).toBe('DetectedClone')
  })
})
