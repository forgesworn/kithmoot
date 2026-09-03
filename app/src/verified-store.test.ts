import { describe, it, expect } from 'vitest'
import { memoryDeviceStore } from './device-store.js'
import {
  MAX_VERIFIED,
  VERIFIED_PREFIX,
  forgetVerified,
  participantVerification,
  rememberVerified,
  verifiedParticipants,
} from './verified-store.js'

const ADA = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const NOW = 1_700_000_000_000

describe('verified-store', () => {
  it('remembers nobody to begin with', () => {
    const store = memoryDeviceStore()
    expect(verifiedParticipants(store)).toEqual([])
    expect(participantVerification(store, ADA, 'Ada').status).toBe('unknown')
  })

  it('remembers a person by key, with the name they were using', () => {
    const store = memoryDeviceStore()
    rememberVerified(store, ADA, 'Ada', NOW)
    expect(verifiedParticipants(store)).toEqual([
      { participant: ADA, name: 'Ada', verifiedAt: Math.floor(NOW / 1000) },
    ])
    expect(participantVerification(store, ADA, 'Ada').status).toBe('verified')
  })

  it('flags a familiar name arriving on a different key', () => {
    // The September incident, in one assertion.
    const store = memoryDeviceStore()
    rememberVerified(store, ADA, 'Ada', NOW)
    const view = participantVerification(store, BOB, 'Ada')
    expect(view.status).toBe('key-changed')
    expect(view.expected).toBe(ADA)
  })

  it('stores seconds, not milliseconds', () => {
    const store = memoryDeviceStore()
    rememberVerified(store, ADA, 'Ada', NOW)
    expect(verifiedParticipants(store)[0]!.verifiedAt).toBe(Math.floor(NOW / 1000))
  })

  it('normalises the key, so case cannot create two records for one person', () => {
    const store = memoryDeviceStore()
    rememberVerified(store, ADA.toUpperCase(), 'Ada', NOW)
    expect(verifiedParticipants(store)).toHaveLength(1)
    expect(participantVerification(store, ADA, 'Ada').status).toBe('verified')
  })

  it('sanitises the name on the way in', () => {
    // Every other name this app touches goes through this; a record the
    // browser wrote itself is not an exception.
    const store = memoryDeviceStore()
    rememberVerified(store, ADA, 'Ada‮grepus', NOW)
    expect(verifiedParticipants(store)[0]!.name).not.toContain('‮')
  })

  it('keeps an unnamed person by key alone rather than as an empty name', () => {
    const store = memoryDeviceStore()
    rememberVerified(store, ADA, '   ', NOW)
    expect(verifiedParticipants(store)[0]!.name).toBe('')
    // And an empty name must not make every other unnamed person "changed".
    expect(participantVerification(store, BOB, '').status).toBe('unknown')
  })

  it('re-verifying updates rather than duplicating', () => {
    const store = memoryDeviceStore()
    rememberVerified(store, ADA, 'Ada', NOW)
    rememberVerified(store, ADA, 'Ada Lovelace', NOW + 60_000)
    const all = verifiedParticipants(store)
    expect(all).toHaveLength(1)
    expect(all[0]!.name).toBe('Ada Lovelace')
  })

  it('forgets on request', () => {
    const store = memoryDeviceStore()
    rememberVerified(store, ADA, 'Ada', NOW)
    forgetVerified(store, ADA)
    expect(verifiedParticipants(store)).toEqual([])
  })

  it('refuses a key that is not 64 hex rather than writing a junk record', () => {
    const store = memoryDeviceStore()
    expect(() => rememberVerified(store, 'deadbeef', 'Ada', NOW)).toThrow(/64 hex/)
    expect(verifiedParticipants(store)).toEqual([])
  })

  it('drops a malformed record instead of trusting it', () => {
    // This decides whether somebody is shown as verified. A half-written or
    // hand-edited entry must never be the reason a stranger looks familiar.
    const store = memoryDeviceStore()
    store.set(`${VERIFIED_PREFIX}${ADA}`, 'not json')
    store.set(`${VERIFIED_PREFIX}${BOB}`, JSON.stringify({ participant: 'short', name: 'Bob', verifiedAt: 1 }))
    expect(verifiedParticipants(store)).toEqual([])
    expect(participantVerification(store, ADA, 'Ada').status).toBe('unknown')
  })

  it('drops a record whose verifiedAt is not a finite number', () => {
    const store = memoryDeviceStore()
    store.set(`${VERIFIED_PREFIX}${ADA}`, JSON.stringify({ participant: ADA, name: 'Ada', verifiedAt: 'soon' }))
    expect(verifiedParticipants(store)).toEqual([])
  })

  it('ignores keys belonging to anything else in the store', () => {
    const store = memoryDeviceStore()
    store.set('kithmoot.room.abc', JSON.stringify({ roomId: 'abc' }))
    rememberVerified(store, ADA, 'Ada', NOW)
    expect(verifiedParticipants(store)).toHaveLength(1)
  })

  it('returns them newest first', () => {
    const store = memoryDeviceStore()
    rememberVerified(store, ADA, 'Ada', NOW)
    rememberVerified(store, BOB, 'Bob', NOW + 60_000)
    expect(verifiedParticipants(store).map((v) => v.participant)).toEqual([BOB, ADA])
  })

  it('prunes the oldest past the cap', () => {
    const store = memoryDeviceStore()
    for (let i = 0; i < MAX_VERIFIED + 5; i++) {
      rememberVerified(store, i.toString(16).padStart(64, '0'), `P${i}`, NOW + i * 1000)
    }
    const all = verifiedParticipants(store)
    expect(all).toHaveLength(MAX_VERIFIED)
    // The newest survive; the first five verified are gone.
    expect(all.at(-1)!.name).toBe('P5')
  })
})
