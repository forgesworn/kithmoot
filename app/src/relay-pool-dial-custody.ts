import type { SimplePool } from 'nostr-tools/pool'
import { normalizeURL } from 'nostr-tools/utils'
import { relayDials, type RelayDialGate, type RelayDialLease } from '../../src/relay-dial-gate.js'

type Pool = Pick<SimplePool, 'ensureRelay' | 'listConnectionStatus' | 'allowConnectingToRelay' | 'onRelayConnectionSuccess' | 'onRelayConnectionFailure'>
/** Local shared-backoff ownership only. This grants no signer or room access. */
export function bindRelayPoolDialCustody(pool: Pool, gate: RelayDialGate = relayDials): () => void {
  const owned = new Map<string, RelayDialLease>()
  let closed = false
  const acquire = (url: string): boolean => {
    const key = normalizeURL(url)
    if (closed) return false
    if (pool.listConnectionStatus().get(key) === true || owned.has(key)) return true
    const receipt = gate.reserve(key)
    if (!receipt) return false
    owned.set(key, receipt); return true
  }
  pool.allowConnectingToRelay = acquire
  const ensure = pool.ensureRelay
  pool.ensureRelay = (url, params) => {
    const key = normalizeURL(url)
    if (!acquire(key)) return Promise.reject(new Error('Relay connection is held by shared backoff or cancelled.'))
    const receipt = owned.get(key)
    const forget = () => { if (receipt && owned.get(key) === receipt) owned.delete(key) }
    const fail = () => {
      forget()
      if (closed) { if (receipt) gate.release(receipt) }
      else gate.failedDial(key, receipt)
    }
    try {
      return ensure.call(pool, url, params).then(relay => {
        forget(); if (receipt) gate.release(receipt); return relay
      }, error => { fail(); throw error })
    } catch (error) { fail(); return Promise.reject(error) }
  }
  // The exact ensure promise owns completion. URL-only SDK callbacks may be
  // duplicated after another attempt has acquired a different receipt.
  pool.onRelayConnectionSuccess = () => {}
  pool.onRelayConnectionFailure = () => {}
  return () => {
    if (closed) return
    closed = true
    const receipts = [...owned.values()]; owned.clear()
    for (const receipt of receipts) gate.release(receipt)
  }
}
