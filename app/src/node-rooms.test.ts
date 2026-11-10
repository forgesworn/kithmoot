import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils'
import { signNodeRoom, readNodeRoom } from '@forgesworn/fold-kit/node-room'
import { buildGrant } from '../../src/group-grants.js'
import { pendingNodeRoomClose, prepareNodeRoomClose } from '../../src/node-room-close.js'
import { memoryDeviceStore } from './device-store.js'
import { deriveRoom } from '../../src/room.js'
import { localIdentity } from '../../src/identity.js'
import { createBrowserNodeRoom } from './node-room-runtime.js'
import { NODE_PAIR_PREFIX, NODE_DEVICE_PREFIX, NODE_ROOM_PREFIX, NODE_ACCESS_PREFIX, NODE_KEEPER_PREFIX, NODE_PENDING_CLOSE_PREFIX,
  loadPairedNode, storePairedNode, unpairNode, nodeDeviceKeyFor, loadNodeRoom, storeNodeRoom, nodeCloseStore,
  nodeCloseReferences, forgetNodeCloseReference, forgetNodeRoom, adoptSharedNodeAuthority, readNodeKeeperLists, type BrowserNodeRoom } from './node-rooms.js'
import { keepSharedOwner, loadSharedOwner } from './room-owner-share.js'

const NOW = 1_900_000_000
function fixture() {
  const store = memoryDeviceStore(), authoritySk = generateSecretKey(), participant = getPublicKey(generateSecretKey()), secret = generateSecretKey(), room = deriveRoom(secret).roomId
  const node = readNodeRoom(signNodeRoom({ authoritySk, room, serviceKey: getPublicKey(generateSecretKey()), origin: 'https://node.example', now: NOW }), NOW)!
  const deviceSk = nodeDeviceKeyFor(store, participant, room)
  const grant = buildGrant({ authoritySk, roomId: room, device: getPublicKey(deviceSk), server: 'node.example', scopes: ['turn', 'relay-read', 'relay-write'],
    grantId: '01'.repeat(16), createdAt: NOW, expiration: NOW + 30 * 86400 })
  const state: BrowserNodeRoom = { node, participant, secret, deviceSk, authoritySk, grant, phase: 'active', epochHint: 0, startsAt: NOW, name: 'Room' }
  const pair = { v: 1 as const, origin: node.origin, serviceKey: node.serviceKey, owner: participant }
  return { store, participant, secret, authoritySk, room, node, deviceSk, grant, state, pair }
}
describe('browser node custody', () => {
  it('gives an owner key shared by another of the account\'s devices to the moved room it opens, with its members and removals', () => {
    const f = fixture(), member = getPublicKey(generateSecretKey()), removed = getPublicKey(generateSecretKey())
    storeNodeRoom(f.store, { ...f.state, authoritySk: undefined }, NOW)
    expect(adoptSharedNodeAuthority(f.store, f.participant, NOW)).toEqual([])
    keepSharedOwner(f.store, f.participant, f.room, { key: bytesToHex(f.authoritySk), members: [member, removed], removed: [removed] })
    expect(adoptSharedNodeAuthority(f.store, f.participant, NOW)).toEqual([f.room])
    expect(loadNodeRoom(f.store, f.participant, f.room, NOW)?.authoritySk).toEqual(f.authoritySk)
    expect(readNodeKeeperLists(f.store, f.participant, f.room)).toEqual({ members: [f.participant, member], removed: [removed] })
    // Kept once: a second pass changes nothing.
    expect(adoptSharedNodeAuthority(f.store, f.participant, NOW)).toEqual([])
    forgetNodeRoom(f.store, f.room)
    expect(loadSharedOwner(f.store, f.participant, f.room)).toBeUndefined()
  })
  it('never gives a moved room a shared key that is not its owner', () => {
    const f = fixture()
    storeNodeRoom(f.store, { ...f.state, authoritySk: undefined }, NOW)
    keepSharedOwner(f.store, f.participant, f.room, { key: bytesToHex(generateSecretKey()), members: [], removed: [] })
    expect(adoptSharedNodeAuthority(f.store, f.participant, NOW)).toEqual([])
    expect(loadNodeRoom(f.store, f.participant, f.room, NOW)?.authoritySk).toBeUndefined()
    expect(readNodeKeeperLists(f.store, f.participant, f.room)).toBeUndefined()
  })
  it('retains custom node TURN ports through account restore and signs them into a recoverable new room', async () => {
    const f = fixture(), owner = localIdentity(generateSecretKey()), pair = { ...f.pair, owner: owner.pubkey, turnPorts: { udpTcp: 34790, tls: 53499 } }
    storePairedNode(f.store, owner.pubkey, pair)
    const restored = loadPairedNode(f.store, owner.pubkey)!
    expect(restored).toEqual(pair)
    let prepared: BrowserNodeRoom | undefined
    await expect(createBrowserNodeRoom(f.store, restored, owner, { now: () => NOW, allowed: () => false,
      prepared: state => { prepared = state } })).rejects.toThrow()
    expect(prepared?.node.turnPorts).toEqual(pair.turnPorts)
    expect(loadNodeRoom(f.store, owner.pubkey, prepared!.node.room, NOW)?.node.turnPorts).toEqual(pair.turnPorts)
    expect(prepared?.phase).toBe('creating')
  })
  it('refuses damaged saved TURN port profiles instead of restoring them as default ports', () => {
    const f = fixture(), key = NODE_PAIR_PREFIX + f.participant
    for (const turnPorts of [null, { udpTcp: 443, tls: 53499 }, { udpTcp: 34790, tls: 34790 }, { udpTcp: 34790, tls: 53499, extra: 1 }]) {
      const raw = JSON.stringify({ ...f.pair, turnPorts }); f.store.set(key, raw)
      expect(loadPairedNode(f.store, f.participant)).toBeUndefined()
      expect(f.store.get(key)).toBe(raw)
    }
  })
  it('stores only public pairing fields for the matching account and unpairs without changing hosted rooms', () => {
    const f = fixture(), other = getPublicKey(generateSecretKey())
    const withCode = { ...f.pair, code: 'pairing code must never be saved' }
    storePairedNode(f.store, f.participant, withCode); storeNodeRoom(f.store, f.state, NOW)
    expect(loadPairedNode(f.store, f.participant)).toEqual(f.pair)
    expect(loadPairedNode(f.store, other)).toBeUndefined()
    expect(f.store.keys().map(key => f.store.get(key)).join('')).not.toContain(withCode.code)
    expect(() => storePairedNode(f.store, other, f.pair)).toThrow('another account')
    unpairNode(f.store, f.participant)
    expect(loadPairedNode(f.store, f.participant)).toBeUndefined(); expect(loadNodeRoom(f.store, f.participant, f.room, NOW)?.secret).toEqual(f.secret)
  })
  it('keeps different room device keys for different accounts and refuses a damaged key without replacing it', () => {
    const f = fixture(), other = getPublicKey(generateSecretKey())
    expect(nodeDeviceKeyFor(f.store, f.participant, f.room)).toEqual(f.deviceSk)
    expect(nodeDeviceKeyFor(f.store, other, f.room)).not.toEqual(f.deviceSk)
    const key = NODE_DEVICE_PREFIX + f.participant + '.' + f.room
    f.store.set(key, '00'.repeat(32))
    expect(() => nodeDeviceKeyFor(f.store, f.participant, f.room)).toThrow('cannot be read')
    expect(f.store.get(key)).toBe('00'.repeat(32))
  })
  it('persists keeper creation before a grant exists, but never treats it as active membership', () => {
    const f = fixture(), creating: BrowserNodeRoom = { ...f.state, phase: 'creating', grant: undefined }
    storeNodeRoom(f.store, creating, NOW)
    expect(loadNodeRoom(f.store, f.participant, f.room, NOW)).toMatchObject({ phase: 'creating' })
    expect(loadNodeRoom(f.store, f.participant, f.room, NOW)?.grant).toBeUndefined()
    expect(() => storeNodeRoom(f.store, { ...creating, authoritySk: undefined }, NOW)).toThrow('could not be saved')
    expect(() => storeNodeRoom(f.store, { ...creating, phase: 'active' }, NOW)).toThrow('could not be saved')
    storeNodeRoom(f.store, f.state, NOW)
    expect(loadNodeRoom(f.store, f.participant, f.room, NOW)).toMatchObject({ phase: 'active', node: { room: f.room } })
  })
  it('revalidates room secrets, authority keys, device grants and descriptor signatures on restore', () => {
    const f = fixture(); storeNodeRoom(f.store, f.state, NOW)
    const key = NODE_ROOM_PREFIX + f.participant + '.' + f.room, saved = JSON.parse(f.store.get(key)!)
    expect(loadNodeRoom(f.store, getPublicKey(generateSecretKey()), f.room, NOW)).toBeUndefined()
    for (const change of [{ secret: bytesToHex(generateSecretKey()) }, { authoritySk: bytesToHex(generateSecretKey()) },
      { node: { ...saved.node, content: saved.node.content + 'x' } }, { grant: finalizeEvent({ ...f.grant, created_at: NOW + 1 }, generateSecretKey()) }]) {
      f.store.set(key, JSON.stringify({ ...saved, ...change }))
      expect(loadNodeRoom(f.store, f.participant, f.room, NOW)).toBeUndefined()
    }
    f.store.set(key, JSON.stringify(saved)); expect(loadNodeRoom(f.store, f.participant, f.room, NOW)?.secret).toEqual(f.secret)
  })
  it('separates the public completion reference from room-private pending closure and wipes every local account copy', async () => {
    const f = fixture(), other = getPublicKey(generateSecretKey()); storePairedNode(f.store, f.participant, f.pair); storeNodeRoom(f.store, f.state, NOW)
    nodeDeviceKeyFor(f.store, other, f.room)
    const instruction = prepareNodeRoomClose({ node: f.node, authoritySk: f.authoritySk, roomSecret: f.secret, current: { epoch: 0, secret: f.secret }, now: NOW })
    const pending = pendingNodeRoomClose(f.pair, f.node, instruction, NOW), store = nodeCloseStore(f.store)
    await store.stage(pending)
    for (const prefix of [NODE_ACCESS_PREFIX, NODE_KEEPER_PREFIX]) f.store.set(prefix + f.participant + '.' + f.room, 'private room state')
    expect(f.store.keys().some(key => key.startsWith(NODE_PENDING_CLOSE_PREFIX))).toBe(true)
    forgetNodeRoom(f.store, f.room)
    expect(f.store.keys().some(key => key.endsWith('.' + f.room))).toBe(false)
    expect(loadPairedNode(f.store, f.participant)).toEqual(f.pair)
    expect(nodeCloseReferences(f.store, f.participant)).toEqual([pending.reference])
    expect(nodeCloseReferences(f.store, other)).toEqual([])
    expect(JSON.stringify(nodeCloseReferences(f.store, f.participant))).not.toContain(f.room)
    forgetNodeCloseReference(f.store, f.participant, instruction.operation)
    expect(nodeCloseReferences(f.store, f.participant)).toEqual([])
  })
})
