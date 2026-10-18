import { describe, expect, it } from 'vitest'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { createSessionFromSigner, SIGNET_VERIFIED_EVENT_SYMBOL, type SignetSigner } from 'signet-login'
import { captureOrdinaryFreshAccountProof, type OrdinaryFreshAccountProofExpectation } from './ordinary-fresh-account-proof.js'

const secret = new Uint8Array(32).fill(7), account = getPublicKey(secret)
const expectation: OrdinaryFreshAccountProofExpectation = Object.freeze({ account, challenge: 'ab'.repeat(32),
  origin: 'https://kithmoot.example', sdkStartedAt: 1_800_000_000_123, sdkPreparedAt: 1_800_000_000_126 })
function unsigned() {
  return { kind: 21236, created_at: Math.floor(expectation.sdkStartedAt / 1000), content: '',
    tags: [['challenge', expectation.challenge], ['origin', expectation.origin], ['app', 'KithMoot']] }
}
function signed(change?: (event: ReturnType<typeof unsigned>) => void) {
  const event = unsigned(); change?.(event)
  // Detach the fixture signer's own cache symbol: it need not be the exact
  // symbol exported by the SDK's installed nostr-tools instance.
  return JSON.parse(JSON.stringify(finalizeEvent(event, secret))) as ReturnType<typeof finalizeEvent>
}
function detached() {
  const event = signed()
  return { kind: event.kind, created_at: event.created_at, tags: event.tags.map(tag => [...tag]),
    content: event.content, pubkey: event.pubkey, id: event.id, sig: event.sig }
}

describe('fresh fixed-purpose account proof', () => {
  it('detaches and deeply freezes a real proof without preserving the SDK cache symbol', () => {
    const input = { ...signed(), [SIGNET_VERIFIED_EVENT_SYMBOL]: true }, before = Reflect.ownKeys(input), proof = captureOrdinaryFreshAccountProof(input, expectation)
    expect(proof).toEqual(JSON.parse(JSON.stringify(input))); expect(proof).not.toBe(input)
    expect(Reflect.ownKeys(proof)).toHaveLength(7); expect(Reflect.ownKeys(input)).toEqual(before)
    expect(Object.isFrozen(proof)).toBe(true); expect(Object.isFrozen(proof.tags)).toBe(true)
    expect(proof.tags.every(Object.isFrozen)).toBe(true)
    input.tags[0]![1] = 'mutated'; expect(proof.tags[0]![1]).toBe(expectation.challenge)
  })
  it('accepts the real SDK guarded two-callback result within synchronous construction bounds', async () => {
    const starts: number[] = [], before = Date.now()
    const signer: SignetSigner = { pubkey: account, method: 'nip07', providerEffectBoundary: 1,
      capabilities: { canSignEvents: true, hasNip44: false },
      signEvent: (event, boundary) => boundary!.start(() => Promise.resolve(finalizeEvent({ ...event,
        created_at: event.created_at!, tags: event.tags! }, secret))), close: async () => {} }
    const pending = createSessionFromSigner(signer, { appName: 'KithMoot', challenge: expectation.challenge,
      origin: expectation.origin, boundary: { start: async effect => { starts.push(starts.length); return effect() } } })
    const prepared = Date.now(), session = await pending
    const proof = captureOrdinaryFreshAccountProof(session.authEvent, { ...expectation, sdkStartedAt: before, sdkPreparedAt: prepared })
    expect(proof.pubkey).toBe(account); expect(starts).toEqual([0, 1])
  })
  for (const change of ['challenge', 'origin', 'app', 'kind', 'content', 'earlier', 'later', 'extra-tag', 'reordered', 'extra-part'] as const) {
    it('refuses a genuinely signed but different ' + change, () => {
      const event = signed(event => {
        if (change === 'challenge') event.tags[0]![1] = 'cd'.repeat(32)
        if (change === 'origin') event.tags[1]![1] = 'https://elsewhere.example'
        if (change === 'app') event.tags[2]![1] = 'Another app'
        if (change === 'kind') event.kind = 1
        if (change === 'content') event.content = 'not empty'
        if (change === 'earlier') event.created_at--
        if (change === 'later') event.created_at++
        if (change === 'extra-tag') event.tags.push(['app', 'KithMoot'])
        if (change === 'reordered') event.tags.reverse()
        if (change === 'extra-part') event.tags[0]!.push('extra')
      })
      expect(() => captureOrdinaryFreshAccountProof(event, expectation)).toThrow()
    })
  }
  it('refuses another valid signing account', () => {
    const event = JSON.parse(JSON.stringify(finalizeEvent(unsigned(), new Uint8Array(32).fill(8))))
    expect(() => captureOrdinaryFreshAccountProof(event, expectation)).toThrow()
  })
  for (const field of ['id', 'sig'] as const) it('refuses forged ' + field + ' even with the real SDK verified symbol', () => {
    const event = { ...detached(), [field]: '0'.repeat(field === 'id' ? 64 : 128), [SIGNET_VERIFIED_EVENT_SYMBOL]: true }
    expect(() => captureOrdinaryFreshAccountProof(event, expectation)).toThrow()
  })
  for (const field of ['kind', 'created_at', 'content', 'pubkey', 'tags', 'id', 'sig'] as const) it('does not execute proof accessor ' + field, () => {
    const event = detached(); let calls = 0
    Object.defineProperty(event, field, { get() { calls++; throw Error('Accessor executed') } })
    expect(() => captureOrdinaryFreshAccountProof(event, expectation)).toThrow(); expect(calls).toBe(0)
  })
  for (const fault of ['extra-field', 'unknown-symbol', 'false-cache', 'cache-accessor', 'sparse-tags', 'tag-accessor', 'part-accessor', 'tag-symbol', 'inherited'] as const) {
    it('refuses structural ' + fault + ' without running accessors', () => {
      let calls = 0
      const event: any = detached(), accessor = { get() { calls++; throw Error('Accessor executed') } }
      if (fault === 'extra-field') event.extra = true
      if (fault === 'unknown-symbol') event[Symbol('verified')] = true
      if (fault === 'false-cache') event[SIGNET_VERIFIED_EVENT_SYMBOL] = false
      if (fault === 'cache-accessor') Object.defineProperty(event, SIGNET_VERIFIED_EVENT_SYMBOL, accessor)
      if (fault === 'sparse-tags') delete event.tags[1]
      if (fault === 'tag-accessor') Object.defineProperty(event.tags, '0', accessor)
      if (fault === 'part-accessor') Object.defineProperty(event.tags[0], '1', accessor)
      if (fault === 'tag-symbol') event.tags[0][Symbol('extra')] = true
      if (fault === 'inherited') Object.setPrototypeOf(event, { arbitrary: true })
      expect(() => captureOrdinaryFreshAccountProof(event, expectation)).toThrow(); expect(calls).toBe(0)
    })
  }
  for (const fault of ['before', 'after', 'wide', 'fraction', 'unsafe', 'challenge', 'origin', 'account', 'extra', 'accessor'] as const) {
    it('refuses invalid privately supplied bounds/selection ' + fault, () => {
      const expected: any = { ...expectation }; let calls = 0
      if (fault === 'before') expected.sdkStartedAt = -1
      if (fault === 'after') expected.sdkPreparedAt = expected.sdkStartedAt - 1
      if (fault === 'wide') expected.sdkPreparedAt = expected.sdkStartedAt + 1001
      if (fault === 'fraction') expected.sdkStartedAt += 0.5
      if (fault === 'unsafe') expected.sdkPreparedAt = Number.MAX_SAFE_INTEGER + 1
      if (fault === 'challenge') expected.challenge = 'AB'.repeat(32)
      if (fault === 'origin') expected.origin += '/'
      if (fault === 'account') expected.account = 'not a key'
      if (fault === 'extra') expected.extra = true
      if (fault === 'accessor') Object.defineProperty(expected, 'account', { get() { calls++; throw Error('Accessor executed') } })
      expect(() => captureOrdinaryFreshAccountProof(signed(), expected)).toThrow(); expect(calls).toBe(0)
    })
  }
  it('accepts a timestamp at either side of a real second boundary', () => {
    const sdkStartedAt = expectation.sdkStartedAt - 124, sdkPreparedAt = sdkStartedAt + 2
    for (const created_at of [Math.floor(sdkStartedAt / 1000), Math.floor(sdkPreparedAt / 1000)]) {
      const event = JSON.parse(JSON.stringify(finalizeEvent({ ...unsigned(), created_at }, secret)))
      expect(captureOrdinaryFreshAccountProof(event, { ...expectation, sdkStartedAt, sdkPreparedAt }).created_at).toBe(created_at)
    }
  })
})
