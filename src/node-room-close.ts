import { bytesToHex, randomBytes } from '@noble/hashes/utils'
import { getPublicKey, type Event } from 'nostr-tools/pure'
import { readNodeRoom, readNodeClosure, signNodeClosure, signNodeRetirement, type NodeRoomRecord } from '@forgesworn/fold-kit/node-room'
import { deriveRoom } from './room.js'
import { deriveEpoch, encodeRekeyEvent, generateEpochSecret, MAX_EPOCH, type RoomEpoch, type EpochKeys } from './epoch.js'
import { buildReset, parseGroupEvent, type GroupEvent } from './group-grants.js'
import type { ParticipantIdentity } from './identity.js'
import { verifyEventUncached } from './verify.js'
import { closeNodeRoom, KithmootNodeError, type NodeClientOptions, type NodeCloseInstruction, type NodeCloseStatus, type PairedKithmootNode } from './kithmoot-node.js'

export interface NodeCloseReference { v: 1; node: PairedKithmootNode; operation: string }
export interface PendingNodeRoomClose { v: 1; reference: NodeCloseReference; descriptor: Event; instruction: NodeCloseInstruction }
export interface NodeRoomCloseStore {
  /** Persist the public reference separately from room state, and the exact
   * signed request inside the room's self-destruct boundary, before resolving.
   * On restart return that same pending request for retry, never re-sign it. */
  stage(pending: PendingNodeRoomClose): Promise<void>
  /** Remove the descriptor and pending request, keeping only this reference.
   * Also call this from verified self-destruct when the HTTP ACK was lost. */
  forgetRoom(reference: NodeCloseReference): Promise<void>
}

/** Prepares ciphertext and signatures without publishing, changing epoch or
 * retaining a new room secret. Stop the keeper grant desk first and pass its
 * latest signed second as resetFloor so the reset covers every issued grant. */
export function prepareNodeRoomClose(opts: { node: NodeRoomRecord; authoritySk: Uint8Array; roomSecret: Uint8Array; current: RoomEpoch;
  now: number; resetFloor?: number; operation?: string; drainSeconds?: number }): NodeCloseInstruction {
  const node = readNodeRoom(opts.node.event, opts.now, getPublicKey(opts.authoritySk))
  const drain = opts.drainSeconds ?? 5, resetAt = Math.max(opts.now, opts.resetFloor ?? opts.now)
  if (!node || !Number.isSafeInteger(opts.now) || !Number.isSafeInteger(drain) || drain < 0 || drain > 120
    || !Number.isSafeInteger(resetAt) || resetAt > opts.now + 30 || !Number.isSafeInteger(opts.current.epoch)
    || opts.current.epoch < 0 || opts.current.epoch >= MAX_EPOCH) throw new KithmootNodeError(0, 'invalid')
  const root = deriveRoom(opts.roomSecret)
  let current: EpochKeys | undefined, nextSecret: Uint8Array | undefined
  try {
    current = deriveEpoch(opts.current); nextSecret = generateEpochSecret()
    if (root.roomId !== node.room) throw new KithmootNodeError(0, 'invalid')
    const operation = opts.operation ?? bytesToHex(randomBytes(16)), expiration = Math.min(opts.now + 30 * 86400, node.endsAt ?? Infinity)
    if (!/^[a-f0-9]{32}$/.test(operation)) throw new KithmootNodeError(0, 'invalid')
    const deadline = Math.min(opts.now + drain, expiration - 1)
    if (deadline < opts.now) throw new KithmootNodeError(0, 'expired')
    const retirement = signNodeRetirement({ node, authoritySk: opts.authoritySk, roomSecret: opts.roomSecret, operation, now: opts.now })
    const rekey = encodeRekeyEvent({ roomId: node.room, authoritySk: opts.authoritySk, current,
      next: { epoch: current.epoch + 1, secret: nextSecret }, recipients: [], removed: [], members: [],
      closed: true, destruct: true, commit: true, now: opts.now, expiresAt: expiration })
    return { operation, deadline, reset: buildReset({ authoritySk: opts.authoritySk, roomId: node.room, server: new URL(node.origin).hostname, createdAt: resetAt }),
      closure: signNodeClosure({ node, authoritySk: opts.authoritySk, operation, now: opts.now }), events: [retirement, rekey] }
  } finally { root.roomKey.fill(0); current?.key.fill(0); nextSecret?.fill(0) }
}

function signedEventOnly(event: Event): Event {
  return { id: event.id, pubkey: event.pubkey, sig: event.sig, kind: event.kind, created_at: event.created_at, content: event.content,
    tags: event.tags.map(tag => [...tag]) }
}

/** Snapshots a request for durable storage. It contains signed ciphertext,
 * no authority key, traffic key, current epoch secret or member list. */
export function pendingNodeRoomClose(pair: PairedKithmootNode, record: NodeRoomRecord, instruction: NodeCloseInstruction, now: number): PendingNodeRoomClose {
  if (!pair || !record || !instruction) throw new KithmootNodeError(0, 'invalid')
  const node = readNodeRoom(record.event, Math.min(now, record.endsAt === undefined ? now : record.endsAt - 1), record.authority)
  const closure = node && readNodeClosure(instruction.closure, node, now)
  const reset = node && parseGroupEvent(instruction.reset, { keepers: [node.authority], servers: [new URL(node.origin).hostname] })
  if (!node || pair.v !== 1 || pair.origin !== node.origin || pair.serviceKey !== node.serviceKey || !/^[a-f0-9]{64}$/.test(pair.owner)
    || !closure || closure.operation !== instruction.operation || !reset || !reset.ok || reset.parsed.type !== 'reset' || reset.parsed.roomId !== node.room
    || !Number.isSafeInteger(instruction.deadline) || instruction.deadline < closure.createdAt || instruction.deadline > closure.createdAt + 120
    || !Array.isArray(instruction.events) || instruction.events.length !== 2 || instruction.events.some(e => !e || !Array.isArray(e.tags))
    || new Set(instruction.events.map(e => e.kind)).size !== 2) throw new KithmootNodeError(0, 'invalid')
  for (const event of instruction.events) {
    if (!verifyEventUncached(event)) throw new KithmootNodeError(0, 'invalid')
    const expiration = event.tags.filter(t => t[0] === 'expiration')
    if (![1461, 1462].includes(event.kind) || event.pubkey !== node.authority
      || expiration.length !== 1 || expiration[0]!.length !== 2 || !/^[1-9][0-9]*$/.test(expiration[0]![1]!)
      || Number(expiration[0]![1]) <= instruction.deadline || Number(expiration[0]![1]) > closure.createdAt + 30 * 86400
      || new TextEncoder().encode(JSON.stringify(event)).length > 256 * 1024) throw new KithmootNodeError(0, 'invalid')
  }
  return { v: 1, reference: { v: 1, node: { v: 1, origin: node.origin, serviceKey: node.serviceKey, owner: pair.owner }, operation: instruction.operation },
    descriptor: signedEventOnly(node.event), instruction: { operation: instruction.operation, deadline: instruction.deadline,
      reset: signedEventOnly(instruction.reset) as GroupEvent, closure: signedEventOnly(instruction.closure), events: instruction.events.map(signedEventOnly) } }
}

/** Persist before I/O. A lost response leaves the exact request retryable.
 * Once the node ACKs durable intent, its supervisor can finish without this
 * app, so only the public completion reference remains on the owner device. */
export async function submitPendingNodeRoomClose(pending: PendingNodeRoomClose, authority: ParticipantIdentity, store: NodeRoomCloseStore,
  options: NodeClientOptions = {}): Promise<NodeCloseStatus> {
  const now = (options.now ?? (() => Math.floor(Date.now() / 1000)))(), raw = pending?.descriptor
  const node = raw && readNodeRoom(raw, Math.min(now, raw.created_at), authority.pubkey)
  if (!node || pending.v !== 1 || pending.reference.v !== 1 || pending.reference.operation !== pending.instruction.operation) throw new KithmootNodeError(0, 'invalid')
  const value = pendingNodeRoomClose(pending.reference.node, node, pending.instruction, now)
  if (options.signal?.aborted || options.allowed?.() === false) throw new KithmootNodeError(403, 'refused')
  try { await store.stage(structuredClone(value)) } catch { throw new KithmootNodeError(0, 'unavailable') }
  const result = await closeNodeRoom(node, value.instruction, authority, options)
  try { await store.forgetRoom(structuredClone(value.reference)) } catch { throw new KithmootNodeError(0, 'unavailable') }
  return result
}
