import { describe, expect, it } from 'vitest'
import { MAX_PERSISTENT_INVITATION_EVIDENCE_DELIVERIES } from '@forgesworn/fold-kit/persistent-invitation-evidence'
import { invitationQueryFrameCeiling } from './ordinary-invitation-query.js'

describe('how many frames an invitation query reads before it gives up', () => {
  it('is never lower than what fold-kit’s reader will charge itself for, plus a marker from each relay', () => {
    expect(invitationQueryFrameCeiling(1)).toBe(MAX_PERSISTENT_INVITATION_EVIDENCE_DELIVERIES + 1)
    expect(invitationQueryFrameCeiling(8)).toBe(MAX_PERSISTENT_INVITATION_EVIDENCE_DELIVERIES + 8)
    expect(MAX_PERSISTENT_INVITATION_EVIDENCE_DELIVERIES).toBe(512)
  })

  it('lets through eight relays each repeating the whole 64-copy window, which the old 128 did not', () => {
    const relays = 8, perRelay = 64
    const frames = relays * perRelay + relays
    expect(frames).toBeGreaterThan(128)
    expect(frames).toBeLessThanOrEqual(invitationQueryFrameCeiling(relays))
  })

  it('still stops a relay that does not stop: one more than the deliveries is over', () => {
    const relays = 3
    expect(MAX_PERSISTENT_INVITATION_EVIDENCE_DELIVERIES + relays + 1).toBeGreaterThan(invitationQueryFrameCeiling(relays))
  })
})
