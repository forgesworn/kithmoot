import type { SignerEffectBoundary, SignetSession } from 'signet-login'

/** Receive-only bridge for the first supported browser-extension path. A
 * supplied boundary restricts the SDK's actual provider start and handoff;
 * it is not proof of native custody, consent or permission to sign anything.
 * Other methods need their own deferred-start/transport qualification. */
export function legacyMessageDecrypt(account: SignetSession, selected: () => SignetSession | undefined,
  now: () => number = () => Date.now()): ((peer: string, ciphertext: string, current: () => boolean) => Promise<string>) | undefined {
  try {
    const signer = account.signer, crypt = signer.nip04, decrypt = crypt?.decrypt
    const participant = account.pubkey, expiresAt = account.expiresAt
    if (account.method !== 'nip07' || signer.method !== 'nip07' || signer.pubkey !== participant ||
        signer.providerEffectBoundary !== 1 || !crypt || typeof decrypt !== 'function' || selected() !== account ||
        expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || now() >= expiresAt)) return
    const check = (current: () => boolean): void => {
      if (!current() || selected() !== account || account.pubkey !== participant || account.signer !== signer ||
          account.method !== 'nip07' || signer.method !== 'nip07' || signer.pubkey !== participant ||
          signer.providerEffectBoundary !== 1 || signer.nip04 !== crypt || crypt.decrypt !== decrypt ||
          account.expiresAt !== expiresAt || expiresAt !== undefined && now() >= expiresAt ||
          !current() || selected() !== account) throw Error('Legacy decryption is no longer available.')
    }
    return async (peer, ciphertext, current) => {
      const boundary: SignerEffectBoundary = {
        async start<T>(provider: () => Promise<T>): Promise<T> {
          check(current)
          const pending = provider() // No await between current check and actual start.
          const value = await pending
          check(current)
          return value
        },
      }
      check(current)
      const value = await Reflect.apply(decrypt, crypt, [peer, ciphertext, boundary])
      check(current)
      return value
    }
  } catch { return undefined }
}
