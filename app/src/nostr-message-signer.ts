import type { Nip46RequestBoundary, SignerEffectBoundary, SignetSession } from 'signet-login'
import { guardedWebSocket } from '../../src/guarded-websocket.js'
import type { NostrMessageIdentity } from './nostr-message.js'

/** People supplies an explicit socket for guarded remote-signer requests. */
export function nostrMessageIdentity(account: SignetSession, selected: () => SignetSession | undefined, allowLocal = false, socket?: typeof WebSocket): NostrMessageIdentity | undefined {
  return guardedIdentity(account, selected, true, allowLocal, socket)
}
/** The same qualified provider boundary for event-only approvals. File
 * encryption happens locally and does not require signer NIP-44 support. */
export function nostrEventSigner(account: SignetSession, selected: () => SignetSession | undefined, allowLocal = false, socket?: typeof WebSocket): Pick<NostrMessageIdentity, 'pubkey' | 'signEvent'> | undefined {
  const identity = guardedIdentity(account, selected, false, allowLocal, socket)
  return identity ? { pubkey: identity.pubkey, signEvent: identity.signEvent } : undefined
}
function guardedIdentity(account: SignetSession, selected: () => SignetSession | undefined, requireEncryption: boolean,
  allowLocal: boolean, socket?: typeof WebSocket): NostrMessageIdentity | undefined {
  const signer = account.signer, crypt = signer.nip44, encrypt = crypt?.encrypt, sign = signer.signEvent
  const nip46 = signer.nip46, remoteEncrypt = nip46?.encryptNip44Guarded, remoteSign = nip46?.signEventGuarded
  const pubkey = account.pubkey, method = account.method, expiry = account.expiresAt
  const remote = method === 'bunker' && socket !== undefined
  if (remote) {
    if (typeof remoteSign !== 'function' || requireEncryption && typeof remoteEncrypt !== 'function') return
  } else if (method !== 'nip07' && !(allowLocal && method === 'nsec') ||
    typeof sign !== 'function' || requireEncryption && typeof encrypt !== 'function') return

  const check = (current: () => boolean): void => {
    if (!current() || selected() !== account || account.signer !== signer || account.pubkey !== pubkey ||
        account.method !== method || signer.method !== method ||
        signer.pubkey !== pubkey || signer.providerEffectBoundary !== 1 ||
        !signer.capabilities.canSignEvents || signer.nip44 !== crypt || crypt?.encrypt !== encrypt || signer.signEvent !== sign ||
        remote && (signer.nip46 !== nip46 || nip46?.signEventGuarded !== remoteSign || nip46?.encryptNip44Guarded !== remoteEncrypt) ||
        account.expiresAt !== expiry || expiry !== undefined && (!Number.isSafeInteger(expiry) || Date.now() >= expiry) ||
        !current() || selected() !== account) throw Error('Public message signer is no longer available.')
  }
  try { check(() => true) }
  catch { return }
  async function invoke<T>(current: () => boolean, call: (boundary: SignerEffectBoundary, permitted: () => boolean) => Promise<T>, maxStarts: number): Promise<T> {
    let starts = 0, finished = false, running = false, completed = false, provided: unknown
    const jobs: Promise<unknown>[] = []
    const permitted = () => {
      if (finished) return false
      try { check(current); return true } catch { return false }
    }
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
      const result = await call(boundary, permitted)
      check(current)
      if (!completed || !starts || result !== provided) throw Error('Signer did not preserve its provider-start contract.')
      return result
    } finally { finished = true; await Promise.allSettled(jobs) }
  }
  if (remote) {
    const rpc = (boundary: SignerEffectBoundary, current: () => boolean): Nip46RequestBoundary => ({
      ...boundary, current, websocketImplementation: guardedWebSocket(socket!, current),
    })
    return { pubkey,
      encrypt: (peer, text, current) => invoke(current, (boundary, permitted) =>
        remoteEncrypt!.call(nip46, peer, text, rpc(boundary, permitted)), 1),
      signEvent: (template, current) => invoke(current, (boundary, permitted) =>
        remoteSign!.call(nip46, template, rpc(boundary, permitted)), 1),
    }
  }
  return { pubkey,
    encrypt: (peer, text, current) => invoke(current, boundary => encrypt!.call(crypt, peer, text, boundary), 1),
    // SDK v0.19.1 may retry one transient NIP-07 sign failure. Both starts
    // independently check the live account, view and contact permission.
    signEvent: (template, current) => invoke(current, boundary => sign.call(signer, template, boundary), 2),
  }
}
