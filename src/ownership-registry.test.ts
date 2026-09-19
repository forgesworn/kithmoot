import { expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { buildBotOwnershipRevocation } from 'signet-protocol'
import { issueAgentOwnership } from './ownership.js'
import { OwnershipRegistry, type OwnershipEventStore } from './ownership-registry.js'
const sk = generateSecretKey(), principal = getPublicKey(sk), agent = getPublicKey(generateSecretKey()), now = 1800000000
const proof = issueAgentOwnership({ principalSk: sk, agent, issuedAt: now, label: 'Helper' })
const revoke = (at: number) => finalizeEvent(buildBotOwnershipRevocation({ ownerPubkey: principal, botPubkey: agent, now: at }), sk)
function store(): OwnershipEventStore {
  const data = new Map<string, string>()
  return { get: key => data.get(key) ?? null, set: (key, value) => { data.set(key, value) }, keys: () => [...data.keys()], remove: key => { data.delete(key) } }
}
it('remembers revocation across restarts and refuses older claims, allowing a later owner renewal', () => {
  const storage = store(), registry = new OwnershipRegistry(storage)
  expect(registry.verify(proof, { agent, now }).ok).toBe(true)
  expect(registry.observe(revoke(now + 1), now + 1)).toBe(true)
  const restarted = new OwnershipRegistry(storage)
  expect(restarted.verify(proof, { agent, now: now + 2 })).toMatchObject({ ok: false, reason: 'superseded ownership' })
  const renewal = issueAgentOwnership({ principalSk: sk, agent, issuedAt: now + 3, label: 'Renewed' })
  expect(restarted.verify(renewal, { agent, now: now + 3 }).ok).toBe(true)
  expect(restarted.verify(proof, { agent, now: now + 3 }).ok).toBe(false)
})
it('makes equal-clock revocation win in either arrival order', () => {
  for (const reversed of [false, true]) {
    const registry = new OwnershipRegistry(), event = revoke(now)
    for (const value of reversed ? [event, proof.attestation!] : [proof.attestation!, event]) expect(registry.observe(value, now)).toBe(true)
    expect(registry.verify(proof, { agent, now }).ok).toBe(false)
  }
})
it('does not let invalid or future events poison evidence, and fails closed on broken storage', () => {
  const storage = store(), registry = new OwnershipRegistry(storage)
  expect(registry.observe({ ...revoke(now), sig: '00'.repeat(64) }, now)).toBe(false)
  expect(registry.observe(revoke(now + 301), now)).toBe(false)
  expect(registry.verify(proof, { agent, now }).ok).toBe(true)
  storage.set(storage.keys()[0], 'broken')
  expect(registry.verify(proof, { agent, now }).ok).toBe(false)
  const unavailable = new OwnershipRegistry({ get: () => null, keys: () => [], set: () => { throw new Error('full') }, remove: () => {} })
  expect(unavailable.verify(proof, { agent, now }).ok).toBe(false)
})
it('does not evict remembered events to make room for new ownership', () => {
  const storage = store()
  for (let i = 0; i < 500; i++) storage.set(`kithmoot.ownership.v1.${i}:event`, 'reserved')
  expect(new OwnershipRegistry(storage).verify(proof, { agent, now }).ok).toBe(false)
  expect(storage.keys()).toHaveLength(500)
})


it('cannot overwrite a concurrently remembered revocation from another tab', () => {
  const storage = store(), second = new OwnershipRegistry(storage)
  let interleaved = false
  const first = new OwnershipRegistry({ ...storage, set: (key, value) => {
    if (!interleaved) {
      interleaved = true
      expect(second.observe(revoke(now + 1), now + 1)).toBe(true)
    }
    storage.set(key, value)
  } })
  expect(first.verify(proof, { agent, now: now + 1 }).ok).toBe(false)
  expect(new OwnershipRegistry(storage).verify(proof, { agent, now: now + 2 }).ok).toBe(false)
})
