import type { Nip46DecryptBoundary, SignerEffectBoundary, SignetSession } from 'signet-login'
import { guardedWebSocket } from '../../src/guarded-websocket.js'

/** Receive-only NIP-44 capability, including a separately fenced NIP-46
 * transport when the foreground People inbox supplies its socket. */
export function ordinaryMessageDecrypt(account: SignetSession, selected: () => SignetSession | undefined, allowLocal = false, socket?: typeof WebSocket):
  ((peer: string, ciphertext: string, current: () => boolean) => Promise<string>) | undefined {
  const signer = account.signer, crypt = signer.nip44, decrypt = crypt?.decrypt, pubkey = account.pubkey, expiry = account.expiresAt
  const remote = account.method === 'bunker' && socket !== undefined
  const nip46 = signer.nip46, remoteDecrypt = nip46?.decryptNip44Guarded
  const check = (current: () => boolean) => {
    if (!current() || selected() !== account || account.pubkey !== pubkey || account.signer !== signer ||
        (!remote && account.method !== 'nip07' && !(allowLocal && account.method === 'nsec')) || signer.method !== account.method ||
        signer.pubkey !== pubkey || signer.providerEffectBoundary !== 1 ||
        !crypt || signer.nip44 !== crypt || crypt.decrypt !== decrypt || typeof decrypt !== 'function' || account.expiresAt !== expiry ||
        remote && (signer.nip46 !== nip46 || typeof remoteDecrypt !== 'function' || nip46?.decryptNip44Guarded !== remoteDecrypt) ||
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
      const permitted = () => {
        if (finished) return false
        try { check(current); return true } catch { return false }
      }
      let result: string
      if (remote) {
        const Guarded = guardedWebSocket(socket!, permitted)
        const rpc: Nip46DecryptBoundary = {
          ...boundary, current: permitted, websocketImplementation: class extends Guarded {
            constructor(...args: ConstructorParameters<typeof WebSocket>) {
              check(permitted)
              super(...args)
            }
          },
        }
        result = await remoteDecrypt!.call(nip46, peer, ciphertext, rpc)
      } else result = await decrypt!.call(crypt, peer, ciphertext, boundary)
      check(current)
      if (starts !== 1 || !completed || provided !== result) throw Error('Signer did not preserve the decryption boundary.')
      return result
    } finally { finished = true; if (work) await work.catch(() => {}) }
  }
}
