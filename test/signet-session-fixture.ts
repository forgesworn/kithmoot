import type { EventTemplate, SignetSession, SignetSigner } from 'signet-login'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'

/** Complete the SDK's optional template fields at the synthetic provider. */
export function signetFixtureEvent(template: EventTemplate, key: Uint8Array) {
  return finalizeEvent({ ...template, created_at: template.created_at ?? 1, tags: template.tags ?? [] }, key)
}

/** A real signed proof for fixture keys, not an exercised login ceremony. */
export function signetFixtureSession(signer: SignetSigner, key: Uint8Array, expiresAt?: number): SignetSession {
  const pubkey = getPublicKey(key)
  if (signer.pubkey !== pubkey) throw Error('Fixture signer does not own its session key')
  const auth = signetFixtureEvent({ kind: 21236, content: 'synthetic unit fixture', tags: [] }, key)
  return { pubkey, method: signer.method, signer, authEvent: { ...auth, kind: 21236 },
    ...(expiresAt === undefined ? {} : { expiresAt }) }
}
