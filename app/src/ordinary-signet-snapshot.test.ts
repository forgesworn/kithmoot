import { afterEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { OrdinaryStateHold, ORDINARY_VALUE_UNITS } from './ordinary-state-codec.js'
import { ORDINARY_SIGNET_KEYS as k, validateOrdinarySignetSnapshot as validate, type OrdinarySignetSnapshotOptions } from './ordinary-signet-snapshot.js'

const key = new Uint8Array(32); key[31] = 1
const account = getPublicKey(key), origin = 'https://ordinary.test'
const options = { kind: 'browser' as const, origin, appName: 'KithMoot', account }
function session(method = 'nip07', tags = [['challenge', 'a'.repeat(64)], ['origin', origin], ['app', 'KithMoot']]): Map<string, string> {
  const proof = finalizeEvent({ kind: 21236, created_at: 1, tags, content: '' }, key)
  return new Map([[k.pubkey, account], [k.method, method], [k.authEvent, JSON.stringify(proof)]])
}
afterEach(() => vi.restoreAllMocks())
describe('pre-owner Signet partition', () => {
  it('preserves historical signed proof and returns frozen counts without entropy, clock or records', () => {
    const image = session(); const before = [...image]
    vi.spyOn(Date, 'now').mockImplementation(() => { throw Error('clock') })
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(() => { throw Error('entropy') })
    const result = validate(image, options)
    expect(result).toEqual({ sessions: 1, clientKeys: 0, pendingRedirects: 0, pendingRelayAuths: 0 })
    expect(Object.isFrozen(result)).toBe(true); expect([...image]).toEqual(before)
  })
  for (const method of ['nip07', 'redirect', 'amber', 'bunker']) it(`retains coherent ${method} session`, () => {
    const image = session(method)
    if (method === 'bunker') { image.set(k.bunkerClientSk, '03'.repeat(32)); image.set(k.bunkerUri, 'bunker://' + account + '?relay=wss%3A%2F%2Frelay.test') }
    expect(validate(image, options).sessions).toBe(1)
  })
  it('retains independent pending cuts without claiming a session', () => {
    const image = new Map([[k.clientSk, '03'.repeat(32)], [k.pendingRedirect, JSON.stringify({ challenge: 'a'.repeat(64), origin, appName: 'KithMoot', createdAt: 1 })],
      [k.pendingRelayAuth, JSON.stringify({ challenge: 'b'.repeat(64), origin, appName: 'KithMoot', issuedAt: 1, sessionSkHex: '04'.repeat(32), relayUrl: 'wss://relay.test' })]])
    expect(validate(image, options)).toEqual({ sessions: 0, clientKeys: 1, pendingRedirects: 1, pendingRelayAuths: 1 })
  })
  it('allows no SDK rows in a tab and leaves other families to the composite', () => {
    expect(validate(new Map([['kithmoot.notify', 'true']]), { ...options, kind: 'tab' }).sessions).toBe(0)
  })
  for (const fault of ['future', 'root', 'wrapped', 'tab', 'orphan', 'secret', 'account', 'method', 'origin', 'app', 'signature', 'proof-extra', 'duplicate-origin', 'expiry', 'bunker-orphan', 'pending-fields', 'pending-origin', 'pending-secret', 'pending-relay', 'oversize']) it(`holds ${fault} without changing source bytes`, () => {
    let image = session(); let opts: OrdinarySignetSnapshotOptions = options
    if (fault === 'future') image.set('signet:login.future', 'true')
    if (fault === 'root') image.set('signet:login', 'true')
    if (fault === 'wrapped') image = new Map([['kithmoot.account.' + account + '.' + k.clientSk, '03'.repeat(32)]])
    if (fault === 'tab') opts = { ...options, kind: 'tab' }
    if (fault === 'orphan') image.delete(k.pubkey)
    if (fault === 'secret') image.set(k.clientSk, '00'.repeat(32))
    if (fault === 'account') opts = { ...options, account: 'b'.repeat(64) }
    if (fault === 'method') image.set(k.method, 'nsec')
    if (fault === 'origin') image = session('nip07', [['challenge', 'a'.repeat(64)], ['origin', 'https://other.test']])
    if (fault === 'app') image = session('nip07', [['challenge', 'a'.repeat(64)], ['origin', origin], ['app', 'Other']])
    if (fault === 'duplicate-origin') image = session('nip07', [['challenge', 'a'.repeat(64)], ['origin', origin], ['origin', origin]])
    if (fault === 'signature' || fault === 'proof-extra') { const proof = JSON.parse(image.get(k.authEvent)!); if (fault === 'signature') proof.content = 'tampered'; else proof.extra = true; image.set(k.authEvent, JSON.stringify(proof)) }
    if (fault === 'expiry') image.set(k.expiresAt, '01')
    if (fault === 'bunker-orphan') image.set(k.bunkerClientSk, '03'.repeat(32))
    if (fault.startsWith('pending-')) {
      const record: Record<string, unknown> = { challenge: 'a'.repeat(64), origin, appName: 'KithMoot', createdAt: 1 }
      if (fault === 'pending-fields') record.extra = true
      if (fault === 'pending-origin') record.origin = 'https://other.test'
      if (fault === 'pending-secret' || fault === 'pending-relay') { delete record.createdAt; record.issuedAt = 1; record.sessionSkHex = fault === 'pending-secret' ? '00'.repeat(32) : '03'.repeat(32); record.relayUrl = fault === 'pending-relay' ? 'https://relay.test' : 'wss://relay.test' }
      image.set(fault === 'pending-secret' || fault === 'pending-relay' ? k.pendingRelayAuth : k.pendingRedirect, JSON.stringify(record))
    }
    if (fault === 'oversize') image.set(k.displayName, 'x'.repeat(ORDINARY_VALUE_UNITS + 1))
    const before = [...image]; expect(() => validate(image, opts)).toThrow(OrdinaryStateHold); expect([...image]).toEqual(before)
  })
})
