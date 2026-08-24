import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, randomBytes } from '@noble/hashes/utils'
import { KINDS } from './kinds.js'
import { createDeviceCredential, verifyDeviceCredential } from './credential.js'
import { verifyEventUncached } from './verify.js'
import type { RelayTransport } from './relay-pool.js'
import type { DeviceCredential } from './types.js'

/**
 * Adding a second device to a participant, without the participant key ever
 * leaving the first one.
 *
 * The exchange is two steps, because a credential names the device it
 * authorises and the primary device cannot know the second device's pubkey
 * until the second device tells it:
 *
 *   1. The primary generates a one-off **pairing code** and puts it in a
 *      link, alongside the room secret. The link is a room capability plus a
 *      code - never an identity.
 *   2. The secondary generates its own keypair and publishes a **pairing
 *      request** on the room-key channel, naming its pubkey and proving it
 *      holds the code.
 *   3. The primary sees the request, checks the proof, optionally asks the
 *      person, and publishes a **pairing grant**: a room-scoped, expiring
 *      device credential for that pubkey.
 *   4. The secondary joins with its own key plus that credential.
 *
 * What the code proves. Everyone in the room holds the room key, so anyone
 * can read the request and publish one of their own. The request therefore
 * carries `sha256(domain : code : roomId : device)` rather than the code
 * itself: a member who intercepts it learns a hash over somebody else's
 * device pubkey and cannot produce the equivalent for their own. Whoever
 * holds the link can pair - that is what the link is for - and what they get
 * is a credential for one room that expires, not the participant key.
 *
 * Both kinds are ephemeral. This is a live handshake between two devices
 * that are both present; a stored request or grant is only a durable record
 * that the room exists.
 */

const PROOF_DOMAIN = 'kithmoot/v1/pairing'
const DEFAULT_TTL_SECONDS = 12 * 60 * 60
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_RETRY_MS = 2_000

/** A one-off 16-byte pairing code, carried in the pairing link. */
export function createPairingCode(): Uint8Array {
  return randomBytes(16)
}

function pairingProof(code: Uint8Array, roomId: string, device: string): string {
  const message = `${PROOF_DOMAIN}:${bytesToHex(code)}:${roomId}:${device}`
  return bytesToHex(sha256(new TextEncoder().encode(message)))
}

interface PairingRequestBody {
  device: string
  proof: string
}

export interface EncodePairingRequestOptions {
  code: Uint8Array
  roomId: string
  roomKey: Uint8Array
  /** The secondary device's own secret key. */
  deviceSk: Uint8Array
  /** Unix seconds. */
  now: number
}

export function encodePairingRequest(opts: EncodePairingRequestOptions): Event {
  const device = getPublicKey(opts.deviceSk)
  const body: PairingRequestBody = { device, proof: pairingProof(opts.code, opts.roomId, device) }
  return finalizeEvent(
    {
      kind: KINDS.PAIRING_REQUEST,
      created_at: opts.now,
      tags: [['d', opts.roomId]],
      content: nip44.v2.encrypt(JSON.stringify(body), opts.roomKey),
    },
    opts.deviceSk,
  )
}

export interface DecodePairingRequestOptions {
  code: Uint8Array
  roomId: string
  roomKey: Uint8Array
}

/** Returns the requesting device's pubkey, or null for anything that does
 *  not check out. Never throws - it runs inside a subscription handler. */
export function decodePairingRequest(
  event: Event,
  opts: DecodePairingRequestOptions,
): { device: string } | null {
  try {
    if (event.kind !== KINDS.PAIRING_REQUEST) return null
    if (event.tags.find((t) => t[0] === 'd')?.[1] !== opts.roomId) return null
    if (!verifyEventUncached(event)) return null

    const body = JSON.parse(nip44.v2.decrypt(event.content, opts.roomKey)) as PairingRequestBody
    if (typeof body.device !== 'string' || typeof body.proof !== 'string') return null
    // The device asking must be the device that signed the ask, so a member
    // cannot request a credential on somebody else's behalf.
    if (body.device !== event.pubkey) return null
    if (body.proof !== pairingProof(opts.code, opts.roomId, body.device)) return null

    return { device: body.device }
  } catch {
    return null
  }
}

export interface EncodePairingGrantOptions {
  roomId: string
  roomKey: Uint8Array
  /** The primary device's own secret key - it signs the envelope. The
   *  credential inside is signed by the participant key, which is the only
   *  signature that carries any authority. */
  deviceSk: Uint8Array
}

export function encodePairingGrant(
  credential: DeviceCredential,
  opts: EncodePairingGrantOptions,
): Event {
  const device = credential.tags.find((t) => t[0] === 'device')?.[1] ?? ''
  return finalizeEvent(
    {
      kind: KINDS.PAIRING_GRANT,
      created_at: Number(credential.created_at),
      // `p` names the device this grant is for. Its pubkey is already on the
      // wire as the signer of the request it answers, so this reveals
      // nothing new and saves every other device decrypting the envelope.
      tags: [
        ['d', opts.roomId],
        ['p', device],
      ],
      content: nip44.v2.encrypt(JSON.stringify({ credential }), opts.roomKey),
    },
    opts.deviceSk,
  )
}

export interface DecodePairingGrantOptions {
  roomId: string
  roomKey: Uint8Array
  /** Our own device pubkey - the credential must name it. */
  device: string
  /** Unix seconds. */
  now: number
}

/**
 * Returns the credential a grant carries, or null.
 *
 * Who signed the envelope is deliberately not checked: the credential's own
 * signature by the participant key is the whole authority, so a grant
 * relayed by any device is exactly as good as one from the primary.
 */
export function decodePairingGrant(
  event: Event,
  opts: DecodePairingGrantOptions,
): DeviceCredential | null {
  try {
    if (event.kind !== KINDS.PAIRING_GRANT) return null
    if (event.tags.find((t) => t[0] === 'd')?.[1] !== opts.roomId) return null
    if (!verifyEventUncached(event)) return null

    const body = JSON.parse(nip44.v2.decrypt(event.content, opts.roomKey)) as {
      credential?: DeviceCredential
    }
    const credential = body.credential
    if (typeof credential !== 'object' || credential === null) return null

    const verdict = verifyDeviceCredential(credential, { roomId: opts.roomId, now: opts.now })
    if (!verdict.ok) return null
    if (verdict.device !== opts.device) return null

    return credential
  } catch {
    return null
  }
}

export interface HostPairingOptions {
  transport: RelayTransport
  roomId: string
  roomKey: Uint8Array
  code: Uint8Array
  /** The participant key. It never leaves this device - it only signs. */
  participantSk: Uint8Array
  /** This device's own key, which signs the grant envelope. */
  deviceSk: Uint8Array
  /** How long the issued credential lives. */
  ttlSeconds?: number
  now?: () => number
  /** Last word before a credential is minted, so the person can see which
   *  device is asking. Defaults to accepting anything that knows the code. */
  approve?: (device: string) => boolean
  onPaired?: (device: string) => void
}

/**
 * Answer pairing requests carrying `code` with a device credential.
 *
 * Stays open until closed, and answers a repeat request from the same device
 * again: a grant is ephemeral, so a secondary that missed the first one has
 * no other way to recover. Closing the host is what retires the code.
 */
export function hostPairing(opts: HostPairingOptions): { close(): void } {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const unsub = opts.transport.subscribe(
    [{ kinds: [KINDS.PAIRING_REQUEST], '#d': [opts.roomId] }],
    (event) => {
      const request = decodePairingRequest(event, {
        code: opts.code,
        roomId: opts.roomId,
        roomKey: opts.roomKey,
      })
      if (!request) return
      if (opts.approve && !opts.approve(request.device)) return

      const credential = createDeviceCredential({
        participantSk: opts.participantSk,
        devicePubkey: request.device,
        roomId: opts.roomId,
        expiresAt: now() + (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS),
      })
      const grant = encodePairingGrant(credential, {
        roomId: opts.roomId,
        roomKey: opts.roomKey,
        deviceSk: opts.deviceSk,
      })
      opts.transport.publish(grant).catch(() => {})
      opts.onPaired?.(request.device)
    },
  )

  return { close: unsub }
}

export interface RequestPairingOptions {
  transport: RelayTransport
  roomId: string
  roomKey: Uint8Array
  code: Uint8Array
  /** This device's own key. Generated here, never transferred. */
  deviceSk: Uint8Array
  now?: () => number
  timeoutMs?: number
  retryMs?: number
}

/**
 * Ask the primary device for a credential, and resolve with it.
 *
 * Requests are re-sent until a grant arrives or the timeout expires: both
 * kinds are ephemeral, so a request published before the primary was
 * listening is simply gone, and one retry loop is cheaper than a handshake.
 */
export function requestPairing(opts: RequestPairingOptions): Promise<DeviceCredential> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const device = getPublicKey(opts.deviceSk)

  return new Promise<DeviceCredential>((resolve, reject) => {
    let settled = false
    let retry: ReturnType<typeof setInterval> | undefined
    let expiry: ReturnType<typeof setTimeout> | undefined

    const unsub = opts.transport.subscribe(
      [{ kinds: [KINDS.PAIRING_GRANT], '#d': [opts.roomId], '#p': [device] }],
      (event) => {
        const credential = decodePairingGrant(event, {
          roomId: opts.roomId,
          roomKey: opts.roomKey,
          device,
          now: now(),
        })
        if (!credential) return
        finish(() => resolve(credential))
      },
    )

    function finish(settle: () => void): void {
      if (settled) return
      settled = true
      if (retry !== undefined) clearInterval(retry)
      if (expiry !== undefined) clearTimeout(expiry)
      unsub()
      settle()
    }

    function ask(): void {
      if (settled) return
      const event = encodePairingRequest({
        code: opts.code,
        roomId: opts.roomId,
        roomKey: opts.roomKey,
        deviceSk: opts.deviceSk,
        now: now(),
      })
      opts.transport.publish(event).catch(() => {})
    }

    expiry = setTimeout(
      () => finish(() => reject(new Error('pairing timed out'))),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    retry = setInterval(ask, opts.retryMs ?? DEFAULT_RETRY_MS)
    ask()
  })
}
