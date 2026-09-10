import { describe, expect, it } from 'vitest'
import { finalizeEvent, getPublicKey, verifiedSymbol } from 'nostr-tools/pure'
import { base64 } from '@scure/base'
import { buildLinkCard } from 'nostr-contact-card'
import { readBoxStatus, BOX_STATUS_MAX_AGE } from './box-status.js'
import { boxFixture } from '../test/box-status-fixture.js'

const { now, boxKey, masterKey, nodeKey, p, master, node, card, claim, pin, tags, status, withTag } = boxFixture()

describe('box endpoint discovery requires the full signed claim and status chain', () => {
  it('returns the signed message endpoint, never the Link transport hint', () => {
    const r = readBoxStatus(status(), claim, pin, now)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.status.dropsUrl).toBe('wss://owned.example/drops')
    expect(r.status.link.relays).toEqual(['wss://transport.example'])
    expect(r.status.validUntil).toBe(now + BOX_STATUS_MAX_AGE)
  })
  it('old statuses without endpoint extensions remain readable without an inferred endpoint', () => {
    const r = readBoxStatus(status(tags.filter(t => !['drops', 'software', 'carriers', 'retention', 'relaying'].includes(t[0]!))), claim, pin, now)
    expect(r.ok && r.status.dropsUrl).toBeUndefined()
    expect(r.ok && r.status.drops).toBe(false)
  })
  it('a fresh off status carries no endpoint', () => {
    const r = readBoxStatus(status(withTag('drops', ['off'])), claim, pin, now)
    expect(r.ok && r.status.drops).toBe(false)
    expect(r.ok && r.status.dropsUrl).toBeUndefined()
  })
  it('refuses a competing master claim even when a contact pin names it', () => {
    const attackerKey = new Uint8Array(32).fill(9)
    const competing = finalizeEvent({ ...claim, tags: claim.tags.map(t => t[0] === 'p' && t[3] === 'master' ? ['p', getPublicKey(attackerKey), '', 'master'] : t) }, attackerKey)
    expect(readBoxStatus(status(), competing, { ...pin, claim: competing.id }, now)).toMatchObject({ ok: false, reason: 'status claim binding' })
  })
  it('does not trust a cached signature verdict on a forged event', () => {
    const forged = { ...status(), tags: withTag('drops', ['on', 'wss://attacker.example']), [verifiedSymbol]: true }
    expect(readBoxStatus(forged, claim, pin, now)).toMatchObject({ ok: false, reason: 'event signature' })
  })
  it('pins the Link node independently of the signed status identity', () => {
    expect(readBoxStatus(status(), claim, { ...pin, nodeId: '0'.repeat(64) }, now).ok).toBe(false)
  })
  it('accepts the same card only when its verified bytes are retained', () => {
    const s = status()
    const held = { ...pin, highestSerial: 8, card: base64.encode(card), statusCreatedAt: now, statusId: s.id }
    expect(readBoxStatus(s, claim, held, now + 1).ok).toBe(true)
    expect(readBoxStatus(status(tags, now + 2), claim, held, now + 2).ok).toBe(true)
    expect(readBoxStatus(s, claim, { ...held, card: undefined }, now + 1).ok).toBe(false)
    const changed = buildLinkCard({ nodeSecret: nodeKey, issuedAt: now - 60, expiresAt: now + 86400, serial: 8, relays: ['wss://changed.example'] })
    expect(readBoxStatus(status(withTag('card', [base64.encode(changed)]), now + 2), claim, held, now + 2).ok).toBe(false)
  })
  it('does not roll back to an earlier status or a different event at the same timestamp', () => {
    const held = { ...pin, statusCreatedAt: now, statusId: status().id }
    expect(readBoxStatus(status(tags, now - 1), claim, held, now).ok).toBe(false)
    expect(readBoxStatus(status(withTag('drops', ['off'])), claim, held, now).ok).toBe(false)
  })
  it.each([
    ['duplicate singleton', [...tags, ['drops', 'off']]],
    ['off with an endpoint', withTag('drops', ['off', 'wss://owned.example/drops'])],
    ['cleartext endpoint', withTag('drops', ['on', 'ws://owned.example/drops'])],
    ['credentials in endpoint', withTag('drops', ['on', 'wss://user:pass@owned.example'])],
    ['malformed endpoint', withTag('drops', ['on', 'wss://:'])],
    ['mismatched card expiry', withTag('card-exp', [String(now + 200)])],
    ['unrounded capacity', withTag('free', ['1'])],
    ['capacity beyond pool', withTag('free', ['3221225472'])],
    ['unrounded aggregate', withTag('sheltered', ['1', '100'])],
    ['overflow', withTag('max-blob', ['18446744073709551616'])],
    ['duplicate class', withTag('classes', ['working', 'working'])],
    ['duplicate carrier', withTag('carriers', ['tor', 'tor'])],
    ['malformed optional software', withTag('software', ['bothy/0.1', 'bogus'])],
    ['expired status', [...tags, ['expiration', String(now)]]],
    ['noncanonical node', withTag('node', [tags[2]![1]!.slice(0, -1) + 'b'])],
    ['oversized card', withTag('card', ['A'.repeat(5500)])],
  ] as [string, string[][]][])('refuses signed %s', (_, changed) => {
    expect(readBoxStatus(status(changed), claim, pin, now).ok).toBe(false)
  })
  it('ignores unknown status hints but refuses unknown authority tags', () => {
    expect(readBoxStatus(status([...tags, ['future-transport', 'hint']]), claim, pin, now).ok).toBe(true)
    const c = finalizeEvent({ ...claim, tags: [...claim.tags, ['unknown-authority', 'value']] }, masterKey)
    expect(readBoxStatus(status(withTag('claim', [c.id])), c, { ...pin, claim: c.id }, now).ok).toBe(false)
  })
  it('refuses stale status, future status and a retired claim', () => {
    expect(readBoxStatus(status(tags, now - BOX_STATUS_MAX_AGE), claim, pin, now).ok).toBe(false)
    expect(readBoxStatus(status(tags, now + 301), claim, pin, now).ok).toBe(false)
    const retired = finalizeEvent({ ...claim, tags: claim.tags.filter(t => !(t[0] === 'p' && t[3] === 'stash')).map(t => t[0] === 'status' ? ['status', 'retired'] : t) }, masterKey)
    expect(readBoxStatus(status(withTag('claim', [retired.id])), retired, { ...pin, claim: retired.id }, now).ok).toBe(false)
  })
  it('rejects untrusted shapes without throwing', () => {
    for (const input of [null, [], {}, { ...status(), tags: [null] }, { ...status(), created_at: NaN }]) {
      expect(readBoxStatus(input, claim, pin, now).ok).toBe(false)
    }
  })
})
