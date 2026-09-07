import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'
import { KINDS } from './kinds.js'
import { verifyEventUncached } from './verify.js'

/** Reserved M2 codecs. No running service requires or publishes these events. */
export const MEMBER_PASS_KIND = KINDS.MEMBER_PASS
export const SERVICE_POLICY_KIND = KINDS.SERVICE_POLICY
export type ServiceType = 'forwarder' | 'turn' | 'blossom' | 'nudger'
export interface ServiceAudience { type: ServiceType; id: string }
export type ServicePermission = 'relay' | 'credentials' | 'upload' | 'notify'
export interface MemberPass {
  v: 1
  audience: ServiceAudience
  room: string
  device: string
  epoch: number
  expiresAt: number
  permissions: ServicePermission[]
}
export interface ServicePolicy {
  v: 1
  audience: ServiceAudience
  room: string
  enforcementEpoch: number
  activateAt: number
  graceEnd: number
}
const HEX = /^[0-9a-f]{64}$/
const permissions = new Set(['relay', 'credentials', 'upload', 'notify'])
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
export function normaliseServiceAudience(raw: unknown): ServiceAudience | null {
  if (!record(raw) || typeof raw.type !== 'string' || !['forwarder', 'turn', 'blossom', 'nudger'].includes(raw.type) || typeof raw.id !== 'string' || raw.id.length > 2048) return null
  if (raw.type === 'forwarder') return HEX.test(raw.id) ? { type: 'forwarder', id: raw.id } : null
  try {
    const url = new URL(raw.id)
    if (url.protocol !== 'https:' || url.username || url.password || /[?#\s\\]/.test(raw.id) || /%(?![0-9a-f]{2})/i.test(raw.id)) return null
    // Keep the independent JVM and WHATWG URL readers on the same ASCII
    // authority grammar. Unicode domains use their lower-case A-label form.
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.?$/.test(url.hostname) && !/^\[[0-9a-f:]+\]$/.test(url.hostname)) return null
    const canonical = raw.type === 'nudger' ? url.href : url.origin
    if (raw.id !== canonical) return null
    return { type: raw.type as ServiceType, id: canonical }
  } catch { return null }
}
function memberPass(raw: unknown): MemberPass | null {
  if (!record(raw) || raw.v !== 1 || typeof raw.room !== 'string' || !HEX.test(raw.room) || typeof raw.device !== 'string' || !HEX.test(raw.device)) return null
  const audience = normaliseServiceAudience(raw.audience)
  if (!audience || !integer(raw.epoch) || !integer(raw.expiresAt) || !Array.isArray(raw.permissions) || raw.permissions.length < 1 || raw.permissions.length > 4) return null
  if (!raw.permissions.every(p => typeof p === 'string' && permissions.has(p)) || new Set(raw.permissions).size !== raw.permissions.length) return null
  return { v: 1, audience, room: raw.room, device: raw.device, epoch: raw.epoch, expiresAt: raw.expiresAt, permissions: [...raw.permissions].sort() as ServicePermission[] }
}
function servicePolicy(raw: unknown): ServicePolicy | null {
  if (!record(raw) || raw.v !== 1 || typeof raw.room !== 'string' || !HEX.test(raw.room)) return null
  const audience = normaliseServiceAudience(raw.audience)
  if (!audience || !integer(raw.enforcementEpoch) || !integer(raw.activateAt) || !integer(raw.graceEnd) || raw.graceEnd < raw.activateAt) return null
  return { v: 1, audience, room: raw.room, enforcementEpoch: raw.enforcementEpoch, activateAt: raw.activateAt, graceEnd: raw.graceEnd }
}
function singleTag(event: Event, name: string, value: string): boolean {
  const tags = event.tags.filter(t => t[0] === name)
  return tags.length === 1 && tags[0]?.length === 2 && tags[0]?.[1] === value
}
function payload(event: Event, kind: number): unknown {
  if (event.kind !== kind || typeof event.content !== 'string' || event.content.length > 4096 || event.tags.length > 8 || !integer(event.created_at) || !verifyEventUncached(event)) return null
  return JSON.parse(event.content)
}
export function decodeMemberPass(event: Event): MemberPass | null {
  try {
    const pass = memberPass(payload(event, MEMBER_PASS_KIND))
    return pass && pass.expiresAt > event.created_at && singleTag(event, 'd', pass.room) && singleTag(event, 'p', pass.device) && singleTag(event, 'expiration', String(pass.expiresAt)) ? pass : null
  } catch { return null }
}
export function decodeServicePolicy(event: Event): ServicePolicy | null {
  try {
    const policy = servicePolicy(payload(event, SERVICE_POLICY_KIND))
    return policy && singleTag(event, 'd', policy.room) ? policy : null
  } catch { return null }
}
export function encodeMemberPass(raw: MemberPass, authoritySk: Uint8Array, now: number): Event {
  const pass = memberPass(raw)
  if (!pass || !integer(now) || pass.expiresAt <= now) throw new Error('Invalid member pass')
  return finalizeEvent({ kind: MEMBER_PASS_KIND, created_at: now, tags: [['d', pass.room], ['p', pass.device], ['expiration', String(pass.expiresAt)]], content: JSON.stringify(pass) }, authoritySk)
}
export function encodeServicePolicy(raw: ServicePolicy, authoritySk: Uint8Array, now: number): Event {
  const policy = servicePolicy(raw)
  if (!policy || !integer(now)) throw new Error('Invalid service policy')
  return finalizeEvent({ kind: SERVICE_POLICY_KIND, created_at: now, tags: [['d', policy.room]], content: JSON.stringify(policy) }, authoritySk)
}

/** HKDF labels separate rooms, audiences and roles. Only the owner of a root
 * secret can derive its scoped keys; a presented pass contains no parent link.
 * The authority supplies authoritySk, a device supplies deviceSk. Never use the
 * shared traffic secret to derive the authority's signing key. */
export function deriveServiceKey(secret: Uint8Array, roomId: string, audience: ServiceAudience, role: 'authority' | 'device'): Uint8Array {
  if (secret.length !== 32 || !HEX.test(roomId) || !normaliseServiceAudience(audience) || !['authority', 'device'].includes(role)) throw new Error('Invalid service key scope')
  if (role === 'device' && audience.type === 'forwarder') { getPublicKey(secret); return secret.slice() }
  for (let counter = 0; counter < 256; counter++) {
    const info = JSON.stringify(['kithmoot.service.v1', role, roomId, audience.type, audience.id, counter])
    const key = hkdf(sha256, secret, undefined, info, 32)
    try { getPublicKey(key); return key } catch { /* Reject zero/out-of-range scalar deterministically. */ }
  }
  throw new Error('Could not derive a service key')
}
export function deriveServiceRoom(roomSecret: Uint8Array, roomId: string, audience: ServiceAudience): string {
  if (roomSecret.length !== 32 || !HEX.test(roomId) || !normaliseServiceAudience(audience)) throw new Error('Invalid service room scope')
  // The forwarder is already a signalling peer; the nudger must watch room events.
  if (audience.type === 'forwarder' || audience.type === 'nudger') return roomId
  return bytesToHex(hkdf(sha256, roomSecret, undefined, JSON.stringify(['kithmoot.service.v1', 'room', roomId, audience.type, audience.id]), 32))
}
