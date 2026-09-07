import { describe, it, expect } from 'vitest'
import { ContextVault } from './index.js'
import { createNostrIdentity } from './nostr.js'
import { sha256Hex } from './blossom.js'

const now = 1800000000
const owner = createNostrIdentity(new Uint8Array(32).fill(3))
const reader = createNostrIdentity(new Uint8Array(32).fill(4))
const origin = 'https://storage.example'
function storage() {
  const blobs = new Map<string, Uint8Array>()
  let requests = 0
  const fetcher: typeof fetch = async (input, init) => {
    requests++
    if (init?.method === 'PUT') {
      const bytes = new Uint8Array(init.body as ArrayBuffer), hash = sha256Hex(bytes)
      const url = `${origin}/${hash}`
      blobs.set(url, bytes)
      return Response.json({ url, sha256: hash, size: bytes.length }, { status: 201 })
    }
    const bytes = blobs.get(String(input))
    return new Response(bytes?.slice().buffer, { status: bytes ? 200 : 404 })
  }
  return { blobs, fetch: fetcher, requests: () => requests }
}

describe('portable context without a KithMoot runtime', () => {
  it('shares and restores sourced records between plain Nostr identities', async () => {
    const store = storage()
    const a = new ContextVault({ identity: owner, fetch: store.fetch, servers: [origin], now: () => now })
    let view = await a.create({ title: 'Project decisions', scope: 'kith' })
    view = await a.setGrants(view.id, view.head, [{ subject: reader.pubkey, role: 'read', expiresAt: now + 100 }])
    view = await a.append(view.id, view.head, { kind: 'decision', text: 'Keep the original signatures.', source: 'https://example.org/decision/42', observedAt: now })
    expect(store.requests()).toBe(0)
    await a.upload(view.id, origin)
    const access = await a.access(view.id, reader.pubkey)
    const b = new ContextVault({ identity: reader, fetch: store.fetch, servers: [origin], now: () => now })
    await b.previewAccess(access)
    expect(store.requests()).toBe(1)
    await b.importAccess(access)
    const cache = await b.save()
    expect(cache).not.toContain('Keep the original signatures.')
    const restarted = new ContextVault({ identity: reader, fetch: store.fetch, now: () => now })
    await restarted.restore(cache)
    expect(store.requests()).toBe(2)
    expect(restarted.read(view.id).records).toEqual(view.records)
    await expect(restarted.append(view.id, view.head, { kind: 'fact', text: 'Unauthorised', source: 'fixture://42', observedAt: now })).rejects.toThrow('write permission')
    const expired = new ContextVault({ identity: reader, fetch: store.fetch, servers: [origin], now: () => now + 101 })
    await expect(expired.importAccess(access)).rejects.toThrow('not available')
    expect(store.requests()).toBe(2)
  })

  it('refuses unknown proofs and personal sharing unless explicitly verified', async () => {
    const vault = new ContextVault({ identity: owner, now: () => now })
    const shared = await vault.create({ title: 'Shared', scope: 'kith' })
    const grant = { subject: reader.pubkey, role: 'read' as const, expiresAt: now + 100, agent: { claimedPrincipal: owner.pubkey } }
    await expect(vault.setGrants(shared.id, shared.head, [grant])).rejects.toThrow('ownership proof')
    const personal = await vault.create({ title: 'Private', scope: 'personal' })
    const { agent: _, ...plainGrant } = grant
    await expect(vault.setGrants(personal.id, personal.head, [plainGrant])).rejects.toThrow('owner’s agents')
    expect(vault.read(shared.id).head).toBe(shared.head)
    expect(vault.read(personal.id).head).toBe(personal.head)
  })

  it('accepts a host proof format without importing KithMoot ownership', async () => {
    // The host has independently verified this opaque test token. Merely putting
    // a principal field in a received proof does not satisfy this verifier.
    const token = { attestation: 'verified-by-host' }
    const vault = new ContextVault({ identity: owner, now: () => now,
      verifyDelegation: (proof, options) => JSON.stringify(proof) === JSON.stringify(token) && options.agent === reader.pubkey
        ? { ok: true, principal: owner.pubkey } : { ok: false } })
    const view = await vault.create({ title: 'Private delegation', scope: 'personal' })
    const result = await vault.setGrants(view.id, view.head, [{ subject: reader.pubkey, role: 'read', expiresAt: now + 100, agent: token }])
    expect(result.epoch).toBe(2)
    const noVerifier = new ContextVault({ identity: owner, now: () => now })
    await expect(noVerifier.restore(await vault.save())).rejects.toThrow('ownership proof')
    expect(noVerifier.list()).toEqual([])
  })
})
