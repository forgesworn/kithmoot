import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils'
import { memoryDeviceStore } from './device-store.js'
import { OWNER_LIST_CAP, forgetSharedOwner, keepSharedOwner, loadSharedOwner, mergeSharedOwner, readSharedOwner, sharedOwnerNews } from './room-owner-share.js'

const person = () => getPublicKey(generateSecretKey())
const key = () => bytesToHex(generateSecretKey())

describe('shared room owner keys', () => {
  it('accepts only a well-formed key, and a removal wins over membership', () => {
    const a = person(), b = person(), k = key()
    expect(readSharedOwner({ key: 'not a key' })).toBeUndefined()
    expect(readSharedOwner({ key: '0'.repeat(64) })).toBeUndefined()
    expect(readSharedOwner({ key: k, members: [a, b, a, 'x'], removed: [b, 7] })).toEqual({ key: k, members: [a], removed: [b] })
    expect(readSharedOwner({ key: k, members: Array.from({ length: OWNER_LIST_CAP + 5 }, person) })?.members).toHaveLength(OWNER_LIST_CAP)
  })

  it('never replaces a key already kept, and only grows its lists', () => {
    const store = memoryDeviceStore(), account = person(), room = person(), first = key(), a = person(), b = person()
    keepSharedOwner(store, account, room, { key: first, members: [a], removed: [] })
    keepSharedOwner(store, account, room, { key: key(), members: [b], removed: [a] })
    expect(loadSharedOwner(store, account, room)).toEqual({ key: first, members: [b], removed: [a] })
    expect(loadSharedOwner(store, person(), room)).toBeUndefined()
    forgetSharedOwner(store, room)
    expect(loadSharedOwner(store, account, room)).toBeUndefined()
  })

  it('counts a key, a removal or a first list of members as news, never members added to a list', () => {
    const k = key(), a = person(), held = { key: k, members: [a], removed: [] }
    expect(sharedOwnerNews(undefined, held)).toBe(true)
    expect(sharedOwnerNews(held, undefined)).toBe(false)
    expect(sharedOwnerNews(held, mergeSharedOwner(held, { key: k, members: [person()], removed: [] }))).toBe(false)
    expect(sharedOwnerNews(held, mergeSharedOwner(held, { key: k, members: [], removed: [a] }))).toBe(true)
    expect(sharedOwnerNews({ key: k, members: [], removed: [] }, held)).toBe(true)
  })
})
