import { describe, expect, it, vi } from 'vitest'
import type { SimplePool } from 'nostr-tools/pool'
import { DIAL_LEASE_MS, RelayDialGate } from '../../src/relay-dial-gate.js'
import { bindRelayPoolDialCustody } from './relay-pool-dial-custody.js'

const URL = 'wss://contacts.test/'
function setup(connected = false) {
  let now = 0
  const gate = new RelayDialGate(() => now)
  gate.failed(URL); now = 1000
  const ensure = vi.fn(async () => ({} as Awaited<ReturnType<SimplePool['ensureRelay']>>))
  const pool: Pick<SimplePool, 'ensureRelay' | 'listConnectionStatus' | 'allowConnectingToRelay' | 'onRelayConnectionSuccess' | 'onRelayConnectionFailure'> = {
    ensureRelay: ensure,
    listConnectionStatus: () => new Map([[URL, connected]]),
  }
  const close = bindRelayPoolDialCustody(pool, gate)
  return { gate, pool, close, ensure, advance: (ms: number) => { now += ms } }
}
describe('contacts pool shared dial custody', () => {
  it('cached connection callbacks and cleanup cannot release another pool’s lease', async () => {
    const f = setup(true), other = f.gate.reserve(URL)!
    expect(f.pool.allowConnectingToRelay!(URL, ['read', []])).toBe(true)
    await f.pool.ensureRelay(URL)
    f.pool.onRelayConnectionSuccess!(URL); f.pool.onRelayConnectionFailure!(URL); f.close()
    expect(f.gate.open(URL)).toBe(false); expect(f.gate.release(other)).toBe(true)
  })
  it('duplicate success cannot release the lease taken between callbacks', async () => {
    const f = setup(); expect(f.pool.allowConnectingToRelay!(URL, ['read', []])).toBe(true)
    await f.pool.ensureRelay(URL); f.pool.onRelayConnectionSuccess!(URL)
    const other = f.gate.reserve(URL)!
    f.pool.onRelayConnectionSuccess!(URL); f.close()
    expect(f.gate.open(URL)).toBe(false); expect(f.gate.release(other)).toBe(true)
  })
  it('late callbacks after cleanup preserve backoff and another pool’s newer lease', () => {
    const f = setup(); expect(f.pool.allowConnectingToRelay!(URL, ['read', []])).toBe(true)
    f.close(); const other = f.gate.reserve(URL)!, backoff = f.gate.retryAt(URL)
    f.pool.onRelayConnectionSuccess!(URL); f.pool.onRelayConnectionFailure!(URL); f.close()
    expect(f.gate.retryAt(URL)).toBe(backoff); expect(f.gate.release(other)).toBe(true)
    expect(f.pool.allowConnectingToRelay!(URL, ['read', []])).toBe(false)
  })
  it('cleanup of an expired receipt cannot release its replacement', () => {
    const f = setup(); expect(f.pool.allowConnectingToRelay!(URL, ['read', []])).toBe(true)
    f.advance(DIAL_LEASE_MS); const other = f.gate.reserve(URL)!
    f.close(); expect(f.gate.open(URL)).toBe(false); expect(f.gate.release(other)).toBe(true)
  })
  it('direct ensure cannot bypass another pool’s active reservation', async () => {
    const f = setup(), other = f.gate.reserve(URL)!
    await expect(f.pool.ensureRelay(URL)).rejects.toThrow('backoff')
    expect(f.ensure).not.toHaveBeenCalled(); f.close(); expect(f.gate.release(other)).toBe(true)
  })
})
