import { expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { buildBotOwnershipRevocation } from 'signet-protocol'
import { agentOwnershipFromEvent, buildAgentOwnership, issueAgentOwnership, normaliseAgentOwnership, verifyAgentOwnership } from './ownership.js'
const principalSk = generateSecretKey(), principal = getPublicKey(principalSk)
const agent = getPublicKey(generateSecretKey()), now = 1800000000, DAY = 86400
it('uses a signer-neutral ordinary event and accepts the exported Signet event directly', () => {
  const unsigned = buildAgentOwnership({ principal, agent, issuedAt: now, label: 'Helper' })
  expect(unsigned.kind).toBe(31000)
  expect(unsigned.tags).toContainEqual(['d', `bot-ownership:${agent}`])
  const event = finalizeEvent(unsigned, principalSk)
  const proof = normaliseAgentOwnership(event)!
  expect(proof).toEqual(agentOwnershipFromEvent(event))
  expect(proof.expiresAt).toBe(now + 30 * DAY)
  expect(verifyAgentOwnership(proof, { agent, now })).toEqual({ ok: true, principal, label: 'Helper' })
  expect(verifyAgentOwnership(proof, { agent, now: now + 2 * DAY, maxLifetimeDays: 1 })).toEqual({ ok: false, reason: 'expired' })
})
it('rejects out-of-policy issuance and does not fall back to a legacy signature after event removal', () => {
  for (const days of [0, 0.5, 91]) {
    expect(() => issueAgentOwnership({ principalSk, agent, issuedAt: now, expiresAt: now + days * DAY })).toThrow()
  }
  const proof = issueAgentOwnership({ principalSk, agent, issuedAt: now, label: 'Helper' })
  const { attestation: _removed, ...downgraded } = proof
  expect(verifyAgentOwnership(downgraded, { agent, now }).ok).toBe(false)
  expect(normaliseAgentOwnership({ ...proof, attestation: { ...proof.attestation, content: '{"v":1,"label":"Imposter"}' } })).toBeNull()
  expect(verifyAgentOwnership({ ...proof, label: 'Imposter' }, { agent, now }).ok).toBe(false)
})
it('distinguishes signed revocation from expiry and refuses it as current ownership', () => {
  const event = finalizeEvent(buildBotOwnershipRevocation({ ownerPubkey: principal, botPubkey: agent, now }), principalSk)
  const proof = agentOwnershipFromEvent(event)!
  expect(verifyAgentOwnership(proof, { agent, now })).toEqual({ ok: false, reason: 'revoked' })
})
