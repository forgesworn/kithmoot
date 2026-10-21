import { describe, it, expect } from 'vitest'
import { memoryDeviceStore } from './device-store.js'
import { BLOCK_PREFIX, blockParticipant, blocksFor, unblockParticipant } from './block-store.js'

const ME = 'a'.repeat(64)
const OTHER_ME = 'c'.repeat(64)
const SPAMMER = 'b'.repeat(64)
const STRANGER = 'd'.repeat(64)
const NOW = 1_700_000_000_000

describe('block-store', () => {
  it('blocks nobody to begin with', () => {
    expect(blocksFor(memoryDeviceStore(), ME)).toEqual([])
  })

  it('blocks and unblocks per account, newest first', () => {
    const store = memoryDeviceStore()
    blockParticipant(store, ME, SPAMMER, NOW)
    blockParticipant(store, ME, STRANGER.toUpperCase(), NOW + 1)
    expect(blocksFor(store, ME).map(block => block.participant)).toEqual([STRANGER, SPAMMER])
    // Another account on the same device has blocked nobody.
    expect(blocksFor(store, OTHER_ME)).toEqual([])
    unblockParticipant(store, ME, SPAMMER)
    expect(blocksFor(store, ME)).toEqual([{ participant: STRANGER, blockedAt: NOW + 1 }])
  })

  it('keeps one key per person under the account', () => {
    const store = memoryDeviceStore()
    blockParticipant(store, ME, SPAMMER, NOW)
    blockParticipant(store, ME, SPAMMER, NOW + 5)
    expect(store.keys()).toEqual([`${BLOCK_PREFIX}${ME}.${SPAMMER}`])
    expect(blocksFor(store, ME)).toEqual([{ participant: SPAMMER, blockedAt: NOW + 5 }])
  })

  it('refuses yourself and anything that is not a key', () => {
    const store = memoryDeviceStore()
    expect(() => blockParticipant(store, ME, ME, NOW)).toThrow(/yourself/)
    expect(() => blockParticipant(store, ME, 'npub1spam', NOW)).toThrow(/64 hex/)
    expect(() => blocksFor(store, 'me')).toThrow(/64 hex/)
  })

  it('drops a record it cannot vouch for', () => {
    const store = memoryDeviceStore()
    store.set(`${BLOCK_PREFIX}${ME}.${SPAMMER}`, 'not json')
    store.set(`${BLOCK_PREFIX}${ME}.${STRANGER}`, JSON.stringify({ participant: SPAMMER, blockedAt: NOW }))
    expect(blocksFor(store, ME)).toEqual([])
  })
})
