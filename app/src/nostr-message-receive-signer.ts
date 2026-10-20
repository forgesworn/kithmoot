import type { SignerEffectBoundary, SignetSession } from 'signet-login'

/** Receive-only NIP-44 capability for the first qualified SDK transport.
 * Neither signing nor encryption authority enters the inbox. */
export function ordinaryMessageDecrypt(account: SignetSession, selected: () => SignetSession | undefined):
  ((peer: string, ciphertext: string, current: () => boolean) => Promise<string>) | undefined {
  const signer = account.signer, crypt = signer.nip44, decrypt = crypt?.decrypt, pubkey = account.pubkey, expiry = account.expiresAt
  const check = (current: () => boolean) => {
    if (!current() || selected() !== account || account.pubkey !== pubkey || account.signer !== signer ||
        account.method !== 'nip07' || signer.method !== 'nip07' || signer.pubkey !== pubkey || signer.providerEffectBoundary !== 1 ||
        !crypt || signer.nip44 !== crypt || crypt.decrypt !== decrypt || typeof decrypt !== 'function' || account.expiresAt !== expiry ||
        expiry !== undefined && (!Number.isSafeInteger(expiry) || Date.now() >= expiry) || !current() || selected() !== account) {
      throw Error('Ordinary message decryption is no longer available.')
    }
  }
  try { check(() => true) } catch { return }
  return async (peer, ciphertext, current) => {
    let starts = 0, finished = false, completed = false, provided: unknown
    let work: Promise<unknown> | undefined
    const boundary: SignerEffectBoundary = {
      start<T>(provider: () => Promise<T>): Promise<T> {
        if (finished || ++starts !== 1) return Promise.reject(Error('Ordinary decryption provider start was repeated or expired.'))
        const pending = (async () => {
          check(current)
          const value = await provider()
          check(current); provided = value; completed = true
          return value
        })()
        work = pending; void pending.catch(() => {}); return pending
      },
    }
    try {
      check(current)
      const result = await decrypt!.call(crypt, peer, ciphertext, boundary)
      check(current)
      if (starts !== 1 || !completed || provided !== result) throw Error('Signer did not preserve the decryption boundary.')
      return result
    } finally { finished = true; if (work) await work.catch(() => {}) }
  }
}
