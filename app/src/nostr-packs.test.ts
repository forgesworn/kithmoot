import { describe, it, expect } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import { localIdentity } from '../../src/identity.js'
import { unlockCultPack } from './nostr-packs.js'

describe('member pack unlock', () => {
  it('requires the current account signature, downloads no account-specific URL and leaves non-members locked', async () => {
    const identity = localIdentity(generateSecretKey())
    const calls: string[] = []
    const fetcher = (async (url: string | URL | Request, options?: RequestInit) => {
      calls.push(String(url)); expect(String(url)).not.toContain(identity.pubkey)
      expect(options?.credentials).toBe('omit'); expect(options?.headers).toBeUndefined()
      return new Response(JSON.stringify({ names: { member: identity.pubkey } }))
    }) as typeof fetch
    expect(await unlockCultPack(identity, fetcher)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(await unlockCultPack(identity, (async () => new Response('{"names":{}}')) as typeof fetch)).toBe(false)
  })
  it('rejects a substituted account or signer challenge before fetching membership', async () => {
    const identity = localIdentity(generateSecretKey())
    const other = localIdentity(generateSecretKey())
    let fetched = false
    const fetcher = (async () => { fetched = true; return new Response('{}') }) as typeof fetch
    await expect(unlockCultPack({ ...identity, signEvent: unsigned => other.signEvent(unsigned) }, fetcher)).rejects.toThrow(/account/)
    await expect(unlockCultPack({ ...identity, signEvent: unsigned => identity.signEvent({ ...unsigned, tags: [] }) }, fetcher)).rejects.toThrow(/account/)
    expect(fetched).toBe(false)
  })
})
