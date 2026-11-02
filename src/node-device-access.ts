import { readNodeClosure, readNodeRoom, verifyNodeRoomGrant, type NodeRoomRecord } from '@forgesworn/fold-kit/node-room'
import type { Event } from 'nostr-tools/pure'
import type { ParticipantIdentity } from './identity.js'
import { GrantReceiver, parseGroupEvent, type GrantReceiverSnapshot, type ParsedGrant } from './group-grants.js'
import { KithmootNodeError, queryNodeAccess, type NodeClientOptions, type NodeDeviceAccess } from './kithmoot-node.js'

export interface NodeDeviceSnapshot { v: 1; descriptor: string; device: string; grants: GrantReceiverSnapshot; closure?: Event }
export interface NodeDeviceStore {
  load(): Promise<NodeDeviceSnapshot | undefined>
  /** Must commit atomically before resolving. A rejected save blocks access. */
  save(snapshot: NodeDeviceSnapshot): Promise<void>
}
export interface NodeDeviceAccessController {
  /** Suitable for both the room transport and the managed call factory. */
  allowed(): boolean
  refresh(): Promise<NodeDeviceAccess>
  /** Verified control-channel grants, resets and explicit keeper closures. */
  observe(event: unknown): Promise<boolean>
  close(): void
}

/** Restores signed ordering before making any request. An old server response
 * cannot revive a revoked grant or bypass a reset. Only a verified explicit
 * keeper closure invokes onClosure; a reset, expiry or HTTP refusal does not. */
export async function openNodeDeviceAccess(record: NodeRoomRecord, device: ParticipantIdentity, initialGrant: Event,
  store: NodeDeviceStore, options: NodeClientOptions & { onClosure?: (closure: Event) => Promise<void> | void } = {}): Promise<NodeDeviceAccessController> {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const node = readNodeRoom(record.event, Math.min(now(), record.endsAt === undefined ? now() : record.endsAt - 1), record.authority)
  const initial = parseGroupEvent(initialGrant)
  if (!node || !initial.ok || initial.parsed.type !== 'grant'
    || !verifyNodeRoomGrant(initialGrant, node, device.pubkey, Math.min(now(), initial.parsed.expiration - 1))) throw new KithmootNodeError(0, 'invalid')
  const initialId = initial.parsed.grantId
  const binding = { authority: node.authority, roomId: node.room, device: device.pubkey }, host = new URL(node.origin).hostname
  let snapshot: NodeDeviceSnapshot | undefined
  try { snapshot = await store.load() } catch { throw new KithmootNodeError(0, 'unavailable') }
  if (snapshot === undefined && initial.parsed.expiration <= now()) throw new KithmootNodeError(0, 'expired')
  if (snapshot !== undefined && (snapshot.v !== 1 || snapshot.descriptor !== node.event.id || snapshot.device !== device.pubkey
    || !snapshot.grants || !Array.isArray(snapshot.grants.events) || snapshot.grants.events.length > 4608
    || !Array.isArray(snapshot.grants.acknowledged) || snapshot.grants.acknowledged.length > 4608)) throw new KithmootNodeError(0, 'invalid')
  const receiver = snapshot ? GrantReceiver.restore(binding, snapshot.grants) : new GrantReceiver(binding)
  let closure = snapshot?.closure, stopped = false, failed = false, access: NodeDeviceAccess | undefined
  let queue: Promise<unknown> = Promise.resolve()
  const controller = new AbortController()
  const live = () => !stopped && !failed && !closure && !options.signal?.aborted && (options.allowed?.() ?? true)
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    const task = queue.then(run); queue = task.catch(() => {}); return task
  }
  const save = async () => {
    try { await store.save(structuredClone({ v: 1, descriptor: node.event.id, device: device.pubkey, grants: receiver.snapshot(), ...(closure ? { closure } : {}) })) }
    catch { failed = true; access = undefined; throw new KithmootNodeError(0, 'unavailable') }
  }
  const allowed = () => live() && access?.state === 'active' && access.offer.expiresAt > now()
    && receiver.grantsFor(host, now()).some(g => g.event.id === (access as Extract<NodeDeviceAccess, { state: 'active' }>).grant.event.id)
  const keep = async (raw: unknown): Promise<boolean> => {
    if (stopped || failed || options.signal?.aborted || options.allowed?.() === false) throw new KithmootNodeError(403, 'refused')
    if (readNodeClosure(raw, node, now())) {
      closure = structuredClone(raw as Event); access = { state: 'closed', closure }
      await save(); await options.onClosure?.(closure); return true
    }
    const parsed = parseGroupEvent(raw, { keepers: [node.authority], servers: [host] })
    if (!parsed.ok || parsed.parsed.roomId !== node.room || closure) return false
    if (!receiver.offer(structuredClone(raw), now())) return false
    // The in-memory receiver blocks first; a failed save cannot leave a
    // connection using the grant which the just-read revocation ended.
    await save(); return true
  }
  if (closure) {
    if (!readNodeClosure(closure, node, Math.min(now(), closure.created_at + 30 * 86400 - 1))) throw new KithmootNodeError(0, 'invalid')
    access = { state: 'closed', closure }; await options.onClosure?.(closure)
  } else {
    // Restored terminal revocations remain in their own map even when an
    // admission answer supplies a later-looking active copy of that id.
    receiver.offer(structuredClone(initialGrant), now()); await save()
  }
  return {
    allowed,
    observe: raw => enqueue(() => keep(raw)),
    refresh: () => enqueue(async () => {
      if (closure) return { state: 'closed', closure }
      if (!live()) throw new KithmootNodeError(403, 'refused')
      if (node.endsAt !== undefined && node.endsAt <= now()) { access = { state: 'ended' }; return access }
      // Even an expired id may have a renewal waiting on the node. Its old
      // signed event is a query handle, never an authorisation to send.
      const own = receiver.snapshot().events.map(e => parseGroupEvent(e)).flatMap(p => p.ok && p.parsed.type === 'grant'
        && p.parsed.device === device.pubkey && p.parsed.server === host ? [p.parsed] : []).sort((a, b) => b.createdAt - a.createdAt)
      const grant: ParsedGrant | undefined = own[0]
      let next: NodeDeviceAccess
      // The receiver drops expired grants after a week. The original id
      // remains a query handle for a later explicit closure proof, without
      // reviving access or retaining any expired TURN credential.
      try { next = await queryNodeAccess(node, grant?.grantId ?? initialId, device, { ...options,
        allowed: live, signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal }) }
      catch (error) {
        if (error instanceof KithmootNodeError && error.reason !== 'unavailable') access = undefined
        throw error
      }
      if (!live()) throw new KithmootNodeError(403, 'refused')
      if (next.state === 'closed') { await keep(next.closure); return next }
      if (next.state === 'active' || next.state === 'removed') await keep(next.grant.event)
      else if (next.state === 'reset') await keep(next.reset.event)
      if (next.state === 'active' && !receiver.grantsFor(host, now()).some(g => g.event.id === next.grant.event.id)) {
        access = undefined; throw new KithmootNodeError(403, 'refused')
      }
      access = next; return next
    }),
    close() { stopped = true; access = undefined; controller.abort() },
  }
}
