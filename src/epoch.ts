import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils'
import { schnorr } from '@noble/curves/secp256k1.js'
import { base64urlnopad } from '@scure/base'
import { nip44 } from 'nostr-tools'
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import { hexEquals, normaliseHex } from './hex.js'
import { KINDS } from './kinds.js'
import { deriveRoom } from './room.js'
import { verifyDeviceCredential } from './credential.js'
import { evaluateAccess } from './access.js'
import { verifyEventUncached } from './verify.js'
import type { RelayTransport } from './relay-pool.js'
import type { DeviceCredential, KindredProof, RoomPolicy } from './types.js'

/**
 * Room epochs: how a member is removed.
 *
 * A room's traffic key is derived from its secret, and everybody who was
 * ever admitted holds it. Link rotation retires the rendezvous and nothing
 * else: a departed collaborator, or a leaked agent key, reads the room for
 * as long as the room lives. The only thing that ends that is a new key
 * that the departed party is not given, and that is an epoch.
 *
 * Epoch 0 is the room as it has always been: the id and key `deriveRoom`
 * produces from the secret in the link, byte for byte. Every later epoch is
 * a fresh 32-byte secret from which its own id and key are derived, under
 * info strings that name the epoch number. The roster, the chat and its
 * channels, the descriptor and the media keys all move to the new epoch's
 * id and key together; the *room id* - what a credential binds to, what a
 * signal names, what a forwarder is given - does not move, because it is
 * the room's identity rather than its key.
 *
 * The move is announced by a rekey event: durable, addressed by the public
 * room id, numbered in a tag, signed by the room's authority (the root
 * inviter pinned in the link), and carrying the new secret sealed to each
 * remaining device. Its body is encrypted to the epoch being left, so a
 * member at that epoch reads it and moves, and a relay reads nothing but a
 * number. A member that missed one asks the authority for the current
 * epoch, proving who it is with its device credential, and the authority
 * answers everybody except the removed.
 *
 * Copies are sealed to the *device* pubkey, not the participant's, because
 * the device key is the one every session holds in memory: a participant
 * key may live in a browser extension or a bunker that signs and does
 * nothing else, and the identity surface is deliberately a pubkey and one
 * `signEvent` (see `identity.ts`). The participant is what a rekey names -
 * the removed set, the refusal - and the device credential is how a device
 * proves which participant it speaks for when it asks.
 */

const EPOCH_ID_INFO = 'kithmoot/v1/epoch-id'
const EPOCH_KEY_INFO = 'kithmoot/v1/epoch-key'
const EPOCH_MAX_AGE_SECONDS = 90
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRY_MS = 2_000
/** A room that has been rekeyed more times than this has a problem that is
 *  not this module's to solve. Bounds the tag a client will parse. */
export const MAX_EPOCH = 1_000_000

/** One epoch of a room. Epoch 0's secret is the room secret itself. */
export interface RoomEpoch {
  epoch: number
  secret: Uint8Array
}

/** What the roster, chat and descriptor ride under in one epoch. */
export interface EpochKeys {
  epoch: number
  /** The `d` tag root. The room id in epoch 0. */
  id: string
  /** The cipher key. The room key in epoch 0. */
  key: Uint8Array
}

const HEX64 = /^[0-9a-f]{64}$/i

function require32(bytes: Uint8Array, what: string): void {
  if (bytes.length !== 32) throw new Error(`${what} must be 32 bytes`)
}

function requireHex32(value: string, what: string): string {
  if (!HEX64.test(value)) throw new Error(`${what} must be 32-byte hex`)
  return normaliseHex(value)
}

function requireEpochNumber(epoch: number): number {
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > MAX_EPOCH) throw new Error('epoch must be a small non-negative integer')
  return epoch
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A fresh secret for the next epoch. */
export function generateEpochSecret(): Uint8Array {
  return randomBytes(32)
}

/**
 * The id and key a room's traffic rides under in `epoch`.
 *
 * Epoch 0 is exactly `deriveRoom(secret)`, so a room that has never been
 * rekeyed is byte-identical on the wire to one from before epochs existed.
 * Every later epoch expands its own secret under info strings that carry
 * the epoch number, so the same secret at two numbers - which a correct
 * authority never produces - would still derive two different keys.
 */
export function deriveEpoch(epoch: RoomEpoch): EpochKeys {
  require32(epoch.secret, 'epoch secret')
  const n = requireEpochNumber(epoch.epoch)
  if (n === 0) {
    const { roomId, roomKey } = deriveRoom(epoch.secret)
    return { epoch: 0, id: roomId, key: roomKey }
  }
  return {
    epoch: n,
    id: hex(hkdf(sha256, epoch.secret, undefined, `${EPOCH_ID_INFO}/${n}`, 32)),
    key: hkdf(sha256, epoch.secret, undefined, `${EPOCH_KEY_INFO}/${n}`, 32),
  }
}

// ---------------------------------------------------------------------------
// The rekey event
// ---------------------------------------------------------------------------

interface SealedSecret {
  v: 1
  secret: string
}

interface RekeyBody {
  v: 1
  epoch: number
  removed: string[]
  by?: string
  closed?: true
  /** Device pubkey to a NIP-44 envelope, from the authority to that device,
   *  carrying the new secret. Inside the body, so who was kept is known
   *  only to the epoch being left. */
  keys: Record<string, string>
}

export interface EncodeRekeyOptions {
  roomId: string
  /** The room's authority: the root inviter key. Only it may rekey. */
  authoritySk: Uint8Array
  /** The epoch being left. Its key seals the body. */
  current: EpochKeys
  /** The epoch being entered. Must be `current.epoch + 1`. */
  next: RoomEpoch
  /** Devices to seal the new secret for. Everybody still in the room,
   *  except the removed participants' devices. */
  recipients: string[]
  /** Participants removed at this step. Empty on a rekey that only turns
   *  the key over. */
  removed: string[]
  /** The admin who asked, when one did. */
  by?: string
  /** True when the room is being closed: nobody is kept, and the event
   *  says so rather than leaving everybody to wonder. */
  closed?: boolean
  now: number
}

/** Announce the next epoch. See the module comment for what this is. */
export function encodeRekeyEvent(opts: EncodeRekeyOptions): Event {
  require32(opts.authoritySk, 'authority secret key')
  require32(opts.next.secret, 'epoch secret')
  const roomId = requireHex32(opts.roomId, 'room id')
  const epoch = requireEpochNumber(opts.next.epoch)
  if (epoch !== opts.current.epoch + 1) throw new Error('a rekey moves the room forward by exactly one epoch')
  const removed = [...new Set(opts.removed.map((p) => requireHex32(p, 'removed participant')))].sort()
  const keys: Record<string, string> = {}
  const sealed: SealedSecret = { v: 1, secret: base64urlnopad.encode(opts.next.secret) }
  const plaintext = JSON.stringify(sealed)
  for (const raw of opts.closed ? [] : opts.recipients) {
    const device = requireHex32(raw, 'recipient device')
    keys[device] = nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(opts.authoritySk, device))
  }
  const body: RekeyBody = {
    v: 1,
    epoch,
    removed,
    ...(opts.by !== undefined ? { by: requireHex32(opts.by, 'admin') } : {}),
    ...(opts.closed ? { closed: true } : {}),
    keys,
  }
  return finalizeEvent(
    {
      kind: KINDS.ROOM_REKEY,
      created_at: opts.now,
      tags: [
        ['d', roomId],
        ['epoch', String(epoch)],
      ],
      content: nip44.v2.encrypt(JSON.stringify(body), opts.current.key),
    },
    opts.authoritySk,
  )
}

/** What a rekey says, once read. */
export interface RekeyNotice {
  epoch: number
  removed: string[]
  by?: string
  closed: boolean
  /** The new secret, when a copy was sealed for this device. Absent for a
   *  device that was removed, or that was not in the room when the
   *  authority rekeyed. */
  secret?: Uint8Array
  /** The authority's clock when it rekeyed. */
  at: number
}

export interface PeekRekeyOptions {
  roomId: string
  /** The authority pubkey: the root inviter pinned in the link. */
  authority: string
}

/**
 * The epoch a rekey announces, checking everything that does not need a
 * key: kind, room, signer, signature and the epoch tag. What a client uses
 * to learn that the room is ahead of it before it can read why.
 */
export function peekRekeyEvent(event: Event, opts: PeekRekeyOptions): number | null {
  try {
    if (event.kind !== KINDS.ROOM_REKEY) return null
    if (!hexEquals(event.pubkey, opts.authority)) return null
    if (event.tags.find((t) => t[0] === 'd')?.[1]?.toLowerCase() !== normaliseHex(opts.roomId)) return null
    const tag = event.tags.find((t) => t[0] === 'epoch')?.[1]
    if (tag === undefined || !/^[1-9][0-9]{0,6}$/.test(tag)) return null
    const epoch = Number(tag)
    if (epoch > MAX_EPOCH) return null
    if (!verifyEventUncached(event)) return null
    return epoch
  } catch {
    return null
  }
}

export interface DecodeRekeyOptions extends PeekRekeyOptions {
  /** The epoch this device is at. A rekey is readable only from the epoch
   *  it leaves, and only accepted when it moves forward. */
  current: EpochKeys
  /** This device's key, to open its own copy. */
  deviceSk: Uint8Array
}

/**
 * Read a rekey. Null for anything that does not check out, and for a rekey
 * this device cannot read from where it stands: one for an epoch it is
 * already past (a replay), or one sealed to an epoch it is not at.
 */
export function decodeRekeyEvent(event: Event, opts: DecodeRekeyOptions): RekeyNotice | null {
  try {
    const epoch = peekRekeyEvent(event, opts)
    if (epoch === null || epoch !== opts.current.epoch + 1) return null
    const body = JSON.parse(nip44.v2.decrypt(event.content, opts.current.key)) as Partial<RekeyBody>
    if (body.v !== 1 || body.epoch !== epoch) return null
    if (!Array.isArray(body.removed) || !body.removed.every((p) => typeof p === 'string' && HEX64.test(p))) return null
    if (typeof body.keys !== 'object' || body.keys === null) return null
    const notice: RekeyNotice = {
      epoch,
      removed: [...new Set(body.removed.map(normaliseHex))].sort(),
      closed: body.closed === true,
      at: event.created_at,
    }
    if (typeof body.by === 'string' && HEX64.test(body.by)) notice.by = normaliseHex(body.by)
    const device = getPublicKey(opts.deviceSk)
    const mine = Object.entries(body.keys).find(([to]) => hexEquals(to, device))?.[1]
    if (typeof mine === 'string') {
      const sealed = JSON.parse(
        nip44.v2.decrypt(mine, nip44.v2.utils.getConversationKey(opts.deviceSk, event.pubkey)),
      ) as Partial<SealedSecret>
      if (sealed.v === 1 && typeof sealed.secret === 'string') {
        const secret = base64urlnopad.decode(sealed.secret)
        if (secret.length === 32) notice.secret = secret
      }
    }
    return notice
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Asking the authority for the current epoch
// ---------------------------------------------------------------------------

interface EpochRequestBody {
  v: 1
  credential: DeviceCredential
  proof?: KindredProof
}

export interface EncodeEpochRequestOptions {
  roomId: string
  authority: string
  deviceSk: Uint8Array
  /** Proves which participant this device speaks for. */
  credential: DeviceCredential
  proof?: KindredProof
  now: number
}

/** Ask the authority which epoch the room is at, and for its secret. */
export function encodeEpochRequest(opts: EncodeEpochRequestOptions): Event {
  require32(opts.deviceSk, 'device secret key')
  const roomId = requireHex32(opts.roomId, 'room id')
  const authority = requireHex32(opts.authority, 'authority pubkey')
  const body: EpochRequestBody = { v: 1, credential: opts.credential, ...(opts.proof ? { proof: opts.proof } : {}) }
  return finalizeEvent(
    {
      kind: KINDS.EPOCH_REQUEST,
      created_at: opts.now,
      tags: [
        ['d', roomId],
        ['p', authority],
      ],
      content: nip44.v2.encrypt(JSON.stringify(body), nip44.v2.utils.getConversationKey(opts.deviceSk, authority)),
    },
    opts.deviceSk,
  )
}

export interface DecodeEpochRequestOptions {
  roomId: string
  authoritySk: Uint8Array
  now: number
  policy?: RoomPolicy
  maxAgeSeconds?: number
}

export interface EpochRequest {
  device: string
  participant: string
  request: string
}

/** Null for anything malformed, stale, misaddressed, or from a device that
 *  cannot prove which participant it speaks for in this room. */
export function decodeEpochRequest(event: Event, opts: DecodeEpochRequestOptions): EpochRequest | null {
  try {
    if (event.kind !== KINDS.EPOCH_REQUEST) return null
    if (!verifyEventUncached(event)) return null
    if (Math.abs(opts.now - event.created_at) > (opts.maxAgeSeconds ?? EPOCH_MAX_AGE_SECONDS)) return null
    if (event.tags.find((t) => t[0] === 'd')?.[1]?.toLowerCase() !== normaliseHex(opts.roomId)) return null
    const authority = getPublicKey(opts.authoritySk)
    const addressed = event.tags.find((t) => t[0] === 'p')?.[1]
    if (addressed === undefined || !hexEquals(addressed, authority)) return null
    const body = JSON.parse(
      nip44.v2.decrypt(event.content, nip44.v2.utils.getConversationKey(opts.authoritySk, event.pubkey)),
    ) as Partial<EpochRequestBody>
    if (body.v !== 1 || typeof body.credential !== 'object' || body.credential === null) return null
    const verdict = verifyDeviceCredential(body.credential, { roomId: opts.roomId, now: opts.now })
    if (!verdict.ok) return null
    if (!hexEquals(verdict.device, event.pubkey)) return null
    if (opts.policy) {
      const proof = body.proof && typeof body.proof === 'object' ? body.proof : undefined
      if (!evaluateAccess(opts.policy, verdict.participant, proof, opts.now, opts.roomId).admitted) return null
    }
    return { device: verdict.device, participant: verdict.participant, request: event.id }
  } catch {
    return null
  }
}

/** Why the authority would not hand an epoch over. */
export type EpochRefusal = 'removed' | 'closed'

interface EpochGrantBody {
  v: 1
  request: string
  epoch?: number
  secret?: string
  removed?: string[]
  refused?: EpochRefusal
}

export interface EncodeEpochGrantOptions {
  roomId: string
  authoritySk: Uint8Array
  device: string
  request: string
  now: number
  /** The current epoch. Omitted when refusing. */
  epoch?: RoomEpoch
  removed?: string[]
  refused?: EpochRefusal
}

/** Answer one request: the current epoch sealed to the asking device, or a
 *  refusal it alone can read. */
export function encodeEpochGrant(opts: EncodeEpochGrantOptions): Event {
  require32(opts.authoritySk, 'authority secret key')
  const roomId = requireHex32(opts.roomId, 'room id')
  const device = requireHex32(opts.device, 'device pubkey')
  const request = requireHex32(opts.request, 'request id')
  const body: EpochGrantBody = { v: 1, request }
  if (opts.refused) {
    body.refused = opts.refused
  } else {
    if (!opts.epoch) throw new Error('a grant carries an epoch or a refusal')
    body.epoch = requireEpochNumber(opts.epoch.epoch)
    if (body.epoch > 0) {
      require32(opts.epoch.secret, 'epoch secret')
      body.secret = base64urlnopad.encode(opts.epoch.secret)
    }
    body.removed = [...new Set((opts.removed ?? []).map((p) => requireHex32(p, 'removed participant')))].sort()
  }
  return finalizeEvent(
    {
      kind: KINDS.EPOCH_GRANT,
      created_at: opts.now,
      tags: [
        ['d', roomId],
        ['p', device],
      ],
      content: nip44.v2.encrypt(JSON.stringify(body), nip44.v2.utils.getConversationKey(opts.authoritySk, device)),
    },
    opts.authoritySk,
  )
}

export interface DecodeEpochGrantOptions {
  roomId: string
  authority: string
  deviceSk: Uint8Array
  request: string
  now: number
  maxAgeSeconds?: number
}

export type EpochGrant =
  | { epoch: RoomEpoch | { epoch: 0 }; removed: string[]; refused?: undefined }
  | { refused: EpochRefusal }

/** Read the authority's answer to this device's own request. Null for
 *  anything else. Note a grant for epoch 0 carries no secret: the room has
 *  never been rekeyed, and the requester already holds what it needs. */
export function decodeEpochGrant(event: Event, opts: DecodeEpochGrantOptions): EpochGrant | null {
  try {
    if (event.kind !== KINDS.EPOCH_GRANT) return null
    if (!hexEquals(event.pubkey, opts.authority)) return null
    if (!verifyEventUncached(event)) return null
    if (Math.abs(opts.now - event.created_at) > (opts.maxAgeSeconds ?? EPOCH_MAX_AGE_SECONDS)) return null
    if (event.tags.find((t) => t[0] === 'd')?.[1]?.toLowerCase() !== normaliseHex(opts.roomId)) return null
    const device = getPublicKey(opts.deviceSk)
    const addressed = event.tags.find((t) => t[0] === 'p')?.[1]
    if (addressed === undefined || !hexEquals(addressed, device)) return null
    const body = JSON.parse(
      nip44.v2.decrypt(event.content, nip44.v2.utils.getConversationKey(opts.deviceSk, event.pubkey)),
    ) as Partial<EpochGrantBody>
    if (body.v !== 1 || typeof body.request !== 'string' || !hexEquals(body.request, opts.request)) return null
    if (body.refused === 'removed' || body.refused === 'closed') return { refused: body.refused }
    if (!Number.isSafeInteger(body.epoch) || (body.epoch as number) < 0 || (body.epoch as number) > MAX_EPOCH) return null
    const removed = Array.isArray(body.removed)
      ? [...new Set(body.removed.filter((p): p is string => typeof p === 'string' && HEX64.test(p)).map(normaliseHex))].sort()
      : []
    if (body.epoch === 0) return { epoch: { epoch: 0 }, removed }
    if (typeof body.secret !== 'string') return null
    const secret = base64urlnopad.decode(body.secret)
    if (secret.length !== 32) return null
    return { epoch: { epoch: body.epoch as number, secret }, removed }
  } catch {
    return null
  }
}

export interface HostRoomEpochOptions {
  transport: RelayTransport
  roomId: string
  authoritySk: Uint8Array
  /** Where the room is now. Asked on every request, because it moves. */
  current: () => RoomEpoch
  /** Who has been removed. Asked on every request, for the same reason. */
  removed: () => ReadonlySet<string>
  /** True once the room has been closed: every request is refused. */
  closed?: () => boolean
  policy?: RoomPolicy
  now?: () => number
  onGranted?: (request: EpochRequest) => void
  onRefused?: (request: EpochRequest, why: EpochRefusal) => void
}

/**
 * Answer epoch requests for as long as the handle is open. What a keeper
 * runs beside its invitation desk: a member arriving, or returning, after
 * a rekey is handed the current epoch on proof of who it is, and a removed
 * participant is told no. This is where removal is enforced against the
 * link: the link still admits its holder to the room's *secret*, which
 * opens epoch 0 and nothing after it.
 */
export function hostRoomEpoch(opts: HostRoomEpochOptions): { close(): void } {
  require32(opts.authoritySk, 'authority secret key')
  const roomId = requireHex32(opts.roomId, 'room id')
  const authority = getPublicKey(opts.authoritySk)
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const answered = new Set<string>()
  let closed = false
  const unsub = opts.transport.subscribe(
    [{ kinds: [KINDS.EPOCH_REQUEST], '#d': [roomId], '#p': [authority] }],
    (event) => {
      if (closed) return
      const request = decodeEpochRequest(event, { roomId, authoritySk: opts.authoritySk, now: now(), policy: opts.policy })
      if (!request || answered.has(request.request)) return
      answered.add(request.request)
      if (answered.size > 256) answered.delete(answered.values().next().value!)
      let refused: EpochRefusal | undefined
      if (opts.closed?.()) refused = 'closed'
      else if (opts.removed().has(request.participant)) refused = 'removed'
      let grant: Event
      try {
        grant = refused
          ? encodeEpochGrant({ roomId, authoritySk: opts.authoritySk, device: request.device, request: request.request, now: now(), refused })
          : encodeEpochGrant({
              roomId,
              authoritySk: opts.authoritySk,
              device: request.device,
              request: request.request,
              now: now(),
              epoch: opts.current(),
              removed: [...opts.removed()],
            })
      } catch {
        return
      }
      opts.transport.publish(grant).catch(() => {})
      if (refused) opts.onRefused?.(request, refused)
      else opts.onGranted?.(request)
    },
  )
  return {
    close() {
      if (closed) return
      closed = true
      unsub()
    },
  }
}

export interface RequestRoomEpochOptions {
  transport: RelayTransport
  roomId: string
  authority: string
  deviceSk: Uint8Array
  credential: DeviceCredential
  proof?: KindredProof
  now?: () => number
  timeoutMs?: number
  retryMs?: number
}

/** Thrown when the authority answered, and the answer was no. */
export class EpochRefusedError extends Error {
  readonly refused: EpochRefusal
  constructor(refused: EpochRefusal) {
    super(refused === 'removed' ? 'you were removed from this room' : 'this room has been closed')
    this.name = 'EpochRefusedError'
    this.refused = refused
  }
}

/** Ask the authority where the room is, and wait for the answer. Rejects
 *  with `EpochRefusedError` on a refusal, and with a plain error when
 *  nobody answers inside the timeout. */
export function requestRoomEpoch(opts: RequestRoomEpochOptions): Promise<Exclude<EpochGrant, { refused: EpochRefusal }>> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const roomId = requireHex32(opts.roomId, 'room id')
  const device = getPublicKey(opts.deviceSk)
  const request = encodeEpochRequest({
    roomId,
    authority: opts.authority,
    deviceSk: opts.deviceSk,
    credential: opts.credential,
    proof: opts.proof,
    now: now(),
  })
  return new Promise((resolve, reject) => {
    let settled = false
    let retry: ReturnType<typeof setInterval> | undefined
    let expiry: ReturnType<typeof setTimeout> | undefined
    let unsub = () => {}
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      if (retry !== undefined) clearInterval(retry)
      if (expiry !== undefined) clearTimeout(expiry)
      unsub()
      settle()
    }
    unsub = opts.transport.subscribe([{ kinds: [KINDS.EPOCH_GRANT], '#d': [roomId], '#p': [device] }], (event) => {
      const grant = decodeEpochGrant(event, { roomId, authority: opts.authority, deviceSk: opts.deviceSk, request: request.id, now: now() })
      if (!grant) return
      if (grant.refused) finish(() => reject(new EpochRefusedError(grant.refused)))
      else finish(() => resolve(grant))
    })
    if (settled) unsub()
    const ask = (): void => {
      if (!settled) opts.transport.publish(request).catch(() => {})
    }
    expiry = setTimeout(
      () => finish(() => reject(new Error('the room has moved to a newer epoch and its keeper is not answering'))),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    ;(expiry as unknown as { unref?: () => void }).unref?.()
    retry = setInterval(ask, opts.retryMs ?? DEFAULT_RETRY_MS)
    ;(retry as unknown as { unref?: () => void }).unref?.()
    ask()
  })
}

// ---------------------------------------------------------------------------
// The admin list
// ---------------------------------------------------------------------------

function adminsMessage(roomId: string, epoch: number, admins: string[]): Uint8Array {
  return sha256(new TextEncoder().encode(`kithmoot/v1/admins:${roomId}:${epoch}:${admins.join(',')}`))
}

/** Canonical form of an admin list: lower-case, deduplicated, sorted. */
export function canonicalAdmins(admins: readonly string[]): string[] {
  return [...new Set(admins.map((a) => requireHex32(a, 'admin pubkey')))].sort()
}

export interface SignAdminsOptions {
  roomId: string
  epoch: number
  admins: readonly string[]
  authoritySk: Uint8Array
}

/**
 * Sign the list of participants who may act on the room, so a client can
 * tell a keeper's announcement from anybody else's claim: the announcement
 * rides the control channel, which every member can write to, and only the
 * authority key pinned in the link can produce this.
 */
export function signAdmins(opts: SignAdminsOptions): string {
  require32(opts.authoritySk, 'authority secret key')
  const roomId = requireHex32(opts.roomId, 'room id')
  const admins = canonicalAdmins(opts.admins)
  return bytesToHex(schnorr.sign(adminsMessage(roomId, requireEpochNumber(opts.epoch), admins), opts.authoritySk))
}

export interface VerifyAdminsOptions {
  roomId: string
  epoch: number
  admins: readonly string[]
  sig: string
  authority: string
}

export function verifyAdmins(opts: VerifyAdminsOptions): boolean {
  try {
    const roomId = requireHex32(opts.roomId, 'room id')
    const admins = canonicalAdmins(opts.admins)
    const sig = hexToBytes(opts.sig)
    if (sig.length !== 64) return false
    return schnorr.verify(sig, adminsMessage(roomId, requireEpochNumber(opts.epoch), admins), hexToBytes(requireHex32(opts.authority, 'authority')))
  } catch {
    return false
  }
}
