import { bytesToHex } from '@noble/hashes/utils'
import { base64urlnopad } from '@scure/base'
import { getPublicKey } from 'nostr-tools/pure'

/** Vennel §3.2's only allowed root-child purpose. */
export const RENDEZVOUS_PURPOSE = 'rendezvous'
export const RENDEZVOUS_PROVISION_MAX_SECONDS = 10 * 60
const FIELDS = ['v', 'p', 'd', 'rz', 'u', 'i', 'n', 'e', 'k']
const HEX64 = /^[0-9a-f]{64}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/

export interface RendezvousProvisionExpect {
  identity: string
  device: string
  nonce: Uint8Array
  now: number
}

/** A decrypted root child. Store it in the device vault, then call wipe(). */
export interface RendezvousProvision {
  index: number
  expiresAt: number
  scalar: Uint8Array
  wipe(): void
}

export type RendezvousProvisionResult =
  | { ok: true; provision: RendezvousProvision }
  | { ok: false; reason: string }

/**
 * Verify an already NIP-44-decrypted Vennel provision record. This function
 * deliberately does not decrypt, transport or persist: those remain bound to
 * the approved person-device pairing ceremony, never contact storage.
 */
export function readRendezvousProvision(text: string, expect: RendezvousProvisionExpect): RendezvousProvisionResult {
  if (text.length > 1024) return { ok: false, reason: 'size' }
  let value: unknown
  try { value = JSON.parse(text) } catch { return { ok: false, reason: 'json' } }
  if (!isRecord(value) || Object.keys(value).join(',') !== FIELDS.join(',')) return { ok: false, reason: 'fields' }
  if (JSON.stringify(value) !== text) return { ok: false, reason: 'canonical' }
  if (value.v !== 1) return { ok: false, reason: 'version' }
  if (!hex(value.p) || !hex(value.d) || !hex(value.rz)) return { ok: false, reason: 'pubkey' }
  if (value.u !== RENDEZVOUS_PURPOSE) return { ok: false, reason: 'purpose' }
  if (!index(value.i)) return { ok: false, reason: 'index' }
  const expiresAt = value.e
  if (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt) || expiresAt <= expect.now) return { ok: false, reason: 'expired' }
  if (expiresAt - expect.now > RENDEZVOUS_PROVISION_MAX_SECONDS) return { ok: false, reason: 'expiry window' }
  const nonce = decodeBase64Url(value.n)
  if (!nonce || nonce.length !== 16 || bytesToHex(nonce) !== bytesToHex(expect.nonce)) return { ok: false, reason: 'nonce' }
  const scalar = decodeBase64Url(value.k)
  if (!scalar || scalar.length !== 32) return { ok: false, reason: 'scalar' }
  if (value.p !== expect.identity) { scalar.fill(0); return { ok: false, reason: 'identity' } }
  if (value.d !== expect.device) { scalar.fill(0); return { ok: false, reason: 'device' } }
  try {
    if (getPublicKey(scalar) !== value.rz) { scalar.fill(0); return { ok: false, reason: 'rendezvous key' } }
  } catch {
    scalar.fill(0)
    return { ok: false, reason: 'scalar' }
  }
  return { ok: true, provision: { index: value.i, expiresAt, scalar, wipe: () => scalar.fill(0) } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hex(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value)
}

function index(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff
}

function decodeBase64Url(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !BASE64URL.test(value)) return null
  try {
    const bytes = base64urlnopad.decode(value)
    return base64urlnopad.encode(bytes) === value ? bytes : null
  } catch {
    return null
  }
}
