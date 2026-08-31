import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils'
import { schnorr } from '@noble/curves/secp256k1.js'
import { base64urlnopad } from '@scure/base'
import { nip44 } from 'nostr-tools'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { hexEquals, normaliseHex } from './hex.js'
import { KINDS } from './kinds.js'
import type { RelayTransport } from './relay-pool.js'
import { verifyEventUncached } from './verify.js'
import { deriveRoom } from './room.js'

const INVITATION_ID_INFO = 'kithmoot/v2/invitation-id'
const INVITATION_REQUEST_KEY_INFO = 'kithmoot/v2/invitation-request-key'
const INVITATION_MAX_AGE_SECONDS = 90
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_RETRY_MS = 2_000
/** A delegated responder cannot silently make its authority permanent. */
export const INVITATION_DELEGATION_TTL_SECONDS = 12 * 60 * 60
/** Bounds both verification work and the size of a grant from a hostile peer. */
export const MAX_INVITATION_DELEGATION_DEPTH = 16

/**
 * What a share link grants.
 *
 * `bearer` proves that somebody received the link. It is not a traffic key.
 * `inviter` pins the root pubkey allowed to establish a room-bound responder
 * chain, so another bearer can ask to enter but cannot nominate an authority
 * or substitute a room of their own.
 */
export interface RoomInvitation {
  bearer: Uint8Array
  inviter: string
}

/** The private half retained by the browser that created an invitation. */
export interface RoomInvitationHost {
  invitation: RoomInvitation
  inviterSk: Uint8Array
}

/**
 * One hop in the authority chain rooted at the inviter pubkey in the link.
 *
 * Every field that gives the certificate meaning is signed. In particular,
 * `invitation` binds it to one bearer-derived rendezvous and `room` to one
 * traffic-secret derivation, so a member delegated for an old link cannot
 * answer a replacement or substitute another room.
 */
export interface InvitationDelegation {
  invitation: string
  room: string
  issuer: string
  delegate: string
  expiresAt: number
  sig: string
}

/** The capability an admitted browser retains so it can answer the next
 * joiner even after the creator has left. */
export interface RoomInvitationDelegate {
  delegateSk: Uint8Array
  chain: InvitationDelegation[]
}

/** The result of admission: room traffic capability plus bounded authority
 * to keep this particular invitation available. */
export interface RoomAdmission {
  secret: Uint8Array
  delegate: RoomInvitationDelegate
}

function require32(bytes: Uint8Array, what: string): void {
  if (bytes.length !== 32) throw new Error(`${what} must be 32 bytes`)
}

function requireHex32(value: string, what: string): string {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error(`${what} must be 32-byte hex`)
  return normaliseHex(value)
}

function requirePubkey(pubkey: string): string {
  return requireHex32(pubkey, 'inviter pubkey')
}

/** Create a bearer plus a fresh, unlinkable inviter key for one share URL. */
export function createRoomInvitation(): RoomInvitationHost {
  const inviterSk = generateSecretKey()
  return {
    invitation: { bearer: randomBytes(32), inviter: getPublicKey(inviterSk) },
    inviterSk,
  }
}

/** Validate and canonicalise an invitation crossing a URL/storage boundary. */
export function roomInvitation(bearer: Uint8Array, inviter: string): RoomInvitation {
  require32(bearer, 'invitation bearer')
  return { bearer, inviter: requirePubkey(inviter) }
}

/** Public rendezvous id. Relays see this and timing, but cannot derive the bearer. */
export function deriveInvitationId(invitation: RoomInvitation): string {
  require32(invitation.bearer, 'invitation bearer')
  const bytes = hkdf(sha256, invitation.bearer, undefined, INVITATION_ID_INFO, 32)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function requestKey(invitation: RoomInvitation): Uint8Array {
  return hkdf(sha256, invitation.bearer, undefined, INVITATION_REQUEST_KEY_INFO, 32)
}

interface InvitationRequestBody {
  v: 1
  device: string
}

export interface EncodeInvitationRequestOptions {
  invitation: RoomInvitation
  requesterSk: Uint8Array
  now: number
}

/** Prove possession of the bearer without putting it, or a traffic key, on a relay. */
export function encodeInvitationRequest(opts: EncodeInvitationRequestOptions): Event {
  require32(opts.requesterSk, 'requester secret key')
  const device = getPublicKey(opts.requesterSk)
  const body: InvitationRequestBody = { v: 1, device }
  return finalizeEvent(
    {
      kind: KINDS.INVITATION_REQUEST,
      created_at: opts.now,
      tags: [
        ['d', deriveInvitationId(opts.invitation)],
        ['p', requirePubkey(opts.invitation.inviter)],
      ],
      content: nip44.v2.encrypt(JSON.stringify(body), requestKey(opts.invitation)),
    },
    opts.requesterSk,
  )
}

export interface DecodeInvitationRequestOptions {
  invitation: RoomInvitation
  now: number
  maxAgeSeconds?: number
}

/** Returns null for all malformed, stale, wrongly addressed, or unauthorised asks. */
export function decodeInvitationRequest(
  event: Event,
  opts: DecodeInvitationRequestOptions,
): { device: string; request: string } | null {
  try {
    if (event.kind !== KINDS.INVITATION_REQUEST) return null
    if (!verifyEventUncached(event)) return null
    if (Math.abs(opts.now - event.created_at) > (opts.maxAgeSeconds ?? INVITATION_MAX_AGE_SECONDS)) return null
    if (event.tags.find((t) => t[0] === 'd')?.[1] !== deriveInvitationId(opts.invitation)) return null
    const addressed = event.tags.find((t) => t[0] === 'p')?.[1]
    if (addressed === undefined || !hexEquals(addressed, opts.invitation.inviter)) return null

    const body = JSON.parse(
      nip44.v2.decrypt(event.content, requestKey(opts.invitation)),
    ) as Partial<InvitationRequestBody>
    if (body.v !== 1 || typeof body.device !== 'string') return null
    if (!hexEquals(body.device, event.pubkey)) return null
    return { device: requirePubkey(body.device), request: event.id }
  } catch {
    return null
  }
}

function delegationMessage(
  invitation: string,
  room: string,
  issuer: string,
  delegate: string,
  expiresAt: number,
): Uint8Array {
  return sha256(
    new TextEncoder().encode(
      `kithmoot/v2/invitation-delegation:${invitation}:${room}:${issuer}:${delegate}:${expiresAt}`,
    ),
  )
}

function issueInvitationDelegation(
  invitation: RoomInvitation,
  room: string,
  issuerSk: Uint8Array,
  delegate: string,
  expiresAt: number,
): InvitationDelegation {
  const invitationId = deriveInvitationId(invitation)
  const canonicalRoom = requireHex32(room, 'room id')
  const issuer = getPublicKey(issuerSk)
  const canonicalDelegate = requirePubkey(delegate)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw new Error('delegation expiry must be unix seconds')
  return {
    invitation: invitationId,
    room: canonicalRoom,
    issuer,
    delegate: canonicalDelegate,
    expiresAt,
    sig: bytesToHex(
      schnorr.sign(
        delegationMessage(invitationId, canonicalRoom, issuer, canonicalDelegate, expiresAt),
        issuerSk,
      ),
    ),
  }
}

/**
 * Verify a whole chain and return the pubkey authorised by its final hop.
 * An empty chain names the root inviter itself.
 */
export function verifyInvitationDelegation(
  invitation: RoomInvitation,
  chain: InvitationDelegation[],
  now: number,
): string | null {
  try {
    if (!Array.isArray(chain) || chain.length > MAX_INVITATION_DELEGATION_DEPTH) return null
    const invitationId = deriveInvitationId(invitation)
    let room: string | undefined
    let authority = requirePubkey(invitation.inviter)
    for (const raw of chain) {
      if (typeof raw !== 'object' || raw === null) return null
      const cert: InvitationDelegation = {
        invitation: normaliseHex(raw.invitation),
        room: requireHex32(raw.room, 'room id'),
        issuer: requirePubkey(raw.issuer),
        delegate: requirePubkey(raw.delegate),
        expiresAt: raw.expiresAt,
        sig: normaliseHex(raw.sig),
      }
      if (!hexEquals(cert.invitation, invitationId)) return null
      if (room !== undefined && !hexEquals(cert.room, room)) return null
      room = cert.room
      if (!hexEquals(cert.issuer, authority)) return null
      if (!Number.isSafeInteger(cert.expiresAt) || cert.expiresAt <= now) return null
      if (hexToBytes(cert.sig).length !== 64) return null
      if (
        !schnorr.verify(
          hexToBytes(cert.sig),
          delegationMessage(cert.invitation, cert.room, cert.issuer, cert.delegate, cert.expiresAt),
          hexToBytes(cert.issuer),
        )
      ) return null
      authority = cert.delegate
    }
    return authority
  } catch {
    return null
  }
}

interface InvitationGrantBody {
  v: 2
  request: string
  secret: string
  /** Root-to-requester chain. The last hop is minted by this grant's signer. */
  delegation: InvitationDelegation[]
}

export interface EncodeInvitationGrantOptions {
  invitation: RoomInvitation
  inviterSk: Uint8Array
  requester: string
  request: string
  roomSecret: Uint8Array
  now: number
  /** Empty for the creator; otherwise the root-to-signer chain received when
   * this responder joined. */
  delegation?: InvitationDelegation[]
  delegationTtlSeconds?: number
}

/** Encrypt a room secret only to the requester and authenticate its signer
 * through the room-bound chain rooted at the inviter pinned in the link. */
export function encodeInvitationGrant(opts: EncodeInvitationGrantOptions): Event {
  require32(opts.inviterSk, 'inviter secret key')
  require32(opts.roomSecret, 'room secret')
  const inviter = getPublicKey(opts.inviterSk)
  const chain = opts.delegation ?? []
  const roomId = deriveRoom(opts.roomSecret).roomId
  const authorised = verifyInvitationDelegation(opts.invitation, chain, opts.now)
  if (authorised === null || !hexEquals(inviter, authorised)) throw new Error('responder is not delegated for invitation')
  if (chain.length > 0 && !hexEquals(chain[0]!.room, roomId)) throw new Error('delegation names another room')
  if (chain.length >= MAX_INVITATION_DELEGATION_DEPTH) throw new Error('invitation delegation is at maximum depth')
  const requester = requirePubkey(opts.requester)
  if (!/^[0-9a-f]{64}$/i.test(opts.request)) throw new Error('request id must be 32-byte hex')
  const ownExpiry = chain.length === 0
    ? Number.POSITIVE_INFINITY
    : Math.min(...chain.map((cert) => cert.expiresAt))
  const expiresAt = Math.min(
    ownExpiry,
    opts.now + (opts.delegationTtlSeconds ?? INVITATION_DELEGATION_TTL_SECONDS),
  )
  const next = issueInvitationDelegation(opts.invitation, roomId, opts.inviterSk, requester, expiresAt)
  const body: InvitationGrantBody = {
    v: 2,
    request: normaliseHex(opts.request),
    secret: base64urlnopad.encode(opts.roomSecret),
    delegation: [...chain, next],
  }
  const conversationKey = nip44.v2.utils.getConversationKey(opts.inviterSk, requester)
  return finalizeEvent(
    {
      kind: KINDS.INVITATION_GRANT,
      created_at: opts.now,
      tags: [
        ['d', deriveInvitationId(opts.invitation)],
        ['p', requester],
      ],
      content: nip44.v2.encrypt(JSON.stringify(body), conversationKey),
    },
    opts.inviterSk,
  )
}

export interface DecodeInvitationGrantOptions {
  invitation: RoomInvitation
  requesterSk: Uint8Array
  request: string
  now: number
  maxAgeSeconds?: number
}

/**
 * Accept a fresh response whose delegation chain terminates at its event
 * signer, then retain the final requester hop so this member can become a
 * responder in turn. The chain always roots at the pubkey pinned in the
 * link; a bearer holder cannot nominate an authority of their own.
 */
export function decodeRoomAdmissionGrant(
  event: Event,
  opts: DecodeInvitationGrantOptions,
): RoomAdmission | null {
  try {
    if (event.kind !== KINDS.INVITATION_GRANT) return null
    if (!verifyEventUncached(event)) return null
    if (Math.abs(opts.now - event.created_at) > (opts.maxAgeSeconds ?? INVITATION_MAX_AGE_SECONDS)) return null
    if (event.tags.find((t) => t[0] === 'd')?.[1] !== deriveInvitationId(opts.invitation)) return null
    const requester = getPublicKey(opts.requesterSk)
    const addressed = event.tags.find((t) => t[0] === 'p')?.[1]
    if (addressed === undefined || !hexEquals(addressed, requester)) return null

    const conversationKey = nip44.v2.utils.getConversationKey(opts.requesterSk, event.pubkey)
    const body = JSON.parse(nip44.v2.decrypt(event.content, conversationKey)) as Partial<InvitationGrantBody>
    if (body.v !== 2 || typeof body.request !== 'string' || !hexEquals(body.request, opts.request)) return null
    if (typeof body.secret !== 'string') return null
    const secret = base64urlnopad.decode(body.secret)
    if (secret.length !== 32) return null
    if (!Array.isArray(body.delegation) || body.delegation.length === 0) return null
    if (!hexEquals(body.delegation[0]!.room, deriveRoom(secret).roomId)) return null
    const authority = verifyInvitationDelegation(opts.invitation, body.delegation, opts.now)
    if (authority === null || !hexEquals(authority, requester)) return null
    const issuer = body.delegation.at(-1)?.issuer
    if (issuer === undefined || !hexEquals(issuer, event.pubkey)) return null
    return {
      secret,
      delegate: { delegateSk: opts.requesterSk, chain: body.delegation },
    }
  } catch {
    return null
  }
}

/** Backward-compatible convenience for callers that only need the traffic
 * secret. New interactive clients should retain `decodeRoomAdmissionGrant`'s
 * delegate capability so the room does not depend on its creator staying. */
export function decodeInvitationGrant(
  event: Event,
  opts: DecodeInvitationGrantOptions,
): Uint8Array | null {
  return decodeRoomAdmissionGrant(event, opts)?.secret ?? null
}

export interface HostRoomInvitationOptions {
  transport: RelayTransport
  invitation: RoomInvitation
  inviterSk: Uint8Array
  roomSecret: Uint8Array
  /** Root-to-this-responder chain. Empty/absent only on the creator. */
  delegation?: InvitationDelegation[]
  now?: () => number
  onAdmitted?: (device: string) => void
  /** Called when the creator's durable retirement tombstone is heard. */
  onRetired?: () => void
}

export interface EncodeInvitationRetirementOptions {
  invitation: RoomInvitation
  /** Only the root inviter may retire a link. Delegates never receive this
   * key, which stops one room member disabling admission for everybody. */
  inviterSk: Uint8Array
  now: number
}

/** Make a permanent tombstone for one invitation rendezvous. */
export function encodeInvitationRetirement(opts: EncodeInvitationRetirementOptions): Event {
  require32(opts.inviterSk, 'inviter secret key')
  if (!hexEquals(getPublicKey(opts.inviterSk), opts.invitation.inviter)) {
    throw new Error('only the root inviter can retire an invitation')
  }
  return finalizeEvent(
    {
      kind: KINDS.INVITATION_RETIREMENT,
      created_at: opts.now,
      tags: [['d', deriveInvitationId(opts.invitation)]],
      content: JSON.stringify({ v: 1 }),
    },
    opts.inviterSk,
  )
}

/** A valid tombstone never expires: invitation ids are random and unique,
 * and a retired bearer must not become usable again after a timeout. */
export function decodeInvitationRetirement(event: Event, invitation: RoomInvitation): boolean {
  try {
    if (event.kind !== KINDS.INVITATION_RETIREMENT) return false
    if (!verifyEventUncached(event)) return false
    if (!hexEquals(event.pubkey, invitation.inviter)) return false
    if (event.tags.find((tag) => tag[0] === 'd')?.[1] !== deriveInvitationId(invitation)) return false
    const body = JSON.parse(event.content) as { v?: unknown }
    return body.v === 1
  } catch {
    return false
  }
}

/**
 * Auto-admit anybody holding this link while this admitted member is online.
 *
 * Closing the returned handle stops this responder. People
 * already admitted necessarily retain the room secret they were given; link
 * rotation is not member revocation and the UI must never claim that it is.
 */
export function hostRoomInvitation(opts: HostRoomInvitationOptions): { close(): void } {
  require32(opts.roomSecret, 'room secret')
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const delegation = opts.delegation ?? []
  const authority = verifyInvitationDelegation(opts.invitation, delegation, now())
  if (authority === null || !hexEquals(getPublicKey(opts.inviterSk), authority)) {
    throw new Error('responder is not delegated for invitation')
  }
  if (delegation.length > 0 && !hexEquals(delegation[0]!.room, deriveRoom(opts.roomSecret).roomId)) {
    throw new Error('delegation names another room')
  }
  const responder = getPublicKey(opts.inviterSk)
  const invitationId = deriveInvitationId(opts.invitation)
  const answered = new Set<string>()
  let closed = false
  let unsubRequests = () => {}
  let unsubRetirement = () => {}
  const close = (): void => {
    if (closed) return
    closed = true
    unsubRequests()
    unsubRetirement()
  }

  // Subscribe to the durable tombstone before accepting requests. Real
  // relays replay stored regular events, so a responder returning from an
  // offline spell retires itself before it can keep an old link alive.
  unsubRetirement = opts.transport.subscribe(
    [{ kinds: [KINDS.INVITATION_RETIREMENT], '#d': [invitationId], authors: [opts.invitation.inviter] }],
    (event) => {
      if (!decodeInvitationRetirement(event, opts.invitation)) return
      close()
      opts.onRetired?.()
    },
  )
  if (closed) {
    unsubRetirement()
    return { close }
  }

  unsubRequests = opts.transport.subscribe(
    [{ kinds: [KINDS.INVITATION_REQUEST], '#d': [invitationId], '#p': [opts.invitation.inviter] }],
    (event) => {
      if (closed) return
      const request = decodeInvitationRequest(event, { invitation: opts.invitation, now: now() })
      // Some relays incorrectly retain and replay ephemeral requests. A newly
      // admitted delegate must not answer the request that admitted itself.
      if (!request || hexEquals(request.device, responder) || answered.has(request.request)) return
      answered.add(request.request)
      // A long-running public room must not grow this replay guard without
      // bound. Duplicate requests are harmless after eviction: they only
      // cause the same encrypted grant to be sent again.
      if (answered.size > 256) answered.delete(answered.values().next().value!)
      let grant: Event
      try {
        grant = encodeInvitationGrant({
          invitation: opts.invitation,
          inviterSk: opts.inviterSk,
          requester: request.device,
          request: request.request,
          roomSecret: opts.roomSecret,
          now: now(),
          delegation,
        })
      } catch {
        // Expired or maximum-depth authority is no authority. Subscription
        // callbacks must never throw and take the caller's relay loop down.
        close()
        return
      }
      opts.transport.publish(grant).catch(() => {})
      opts.onAdmitted?.(request.device)
    },
  )
  return { close }
}

export interface RequestRoomAdmissionOptions {
  transport: RelayTransport
  invitation: RoomInvitation
  requesterSk?: Uint8Array
  now?: () => number
  timeoutMs?: number
  retryMs?: number
}

/** Resolve the room and a bounded responder delegation, with no account or
 * prompt. Retaining the delegation is what removes the creator as an
 * availability dependency for the next arrival. */
export function requestRoomAdmissionCapability(opts: RequestRoomAdmissionOptions): Promise<RoomAdmission> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const requesterSk = opts.requesterSk ?? generateSecretKey()
  const requester = getPublicKey(requesterSk)
  const request = encodeInvitationRequest({ invitation: opts.invitation, requesterSk, now: now() })

  return new Promise<RoomAdmission>((resolve, reject) => {
    let settled = false
    let retry: ReturnType<typeof setInterval> | undefined
    let expiry: ReturnType<typeof setTimeout> | undefined
    const invitationId = deriveInvitationId(opts.invitation)

    let unsub = () => {}
    unsub = opts.transport.subscribe(
      [
        { kinds: [KINDS.INVITATION_GRANT], '#d': [invitationId], '#p': [requester] },
        { kinds: [KINDS.INVITATION_RETIREMENT], '#d': [invitationId], authors: [opts.invitation.inviter] },
      ],
      (event) => {
        if (decodeInvitationRetirement(event, opts.invitation)) {
          finish(() => reject(new Error('this room invitation has been retired')))
          return
        }
        const admission = decodeRoomAdmissionGrant(event, {
          invitation: opts.invitation,
          requesterSk,
          request: request.id,
          now: now(),
        })
        if (admission) finish(() => resolve(admission))
      },
    )
    if (settled) unsub()

    function finish(settle: () => void): void {
      if (settled) return
      settled = true
      if (retry !== undefined) clearInterval(retry)
      if (expiry !== undefined) clearTimeout(expiry)
      unsub()
      settle()
    }

    function ask(): void {
      if (!settled) opts.transport.publish(request).catch(() => {})
    }

    expiry = setTimeout(
      () => finish(() => reject(new Error('the room is not answering this invitation'))),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    retry = setInterval(ask, opts.retryMs ?? DEFAULT_RETRY_MS)
    ask()
  })
}

/** Compatibility wrapper for non-interactive consumers. It joins correctly,
 * but discards the ability to keep the link available for somebody else. */
export async function requestRoomAdmission(opts: RequestRoomAdmissionOptions): Promise<Uint8Array> {
  return (await requestRoomAdmissionCapability(opts)).secret
}
