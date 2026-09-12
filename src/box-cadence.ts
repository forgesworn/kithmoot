/**
 * The phone-owned half of Vennel quiet cadence delegation.
 *
 * This module prepares byte-exact control requests for a verified Bothy over
 * an already-authenticated ordinary Link session. It deliberately contains no
 * dialler and no HTTP fallback: KithMoot does not yet have a browser Link
 * transport, and these credentials must never be sent over the public web.
 *
 * Only public drop keys cross the boundary. The room epoch key remains with
 * the client and is used here only long enough to derive each public key.
 */
import { base64 } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { deriveRoomDropKey } from 'nostr-deaddrop'
import type { Event } from 'nostr-tools/pure'
import { verifyDeviceCredential } from './credential.js'
import { hexEquals, normaliseHex } from './hex.js'
import type { ParticipantIdentity } from './identity.js'
import type { DeviceCredential } from './types.js'
import { verifyEventUncached } from './verify.js'

export const CADENCE_VERSION = 1 as const
export const CADENCE_EPOCH_SECONDS = 3_600
export const CADENCE_SLOT_SECONDS = 300
export const CADENCE_BUCKET_BYTES = 4_096
export const CADENCE_DEVICE_SLOTS = 2
export const CADENCE_COUNTERS_PER_DEVICE = 8
export const CADENCE_MAX_LEASE_EPOCHS = 7 * 24
export const CADENCE_MAX_FUTURE_START_EPOCHS = 7 * 24
export const CADENCE_INNER_KINDS = [1460] as const
export const CADENCE_CONTENT_TYPE = 'application/json' as const
export const CADENCE_AUTH_KIND = 27_235

const HEX64 = /^[0-9a-f]{64}$/
const ID32 = /^[0-9a-f]{32}$/
const NODE52 = /^[a-z2-7]{52}$/
const utf8 = new TextEncoder()

export interface CadenceDropPublicKey {
  epoch: number
  counter: number
  pubkey: string
}

export interface CadenceLeaseRequest {
  v: 1
  request_id: string
  lease_id: string
  generation: number
  server: string
  room: string
  persona: string
  device: string
  credential: DeviceCredential
  grant_id: string
  device_slot: number
  room_generation: number
  epoch_seconds: number
  slot_seconds: number
  bucket_bytes: number
  allowed_inner_kinds: number[]
  device_slots: number
  counter_lo: number
  counter_hi: number
  start_epoch: number
  end_epoch: number
  real_send_until_epoch: number
  cover_until_epoch: number
  drop_keys: CadenceDropPublicKey[]
  public_relays: string[]
  circle_boxes: string[]
}

export interface CadenceQueueRequest {
  v: 1
  request_id: string
  lease_id: string
  generation: number
  server: string
  room: string
  persona: string
  device: string
  credential: DeviceCredential
  grant_id: string
  event: Event
}

export interface CadenceMutationRequest {
  v: 1
  request_id: string
  lease_id: string
  generation: number
  server: string
  room: string
  persona: string
  device: string
  credential: DeviceCredential
  grant_id: string
  boundary_epoch: number | null
}

export interface CadenceStatusRequest {
  v: 1
  request_id: string
  server: string
  room: string
  persona: string
  device: string
  credential: DeviceCredential
  grant_id: string
  lease_id: string | null
  generation: number | null
}

export interface CadenceReceipt {
  v: 1
  code: string
  lease_id: string
  generation: number
  state: string
  server_time: number
  start_epoch: number
  end_epoch: number
  queue_count: number
  sent_item_ids: string[]
  failed_item_ids: string[]
}

export interface CadenceSignedRequest<T> {
  method: 'POST' | 'PUT'
  path: string
  body: string
  contentType: 'application/json'
  payloadSha256: string
  authorizationEvent: Event
  authorization: string
  value: T
}

export interface CadenceScope {
  nodeId: string
  room: string
  persona: string
  device: string
  credential: DeviceCredential
  grantId: string
}

export interface BuildCadenceLeaseOptions extends CadenceScope {
  requestId: string
  leaseId: string
  generation: number
  roomGeneration: number
  deviceSlot: number
  currentEpoch: number
  startEpoch: number
  endEpoch: number
  roomKey: Uint8Array
  publicRelays: string[]
  circleBoxes: string[]
  now: number
}

function integer(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid cadence ${name}`)
}

function exactId(value: string, pattern: RegExp, name: string): string {
  if (!pattern.test(value)) throw new Error(`invalid cadence ${name}`)
  return value
}

function canonicalWss(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'wss:' || url.username || url.password || url.hash || url.search || !url.hostname) return false
    let canonical = url.toString()
    if (url.pathname === '/' && canonical.endsWith('/')) canonical = canonical.slice(0, -1)
    return canonical === value
  } catch { return false }
}

function uniqueDestinations(values: string[], local: boolean): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 16 || new Set(values).size !== values.length) throw new Error('invalid cadence destinations')
  for (const value of values) if (!(local && value === 'local') && !canonicalWss(value)) throw new Error('invalid cadence destination')
  return [...values]
}

export function cadenceServer(nodeId: string): string {
  exactId(nodeId, NODE52, 'node id')
  return `ws://${nodeId}/events`
}

export function cadenceLeasePath(leaseId: string): string {
  return `/cadence/v1/leases/${exactId(leaseId, ID32, 'lease id')}`
}

export function cadenceQueuePath(leaseId: string): string {
  return `${cadenceLeasePath(leaseId)}/queue`
}

export function cadenceLeaseStatusPath(leaseId: string): string {
  return `${cadenceLeasePath(leaseId)}/status`
}

export function cadenceStopPath(leaseId: string): string {
  return `${cadenceLeasePath(leaseId)}/stop`
}

export function cadenceWithdrawPath(leaseId: string, eventId: string): string {
  exactId(eventId, HEX64, 'event id')
  return `${cadenceQueuePath(leaseId)}/${eventId}/withdraw`
}

export function deriveCadenceDropPublicKeys(
  roomKey: Uint8Array,
  member: string,
  startEpoch: number,
  endEpoch: number,
  deviceSlot: number,
): CadenceDropPublicKey[] {
  if (roomKey.length !== 32) throw new Error('invalid cadence room key')
  exactId(normaliseHex(member), HEX64, 'member')
  integer(startEpoch, 'start epoch'); integer(endEpoch, 'end epoch'); integer(deviceSlot, 'device slot')
  if (deviceSlot >= CADENCE_DEVICE_SLOTS || endEpoch <= startEpoch || endEpoch - startEpoch > CADENCE_MAX_LEASE_EPOCHS) throw new Error('invalid cadence key range')
  const counterLo = deviceSlot * CADENCE_COUNTERS_PER_DEVICE
  const out: CadenceDropPublicKey[] = []
  for (let epoch = startEpoch; epoch < endEpoch; epoch++) {
    for (let counter = counterLo; counter < counterLo + CADENCE_COUNTERS_PER_DEVICE; counter++) {
      // Drop the private scalar immediately. It is never returned or serialised.
      const { publicKey } = deriveRoomDropKey(roomKey, epoch, member, counter)
      out.push({ epoch, counter, pubkey: publicKey })
    }
  }
  return out
}

export function buildCadenceLease(options: BuildCadenceLeaseOptions): CadenceLeaseRequest {
  const nodeId = exactId(options.nodeId, NODE52, 'node id')
  const room = exactId(normaliseHex(options.room), HEX64, 'room')
  const persona = exactId(normaliseHex(options.persona), HEX64, 'persona')
  const device = exactId(normaliseHex(options.device), HEX64, 'device')
  exactId(options.requestId, ID32, 'request id'); exactId(options.leaseId, ID32, 'lease id'); exactId(options.grantId, ID32, 'grant id')
  for (const [value, name] of [[options.generation, 'generation'], [options.roomGeneration, 'room generation'], [options.currentEpoch, 'current epoch'], [options.startEpoch, 'start epoch'], [options.endEpoch, 'end epoch'], [options.deviceSlot, 'device slot']] as const) integer(value, name)
  if (options.generation === 0 || options.roomGeneration === 0 || options.deviceSlot >= CADENCE_DEVICE_SLOTS) throw new Error('invalid cadence generation or device slot')
  if (options.startEpoch < options.currentEpoch + 2 || options.startEpoch > options.currentEpoch + CADENCE_MAX_FUTURE_START_EPOCHS) throw new Error('invalid cadence future start')
  if (options.endEpoch <= options.startEpoch || options.endEpoch - options.startEpoch > CADENCE_MAX_LEASE_EPOCHS) throw new Error('invalid cadence lease window')
  const credential = verifyDeviceCredential(options.credential, { roomId: room, now: options.now, acceptPerson: true })
  if (!credential.ok || !hexEquals(credential.participant, persona) || !hexEquals(credential.device, device)) throw new Error('invalid cadence credential')
  const allowedCredentialTags = new Set(['d', 'device', 'expiration', 'scope', 'label'])
  if (options.credential.created_at > options.now + 300 || options.credential.tags.some(tag => tag.length < 1 || !allowedCredentialTags.has(tag[0]!))) throw new Error('invalid cadence credential')
  const expiration = Number(options.credential.tags.find(tag => tag[0] === 'expiration')?.[1])
  if (!Number.isSafeInteger(expiration) || expiration < options.endEpoch * CADENCE_EPOCH_SECONDS) throw new Error('cadence credential expires before lease')
  const counterLo = options.deviceSlot * CADENCE_COUNTERS_PER_DEVICE
  const publicRelays = uniqueDestinations(options.publicRelays, false)
  const circleBoxes = uniqueDestinations(options.circleBoxes, true)
  if (publicRelays.length < 2 || !circleBoxes.includes('local') || circleBoxes.some(value => publicRelays.includes(value))) throw new Error('invalid cadence destinations')
  return {
    v: CADENCE_VERSION,
    request_id: options.requestId,
    lease_id: options.leaseId,
    generation: options.generation,
    server: cadenceServer(nodeId),
    room,
    persona,
    device,
    credential: options.credential,
    grant_id: options.grantId,
    device_slot: options.deviceSlot,
    room_generation: options.roomGeneration,
    epoch_seconds: CADENCE_EPOCH_SECONDS,
    slot_seconds: CADENCE_SLOT_SECONDS,
    bucket_bytes: CADENCE_BUCKET_BYTES,
    allowed_inner_kinds: [...CADENCE_INNER_KINDS],
    device_slots: CADENCE_DEVICE_SLOTS,
    counter_lo: counterLo,
    counter_hi: counterLo + CADENCE_COUNTERS_PER_DEVICE,
    start_epoch: options.startEpoch,
    end_epoch: options.endEpoch,
    real_send_until_epoch: options.endEpoch,
    cover_until_epoch: options.endEpoch,
    drop_keys: deriveCadenceDropPublicKeys(options.roomKey, persona, options.startEpoch, options.endEpoch, options.deviceSlot),
    public_relays: publicRelays,
    circle_boxes: circleBoxes,
  }
}

export function buildCadenceQueue(lease: CadenceLeaseRequest, requestId: string, event: Event): CadenceQueueRequest {
  exactId(requestId, ID32, 'request id')
  const roomTags = event.tags.filter(tag => tag[0] === 'd')
  if (event.kind !== 1460 || !hexEquals(event.pubkey, lease.device) || !verifyEventUncached(event) || roomTags.length !== 1 || roomTags[0]!.length !== 2 || !hexEquals(roomTags[0]![1]!, lease.room)) throw new Error('invalid cadence queue event')
  if (utf8.encode(JSON.stringify({ e: event, pad: '' })).length > CADENCE_BUCKET_BYTES) throw new Error('cadence queue event exceeds bucket')
  return {
    v: CADENCE_VERSION, request_id: requestId, lease_id: lease.lease_id, generation: lease.generation,
    server: lease.server, room: lease.room, persona: lease.persona, device: lease.device,
    credential: lease.credential, grant_id: lease.grant_id, event,
  }
}

export function buildCadenceMutation(lease: CadenceLeaseRequest, requestId: string, boundaryEpoch: number | null): CadenceMutationRequest {
  exactId(requestId, ID32, 'request id')
  if (boundaryEpoch !== null) integer(boundaryEpoch, 'boundary epoch')
  return {
    v: CADENCE_VERSION, request_id: requestId, lease_id: lease.lease_id, generation: lease.generation,
    server: lease.server, room: lease.room, persona: lease.persona, device: lease.device,
    credential: lease.credential, grant_id: lease.grant_id, boundary_epoch: boundaryEpoch,
  }
}

export function buildCadenceStatus(scope: CadenceScope, requestId: string, lease?: Pick<CadenceLeaseRequest, 'lease_id' | 'generation'>): CadenceStatusRequest {
  return {
    v: CADENCE_VERSION,
    request_id: exactId(requestId, ID32, 'request id'),
    server: cadenceServer(scope.nodeId),
    room: exactId(normaliseHex(scope.room), HEX64, 'room'),
    persona: exactId(normaliseHex(scope.persona), HEX64, 'persona'),
    device: exactId(normaliseHex(scope.device), HEX64, 'device'),
    credential: scope.credential,
    grant_id: exactId(scope.grantId, ID32, 'grant id'),
    lease_id: lease?.lease_id ?? null,
    generation: lease?.generation ?? null,
  }
}

export function serialiseCadenceBody(value: unknown): string {
  return JSON.stringify(value)
}

export function cadencePayloadSha256(body: string): string {
  return bytesToHex(sha256(utf8.encode(body)))
}

export async function signCadenceRequest<T>(options: {
  nodeId: string
  method: 'POST' | 'PUT'
  path: string
  value: T
  signer: ParticipantIdentity
  now: number
}): Promise<CadenceSignedRequest<T>> {
  cadenceServer(options.nodeId)
  if (!options.path.startsWith('/cadence/v1/') || options.path.includes('?') || options.path.includes('#')) throw new Error('invalid cadence path')
  integer(options.now, 'authorization time')
  const body = serialiseCadenceBody(options.value)
  const bodyBytes = utf8.encode(body)
  if (bodyBytes.length > 256 * 1024) throw new Error('cadence request body is too large')
  const payloadSha256 = cadencePayloadSha256(body)
  const tags = [['u', `http://${options.nodeId}${options.path}`], ['method', options.method], ['payload', payloadSha256]]
  const authorizationEvent = await options.signer.signEvent({ kind: CADENCE_AUTH_KIND, created_at: options.now, tags, content: '' })
  const valueDevice = options.value && typeof options.value === 'object' && 'device' in options.value ? String((options.value as { device: unknown }).device) : undefined
  if ((valueDevice !== undefined && !hexEquals(valueDevice, options.signer.pubkey)) || !hexEquals(authorizationEvent.pubkey, options.signer.pubkey) || authorizationEvent.kind !== CADENCE_AUTH_KIND || authorizationEvent.created_at !== options.now || authorizationEvent.content !== '' || JSON.stringify(authorizationEvent.tags) !== JSON.stringify(tags) || !verifyEventUncached(authorizationEvent)) {
    throw new Error('the signer returned cadence authorization for different bytes')
  }
  // Rust's Event serde order is the frozen cross-language wire order. Nostr
  // verification itself is independent of object-key order, but retaining one
  // exact encoding makes retries and fixtures byte-for-byte comparable.
  const wireEvent = {
    id: authorizationEvent.id,
    pubkey: authorizationEvent.pubkey,
    created_at: authorizationEvent.created_at,
    kind: authorizationEvent.kind,
    tags: authorizationEvent.tags,
    content: authorizationEvent.content,
    sig: authorizationEvent.sig,
  }
  const authorization = `Nostr ${base64.encode(utf8.encode(JSON.stringify(wireEvent)))}`
  return { method: options.method, path: options.path, body, contentType: CADENCE_CONTENT_TYPE, payloadSha256, authorizationEvent, authorization, value: options.value }
}
