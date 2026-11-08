import { getPublicKey, type Event } from 'nostr-tools/pure'
import { readNodeRoom, signNodeRoom, verifyNodeRoomGrant, type NodeRoomRecord } from '@forgesworn/fold-kit/node-room'
import { deriveRoom } from '../../src/room.js'
import type { RoomPolicy } from '../../src/types.js'
import type { ParticipantIdentity } from '../../src/identity.js'
import { enrolNodeRoom, type NodeClientOptions, type PairedKithmootNode } from '../../src/kithmoot-node.js'
import { openNodeKeeperAdmissions } from '../../src/node-admission.js'
import type { DeviceStore } from './device-store.js'
import { adoptExistingNodeDeviceKey, loadNodeRoom, nodeKeeperStore, storeNodeRoom, type BrowserNodeRoom } from './node-rooms.js'

export interface ExistingBrowserRoom {
  authority: string
  authoritySk?: Uint8Array
  secret: Uint8Array
  deviceSk: Uint8Array
  credential: Event
  participant: string
  epoch: number
  endsAt?: number
  destruct: boolean
  policy?: RoomPolicy
  name?: string
  startsAt: number
  link: string
  devices: { device: string; participant: string; credential: Event }[]
  removed: readonly string[]
}
const samePolicy = (a?: RoomPolicy, b?: RoomPolicy) => JSON.stringify(a) === JSON.stringify(b)
function matchesSource(node: NodeRoomRecord, source: ExistingBrowserRoom): boolean {
  const derived = deriveRoom(source.secret)
  try { return !!node.existing && node.room === derived.roomId && node.authority === source.authority
    && node.endsAt === source.endsAt && node.existing.destruct === source.destruct && samePolicy(node.existing.policy, source.policy) }
  finally { derived.roomKey.fill(0) }
}

/** Stage the destination and admitted devices without changing any local
 * room setting. The caller publishes the signed destination before activation.
 * Other devices follow independently; no all-device cutover barrier is needed. */
export async function prepareExistingBrowserNodeRoom(store: DeviceStore, pair: PairedKithmootNode, owner: ParticipantIdentity,
  source: ExistingBrowserRoom, options: NodeClientOptions = {}): Promise<{ state: BrowserNodeRoom; grants: Event[] }> {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000)), at = now()
  if (!source.authoritySk || getPublicKey(source.authoritySk) !== source.authority || source.participant !== owner.pubkey) throw Error('The original room owner must move this room')
  if (options.allowed?.() === false || options.signal?.aborted) throw Error('The room changed before moving')
  const derived = deriveRoom(source.secret), room = derived.roomId; derived.roomKey.fill(0)
  let state = loadNodeRoom(store, source.participant, room, at)
  if (state && (!matchesSource(state.node, source) || state.node.origin !== pair.origin || state.node.serviceKey !== pair.serviceKey)) throw Error('A different destination is already saved for this room')
  if (!state) {
    const node = readNodeRoom(signNodeRoom({ authoritySk: source.authoritySk, room, origin: pair.origin, serviceKey: pair.serviceKey,
      turnPorts: pair.turnPorts, endsAt: source.endsAt, existing: { destruct: source.destruct, ...(source.policy ? { policy: source.policy } : {}) }, now: at }), at)!
    adoptExistingNodeDeviceKey(store, node, source.participant, source.deviceSk)
    state = { node, participant: source.participant, secret: source.secret.slice(), deviceSk: source.deviceSk.slice(), authoritySk: source.authoritySk.slice(),
      phase: 'creating', epochHint: source.epoch, startsAt: source.startsAt, name: source.name, source: { link: source.link, activated: false } }
    storeNodeRoom(store, state, at)
  }
  const destination = state
  destination.epochHint = source.epoch
  await enrolNodeRoom(pair, destination.node, owner, options)
  const approved = new Map(source.devices.map(device => [device.device, device.participant]))
  approved.set(getPublicKey(source.deviceSk), source.participant)
  const removed = new Set(source.removed)
  const members = [...new Set([source.participant, ...(source.policy?.members ?? []), ...approved.values()])].filter(member => !removed.has(member))
  const grants = new Map<string, Event>()
  const keeper = await openNodeKeeperAdmissions({ ...options, node: destination.node, authoritySk: source.authoritySk, roomSecret: source.secret,
    keeperParticipant: source.participant, initialMembers: members, initialRemoved: source.removed, epochHint: () => source.epoch,
    acceptsExistingDevice: (device, participant) => approved.get(device) === participant && !removed.has(participant),
    store: nodeKeeperStore(store, source.participant, room), onGrant: async event => { grants.set(event.id, event) } })
  try {
    for (const member of source.removed) if (member !== source.participant) await keeper.remove(member)
    destination.grant = await keeper.authoriseKeeperDevice(source.credential)
    for (const device of source.devices) if (!removed.has(device.participant) && device.device !== getPublicKey(source.deviceSk)) {
      await keeper.authoriseExistingDevice(device.credential)
    }
    if (options.allowed?.() === false || options.signal?.aborted) throw Error('The room changed while preparing its destination')
    destination.phase = 'active'; storeNodeRoom(store, destination, now())
    return { state: destination, grants: [...grants.values()] }
  } finally { keeper.close() }
}

/** Only a matching signed destination and this exact device's live grant may
 * activate the node route. Original identity, keys, policy and local history
 * stay in their existing stores. */
export function acceptExistingBrowserNodeRoom(store: DeviceStore, record: NodeRoomRecord, source: ExistingBrowserRoom, grant: Event, now: number): BrowserNodeRoom {
  if (!matchesSource(record, source) || !verifyNodeRoomGrant(grant, record, getPublicKey(source.deviceSk), now)) throw Error('This node destination is not authorised for the existing room')
  adoptExistingNodeDeviceKey(store, record, source.participant, source.deviceSk)
  const state: BrowserNodeRoom = { node: record, participant: source.participant, secret: source.secret.slice(), deviceSk: source.deviceSk.slice(),
    ...(source.authoritySk && getPublicKey(source.authoritySk) === record.authority ? { authoritySk: source.authoritySk.slice() } : {}),
    grant, phase: 'active', epochHint: source.epoch, startsAt: source.startsAt, name: source.name, source: { link: source.link, activated: true } }
  storeNodeRoom(store, state, now)
  return state
}
