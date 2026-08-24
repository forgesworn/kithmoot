import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { evaluateAccess, issueKindredProof } from './access.js'

const NOW = 1_800_000_000

describe('access tiers', () => {
  it('admits anyone when the room is open', () => {
    const r = evaluateAccess({ tier: 'open' }, 'a'.repeat(64), undefined, NOW)
    expect(r.admitted).toBe(true)
  })

  it('refuses an unproven participant when the room is kith-gated', () => {
    const r = evaluateAccess({ tier: 'kith' }, 'a'.repeat(64), undefined, NOW)
    expect(r).toEqual({ admitted: false, reason: 'no kindred proof' })
  })

  it('admits a valid kith proof to a kith-gated room', () => {
    const hostSk = generateSecretKey()
    const guest = 'b'.repeat(64)
    const proof = issueKindredProof({ hostSk, participant: guest, tier: 'kith', expiresAt: NOW + 3600 })
    const r = evaluateAccess({ tier: 'kith', admitted: [getPublicKey(hostSk)] }, guest, proof, NOW)
    expect(r.admitted).toBe(true)
  })

  it('admits a kin proof to a kith-gated room, because kin is closer than kith', () => {
    const hostSk = generateSecretKey()
    const guest = 'b'.repeat(64)
    const proof = issueKindredProof({ hostSk, participant: guest, tier: 'kin', expiresAt: NOW + 3600 })
    const r = evaluateAccess({ tier: 'kith', admitted: [getPublicKey(hostSk)] }, guest, proof, NOW)
    expect(r.admitted).toBe(true)
  })

  it('refuses a ken proof to a kith-gated room, because ken is only one-way recognition', () => {
    const hostSk = generateSecretKey()
    const guest = 'b'.repeat(64)
    const proof = issueKindredProof({ hostSk, participant: guest, tier: 'ken', expiresAt: NOW + 3600 })
    const r = evaluateAccess({ tier: 'kith', admitted: [getPublicKey(hostSk)] }, guest, proof, NOW)
    expect(r).toEqual({ admitted: false, reason: 'tier too low' })
  })

  it('refuses a proof issued by someone the room does not trust', () => {
    const strangerSk = generateSecretKey()
    const hostSk = generateSecretKey()
    const guest = 'b'.repeat(64)
    const proof = issueKindredProof({ hostSk: strangerSk, participant: guest, tier: 'kith', expiresAt: NOW + 3600 })
    const r = evaluateAccess({ tier: 'kith', admitted: [getPublicKey(hostSk)] }, guest, proof, NOW)
    expect(r).toEqual({ admitted: false, reason: 'untrusted issuer' })
  })

  it('refuses a proof naming a different participant', () => {
    const hostSk = generateSecretKey()
    const proof = issueKindredProof({ hostSk, participant: 'b'.repeat(64), tier: 'kith', expiresAt: NOW + 3600 })
    const r = evaluateAccess({ tier: 'kith', admitted: [getPublicKey(hostSk)] }, 'c'.repeat(64), proof, NOW)
    expect(r).toEqual({ admitted: false, reason: 'proof names another participant' })
  })

  it('refuses an expired proof', () => {
    const hostSk = generateSecretKey()
    const guest = 'b'.repeat(64)
    const proof = issueKindredProof({ hostSk, participant: guest, tier: 'kith', expiresAt: NOW - 1 })
    const r = evaluateAccess({ tier: 'kith', admitted: [getPublicKey(hostSk)] }, guest, proof, NOW)
    expect(r).toEqual({ admitted: false, reason: 'expired' })
  })

  it('refuses a proof whose signature has been tampered with', () => {
    const hostSk = generateSecretKey()
    const guest = 'b'.repeat(64)
    const proof = issueKindredProof({ hostSk, participant: guest, tier: 'kith', expiresAt: NOW + 3600 })
    const tampered = { ...proof, tier: 'kin' as const }
    const r = evaluateAccess({ tier: 'kith', admitted: [getPublicKey(hostSk)] }, guest, tampered, NOW)
    expect(r).toEqual({ admitted: false, reason: 'bad signature' })
  })
})
