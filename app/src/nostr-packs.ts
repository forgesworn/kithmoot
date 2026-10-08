import type { ParticipantIdentity } from '../../src/identity.js'
import { verifyEventUncached } from '../../src/verify.js'
export const CULT_REGISTRY = 'https://raw.githubusercontent.com/600-000-000-000/600000000000/main/.well-known/nostr.json'
/** An explicit, unpublished signer proof; fetching the registry never sends our public key. */
export async function unlockCultPack(identity: ParticipantIdentity, fetcher: typeof fetch = fetch): Promise<boolean> {
  const created_at = Math.floor(Date.now() / 1000)
  const challenge = crypto.randomUUID()
  const tags = [['u', CULT_REGISTRY], ['method', 'GET'], ['challenge', challenge]]
  const unsigned = { kind: 27235, created_at, tags, content: '' }
  const signed = await identity.signEvent(unsigned)
  if (signed.pubkey !== identity.pubkey || signed.kind !== unsigned.kind || signed.created_at !== created_at || signed.content !== '' || JSON.stringify(signed.tags) !== JSON.stringify(tags) || !verifyEventUncached(signed)) throw new Error('The signer did not confirm this account.')
  const response = await fetcher(CULT_REGISTRY, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error('The pack membership registry could not be reached. Try again.')
  const body = await response.text()
  if (body.length > 128_000) throw new Error('The pack membership registry is too large.')
  const registry: unknown = JSON.parse(body)
  const names = registry && typeof registry === 'object' && 'names' in registry ? registry.names : undefined
  if (!names || typeof names !== 'object' || Array.isArray(names)) return false
  return Object.values(names).some(value => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) && value.toLowerCase() === identity.pubkey.toLowerCase())
}
