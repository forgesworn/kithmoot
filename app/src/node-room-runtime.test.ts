import { expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { localIdentity } from '../../src/identity.js'
import { memoryDeviceStore } from './device-store.js'
import { createBrowserNodeRoom } from './node-room-runtime.js'
import { NODE_ROOM_PREFIX, loadNodeRoom } from './node-rooms.js'

it('saves keeper custody and the recovery link before enrolment and retains them on a lost or refused response', async () => {
  const store = memoryDeviceStore(), owner = localIdentity(generateSecretKey()), at = 1_900_000_000
  const pair = { v: 1 as const, origin: 'https://node.example', serviceKey: getPublicKey(generateSecretKey()), owner: owner.pubkey }
  let room = '', prepared = false
  const fetcher = vi.fn(async () => {
    expect(prepared).toBe(true)
    const key = store.keys().find(key => key.startsWith(NODE_ROOM_PREFIX))!
    room = key.split('.').at(-1)!
    expect(loadNodeRoom(store, owner.pubkey, room, at)).toMatchObject({ phase: 'creating', participant: owner.pubkey })
    return new Response('{}', { status: 503 })
  }) as unknown as typeof fetch
  await expect(createBrowserNodeRoom(store, pair, owner, { now: () => at, fetcher, prepared: state => {
    expect(loadNodeRoom(store, owner.pubkey, state.node.room, at)?.secret).toEqual(state.secret); prepared = true
  } })).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(1)
  const held = loadNodeRoom(store, owner.pubkey, room, at)!
  expect(held.phase).toBe('creating'); expect(held.authoritySk).toHaveLength(32); expect(held.grant).toBeUndefined()
})
