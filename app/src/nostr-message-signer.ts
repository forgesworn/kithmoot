import type { SignerEffectBoundary, SignetSession } from 'signet-login'
import type { NostrMessageIdentity } from './nostr-message.js'

/** First supported account path. The SDK hook checks the actual provider
 * start and handoff; a check before an SDK call alone is insufficient. Other
 * signer transports require their own wire/deferred-start qualification. */
export function nostrMessageIdentity(account: SignetSession, selected: () => SignetSession | undefined): NostrMessageIdentity | undefined {
  const signer = account.signer, crypt = signer.nip44, encrypt = crypt?.encrypt, sign = signer.signEvent
  const pubkey = account.pubkey, expiry = account.expiresAt
  const check = (current: () => boolean): void => {
    if (!current() || selected() !== account || account.signer !== signer || account.pubkey !== pubkey ||
        account.method !== 'nip07' || signer.method !== 'nip07' || signer.pubkey !== pubkey || signer.providerEffectBoundary !== 1 ||
        !signer.capabilities.canSignEvents || signer.nip44 !== crypt || crypt?.encrypt !== encrypt || signer.signEvent !== sign ||
        account.expiresAt !== expiry || expiry !== undefined && (!Number.isSafeInteger(expiry) || Date.now() >= expiry) ||
        !current() || selected() !== account) throw Error('Public message signer is no longer available.')
  }
  try { check(() => true); if (!encrypt || !sign) return }
  catch { return }
  async function invoke<T>(current: () => boolean, call: (boundary: SignerEffectBoundary) => Promise<T>, maxStarts: number): Promise<T> {
    let starts = 0, finished = false, running = false, completed = false, provided: unknown
    const jobs: Promise<unknown>[] = []
    const boundary: SignerEffectBoundary = {
      start<V>(provider: () => Promise<V>): Promise<V> {
        if (finished || running || ++starts > maxStarts) return Promise.reject(Error('Public message provider start is unavailable.'))
        const pending = (async () => {
          check(current); running = true
          try { const actual = provider(); const value = await actual; check(current); completed = true; provided = value; return value }
          finally { running = false }
        })()
        jobs.push(pending); void pending.catch(() => {})
        return pending
      },
    }
    try {
      check(current)
      const result = await call(boundary)
      check(current)
      if (!completed || !starts || result !== provided) throw Error('Signer did not preserve its provider-start contract.')
      return result
    } finally { finished = true; await Promise.allSettled(jobs) }
  }
  return { pubkey,
    encrypt: (peer, text, current) => invoke(current, boundary => encrypt!.call(crypt, peer, text, boundary), 1),
    // SDK v0.19.1 may retry one transient NIP-07 sign failure. Both starts
    // independently check the live account, view and contact permission.
    signEvent: (template, current) => invoke(current, boundary => sign.call(signer, template, boundary), 2),
  }
}
