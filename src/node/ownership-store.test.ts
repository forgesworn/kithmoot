import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { buildBotOwnershipRevocation } from 'signet-protocol'
import { OwnershipRegistry } from '../ownership-registry.js'
import { issueAgentOwnership } from '../ownership.js'
import { OwnershipFileStore, rememberOwnershipFile } from './ownership-store.js'
const dirs: string[] = []
function store() {
  const dir = mkdtempSync(join(tmpdir(), 'kithmoot-ownership-')); dirs.push(dir)
  return new OwnershipFileStore(join(dir, 'events'))
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const sk = generateSecretKey(), principal = getPublicKey(sk), agent = getPublicKey(generateSecretKey()), now = 1800000000
const proof = issueAgentOwnership({ principalSk: sk, agent, issuedAt: now, label: 'Helper' })
it('retains revocation across independent file stores and process restarts', () => {
  const first = store(), second = new OwnershipFileStore(first.directory)
  expect(new OwnershipRegistry(first).verify(proof, { agent, now }).ok).toBe(true)
  const revocation = finalizeEvent(buildBotOwnershipRevocation({ ownerPubkey: principal, botPubkey: agent, now: now + 1 }), sk)
  expect(new OwnershipRegistry(second).observe(revocation, now + 1)).toBe(true)
  expect(new OwnershipRegistry(first).verify(proof, { agent, now: now + 2 }).ok).toBe(false)
  const restarted = new OwnershipRegistry(new OwnershipFileStore(first.directory))
  expect(restarted.verify(proof, { agent, now: now + 2 }).ok).toBe(false)
  expect(first.keys()).toHaveLength(1)
  expect(statSync(first.directory).mode & 0o777).toBe(0o700)
  expect(statSync(join(first.directory, first.keys()[0])).mode & 0o777).toBe(0o600)
})
it('does not overwrite immutable evidence and refuses malformed or linked event files', () => {
  const files = store(), registry = new OwnershipRegistry(files)
  expect(registry.verify(proof, { agent, now }).ok).toBe(true)
  const key = files.keys()[0], value = files.get(key)!
  files.set(key, value)
  expect(() => files.set(key, 'changed')).toThrow()
  expect(files.get(key)).toBe(value)
  expect(() => files.get('../outside')).toThrow()
  writeFileSync(join(files.directory, key), 'broken')
  expect(registry.verify(proof, { agent, now }).ok).toBe(false)
  rmSync(join(files.directory, key))
  const outside = join(files.directory, '.outside'); writeFileSync(outside, value)
  symlinkSync(outside, join(files.directory, key))
  expect(registry.verify(proof, { agent, now }).ok).toBe(false)
})
it('fails closed on unavailable storage instead of accepting an unremembered claim', () => {
  const files = store()
  writeFileSync(files.directory, 'not a directory')
  expect(new OwnershipRegistry(files).verify(proof, { agent, now }).ok).toBe(false)
})

it('imports offline signed revocations and rejects forged event files without losing evidence', () => {
  const files = store(), registry = new OwnershipRegistry(files)
  expect(registry.verify(proof, { agent, now }).ok).toBe(true)
  const path = join(files.directory, '.import.json')
  const event = finalizeEvent(buildBotOwnershipRevocation({ ownerPubkey: principal, botPubkey: agent, now }), sk)
  writeFileSync(path, JSON.stringify(event))
  rememberOwnershipFile(path, files, now)
  expect(registry.verify(proof, { agent, now }).ok).toBe(false)
  writeFileSync(path, JSON.stringify({ ...proof.attestation, sig: '00'.repeat(64) }))
  expect(() => rememberOwnershipFile(path, files, now)).toThrow('invalid')
  expect(registry.verify(proof, { agent, now }).ok).toBe(false)
})
