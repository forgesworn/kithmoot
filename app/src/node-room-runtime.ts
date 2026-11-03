import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { signNodeRoom, readNodeRoom, type NodeRoomRecord, type NodeJoinRequest } from '@forgesworn/fold-kit/node-room'
import { deriveRoom } from '../../src/room.js'
import { localIdentity, type ParticipantIdentity } from '../../src/identity.js'
import { createDeviceCredential } from '../../src/credential.js'
import { hostRoomEpoch } from '../../src/epoch.js'
import type { RoomSession } from '../../src/session.js'
import { CONTROL_CHANNEL, encodeControl } from '../../src/control.js'
import { enrolNodeRoom, nodeRoomTransport, nodeKeeperInbox, nodeCallFactory, type NodeClientOptions, type PairedKithmootNode, type NodeDeviceAccess } from '../../src/kithmoot-node.js'
import { openNodeDeviceAccess, type NodeDeviceAccessController } from '../../src/node-device-access.js'
import { beginNodeJoin, openNodeKeeperAdmissions, type NodeKeeperAdmissions, type NodeKeeperSnapshot } from '../../src/node-admission.js'
import { prepareNodeRoomClose, pendingNodeRoomClose, submitPendingNodeRoomClose } from '../../src/node-room-close.js'
import { nodeDeviceKeyFor, storeNodeRoom, nodeKeeperStore, nodeAccessStore, nodeCloseStore, loadPendingNodeClose, type BrowserNodeRoom } from './node-rooms.js'
import type { DeviceStore } from './device-store.js'
import { watchNodeNetwork } from './node-network-recovery.js'

const now = () => Math.floor(Date.now() / 1000)
export async function createBrowserNodeRoom(store: DeviceStore, pair: PairedKithmootNode, owner: ParticipantIdentity,
  options: NodeClientOptions & { endsAt?: number; name?: string; prepared?: (state: BrowserNodeRoom) => void } = {}): Promise<BrowserNodeRoom> {
  const at = (options.now ?? now)(), secret = generateSecretKey(), authoritySk = generateSecretKey()
  const room = deriveRoom(secret).roomId, deviceSk = nodeDeviceKeyFor(store, owner.pubkey, room)
  const node = readNodeRoom(signNodeRoom({ authoritySk, room, serviceKey: pair.serviceKey, origin: pair.origin, turnPorts: pair.turnPorts, now: at, endsAt: options.endsAt }), at)!
  const state: BrowserNodeRoom = { node, participant: owner.pubkey, secret, deviceSk, authoritySk, phase: 'creating', epochHint: 0, startsAt: at, name: options.name }
  // Persist root custody BEFORE anything can enrol the room remotely.
  storeNodeRoom(store, state, at)
  options.prepared?.(state)
  await resumeBrowserNodeCreation(store, state, pair, owner, options)
  return state
}
export async function resumeBrowserNodeCreation(store: DeviceStore, state: BrowserNodeRoom, pair: PairedKithmootNode,
  owner: ParticipantIdentity, options: NodeClientOptions = {}): Promise<void> {
  if (!state.authoritySk || state.participant !== owner.pubkey) throw Error('Reconnect the account that created this room.')
  const at = (options.now ?? now)()
  await enrolNodeRoom(pair, state.node, owner, options)
  const keeper = await openNodeKeeperAdmissions({ ...options, node: state.node, authoritySk: state.authoritySk, roomSecret: state.secret,
    keeperParticipant: state.participant, epochHint: () => state.epochHint, store: nodeKeeperStore(store, state.participant, state.node.room) })
  try {
    const credential = await createDeviceCredential({ identity: owner, devicePubkey: getPublicKey(state.deviceSk), roomId: state.node.room,
      expiresAt: Math.min(at + 86400, state.node.endsAt ?? Infinity) })
    state.grant = await keeper.authoriseKeeperDevice(credential); state.phase = 'active'; storeNodeRoom(store, state, at)
  } finally { keeper.close() }
}
export async function askBrowserNodeRoom(store: DeviceStore, node: NodeRoomRecord, participant: ParticipantIdentity,
  options: NodeClientOptions & { name?: string } = {}): Promise<BrowserNodeRoom> {
  const at = (options.now ?? now)(), deviceSk = nodeDeviceKeyFor(store, participant.pubkey, node.room)
  const credential = await createDeviceCredential({ identity: participant, devicePubkey: getPublicKey(deviceSk), roomId: node.room,
    expiresAt: Math.min(at + 86400, node.endsAt ?? Infinity) })
  if (options.signal?.aborted || options.allowed?.() === false) throw Error('The room changed before asking to join.')
  const attempt = beginNodeJoin({ node, deviceSk, credential, name: options.name, now: options.now, allowed: options.allowed, signal: options.signal })
  const answer = await attempt.result
  if (answer === 'denied') throw Error('This room could not be joined.')
  if (options.signal?.aborted || options.allowed?.() === false) { answer.secret.fill(0); throw Error('The room changed before admission.') }
  const state: BrowserNodeRoom = { node, participant: participant.pubkey, deviceSk, secret: answer.secret, grant: answer.grant,
    phase: 'active', epochHint: answer.epochHint, startsAt: at }
  storeNodeRoom(store, state); return state
}

/** All node-only resources belong to one session, including a docked call.
 * None uses account relay pools, public ICE resolution or peer forwarding. */
export async function openBrowserNodeRoom(store: DeviceStore, state: BrowserNodeRoom, options: NodeClientOptions & {
  ask: (request: NodeJoinRequest) => Promise<boolean>
  settled: (request: NodeJoinRequest, sent: boolean) => void
  blocked: (participant: string) => boolean
  withdrawn: (reason: 'removed' | 'closed' | 'ended' | 'reset') => void
  unavailable: () => void
  available?: () => void
}) {
  if (state.phase !== 'active' || !state.grant) throw Error('Finish creating this room before entering.')
  const device = localIdentity(state.deviceSk), controller = new AbortController()
  let stopped = false, s: RoomSession | undefined, keeper: NodeKeeperAdmissions | undefined, journal: NodeKeeperSnapshot | undefined
  let access: NodeDeviceAccessController | undefined, timer: ReturnType<typeof setInterval> | undefined
  let inbox: ReturnType<typeof nodeKeeperInbox> | undefined, desk: ReturnType<typeof hostRoomEpoch> | undefined
  let calls: Awaited<ReturnType<typeof nodeCallFactory>> | undefined, refreshing = false
  let connectionLost = false
  const unavailable = () => { connectionLost = true; options.unavailable() }
  let reconnecting: Promise<void> | undefined
  const network = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { connection?: EventTarget & { type?: string } }).connection
  const connectivity = typeof window === 'undefined' ? undefined : window
  let unwatchNetwork: (() => void) | undefined
  const live = () => !stopped && !options.signal?.aborted && (options.allowed?.() ?? true)
  const requestOptions = { ...options, signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal, allowed: live }
  const notify = (value: NodeDeviceAccess) => {
    if (value.state === 'closed' || value.state === 'removed' || value.state === 'ended' || value.state === 'reset') options.withdrawn(value.state)
    return value
  }
  const refresh = async () => {
    const next = notify(await access!.refresh())
    if (next.state === 'active' && connectionLost) { connectionLost = false; options.available?.() }
    return next
  }
  access = await openNodeDeviceAccess(state.node, device, state.grant, nodeAccessStore(store, state.participant, state.node.room), requestOptions)
  const first = await refresh().catch(error => { access!.close(); throw error })
  if (first.state !== 'active') { access.close(); throw Error('This device no longer has access to the room.') }
  const pool = nodeRoomTransport(state.node, device, 'room', { allowed: () => live() && access!.allowed() })
  const root = deriveRoom(state.secret)
  const close = () => {
    if (stopped) return
    stopped = true; controller.abort(); clearInterval(timer)
    unwatchNetwork?.()
    desk?.close(); inbox?.close(); keeper?.close(); calls?.close(); access?.close(); pool.close(); root.roomKey.fill(0)
  }
  const reconnect = () => {
    if (!live() || reconnecting) return
    reconnecting = (async () => {
      await refresh()
      if (!live() || !access!.allowed()) return
      await keeper?.retry(); await keeper?.renew()
      pool.reconnect(); inbox?.reconnect()
      await calls?.reconnect()
    })().catch(unavailable).finally(() => { reconnecting = undefined })
  }
  try {
    calls = await nodeCallFactory(state.node, device, refresh, { ...requestOptions, allowed: () => live() && access!.allowed(), onUnavailable: unavailable })
    if (state.authoritySk) {
      const backing = nodeKeeperStore(store, state.participant, state.node.room)
      keeper = await openNodeKeeperAdmissions({ ...requestOptions, node: state.node, authoritySk: state.authoritySk, roomSecret: state.secret,
        keeperParticipant: state.participant, epochHint: () => s?.epoch ?? state.epochHint,
        store: { async load() { journal = await backing.load(); return journal }, async save(value) { await backing.save(value); journal = value } },
        onGrant: async event => { if (s) await s.channel(CONTROL_CHANNEL).send(encodeControl({ op: 'node-grant', event })) } })
      await keeper.retry(); await keeper.renew()
      inbox = nodeKeeperInbox(state.node, localIdentity(state.authoritySk), { allowed: live })
      const seen = new Set<string>()
      inbox.subscribe([{ kinds: [1059], '#p': [state.node.authority] }], event => {
        if (!live() || seen.has(event.id)) return
        const inspected = keeper!.inspect(event); if (!inspected || options.blocked(inspected.request.participant)) return
        seen.add(event.id); if (seen.size > 4096) seen.delete(seen.values().next().value!)
        void (async () => {
          const approved = inspected.known || await options.ask(inspected.request)
          // Decline is deliberately silent. No signed denial or room key
          // leaves the keeper for someone it has not admitted.
          if (!approved || !live() || options.blocked(inspected.request.participant)) return
          try {
            const answer = await keeper!.admit(event, true)
            s?.letIn(inspected.request.participant); await inbox!.publish(answer); options.settled(inspected.request, true)
          } catch (error) { options.settled(inspected.request, false); throw error }
        })().catch(unavailable)
      })
    }
    timer = setInterval(() => {
      if (!live()) { close(); return }
      if (refreshing) return
      refreshing = true
      void refresh().then(() => keeper?.renew()).catch(unavailable).finally(() => { refreshing = false })
    }, 5000)
    unwatchNetwork = watchNodeNetwork(connectivity, network, reconnect)
    return {
      state, pool, factory: calls.factory, allowed: () => live() && access!.allowed(), close,
      observe: (event: unknown) => access!.observe(event),
      attach(session: RoomSession) {
        s = session
        if (!state.authoritySk) return
        desk = hostRoomEpoch({ transport: pool, roomId: state.node.room, authoritySk: state.authoritySk, roomKey: root.roomKey,
          current: () => session.currentEpoch(), removed: () => new Set(journal?.removed ?? []),
          known: person => journal?.members.includes(person) === true && !journal.removed.includes(person),
          members: () => journal?.members ?? [state.participant], closed: () => stopped,
          expiresAt: () => Math.min(now() + 30 * 86400, state.node.endsAt ?? Infinity) })
        session.rememberMembers(journal?.members ?? [state.participant]); session.forgetParticipants(journal?.removed ?? [])
      },
      async remove(participant: string) {
        if (!keeper || !s || !state.authoritySk) throw Error('Only the person managing this room can remove people.')
        await keeper.remove(participant)
        await s.rekey({ authoritySk: state.authoritySk, removed: [participant], by: state.participant })
      },
      async end(pair: PairedKithmootNode) {
        if (!keeper || !s || !state.authoritySk) throw Error('Only the person managing this room can close it.')
        const held = loadPendingNodeClose(store, state.participant, state.node.room)
        const current = s.currentEpoch()
        try {
          const pending = held ?? pendingNodeRoomClose(pair, state.node, prepareNodeRoomClose({ node: state.node, authoritySk: state.authoritySk,
            roomSecret: state.secret, current, now: now(), resetFloor: keeper.close() }), now())
          return await submitPendingNodeRoomClose(pending, localIdentity(state.authoritySk), nodeCloseStore(store), requestOptions)
        } finally { current.secret.fill(0) }
      },
    }
  } catch (error) { close(); throw error }
}
export type BrowserNodeRuntime = Awaited<ReturnType<typeof openBrowserNodeRoom>>
