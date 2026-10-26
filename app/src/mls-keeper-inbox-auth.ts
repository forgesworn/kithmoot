/** Deposit-only device AUTH. Validating this permission does not establish
 * that its issuer remains a keeper; the destination node decides that. */
import { base32 } from '@scure/base'
import { hexToBytes } from '@noble/hashes/utils.js'
import { verifyEvent, type Event } from 'nostr-tools/pure'
import type { ConsentDecision } from './mls-vault.js'

const HEX = /^[0-9a-f]{64}(?![\s\S])/
const GRANT = /^[0-9a-f]{32}(?![\s\S])/
const SIGNATURE = /^[0-9a-f]{128}(?![\s\S])/
export interface KeeperInboxAuthRequest { v: 1; box: string; keeper: string; permission: Event; challenge: string; expires_at: number }
export interface KeeperInboxAuthReply { readonly v: 1; readonly device: string; readonly event: Event }
export interface KeeperInboxAuthConsent {
  readonly purpose: 'keeper-inbox-deposit-auth'
  readonly principal: string
  readonly persona: string
  readonly device: string
  readonly box: string
  readonly keeper: string
  readonly grant: string
  readonly destination: string
  readonly permissionId: string
  readonly deadline: number
  readonly current: () => boolean
}
export type KeeperInboxAuthPrompt = (operation: KeeperInboxAuthConsent) => Promise<ConsentDecision>
export const keeperInboxAuthKey = (r: KeeperInboxAuthRequest) => JSON.stringify([r.v, r.box, r.keeper, r.permission, r.challenge, r.expires_at])
export const keeperInboxDestination = (box: string) => `ws://${base32.encode(hexToBytes(box)).replace(/=+$/, '').toLowerCase()}/events`
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const epoch = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0

/** Snapshot first, then verify without nostr-tools' caller-supplied verification
 * cache. The caller cannot select the relay, event body or signing timestamp. */
export function keeperInboxAuthRequest(value: unknown): KeeperInboxAuthRequest | undefined {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'box,challenge,expires_at,keeper,permission,v') return
  if (value.v !== 1 || typeof value.keeper !== 'string' || !HEX.test(value.keeper) || typeof value.box !== 'string' || !HEX.test(value.box) || typeof value.challenge !== 'string' || !HEX.test(value.challenge) || !epoch(value.expires_at)) return
  const p = value.permission
  if (!object(p) || Object.keys(p).sort().join(',') !== 'content,created_at,id,kind,pubkey,sig,tags') return
  if (p.pubkey !== value.keeper || p.kind !== 24242 || p.content !== '' || !epoch(p.created_at) || typeof p.id !== 'string' || !HEX.test(p.id) || typeof p.pubkey !== 'string' || !HEX.test(p.pubkey) || typeof p.sig !== 'string' || !SIGNATURE.test(p.sig)) return
  if (!Array.isArray(p.tags) || p.tags.length !== 6 || p.tags.some(t => !Array.isArray(t) || t.length !== 2 || t.some(v => typeof v !== 'string' || v.length > 128))) return
  const tags = p.tags.map(t => [...t] as string[])
  if (tags.map(t => t[0]).sort().join(',') !== 'device,expiration,grant,server,status,t') return
  const one = (name: string) => tags.find(t => t[0] === name)![1]!
  if (one('t') !== 'keeper-inbox-deposit' || one('status') !== 'active' || !HEX.test(one('device')) || !GRANT.test(one('grant')) || one('server') !== keeperInboxDestination(value.box)) return
  if (!/^(0|[1-9][0-9]*)$/.test(one('expiration')) || !epoch(Number(one('expiration')))) return
  const permission: Event = { kind: 24242, content: '', created_at: p.created_at, id: p.id, pubkey: p.pubkey, sig: p.sig, tags }
  try { if (!verifyEvent(permission)) return } catch { return }
  for (const tag of tags) Object.freeze(tag)
  Object.freeze(tags); Object.freeze(permission)
  return Object.freeze({ v: 1, box: value.box, keeper: value.keeper, challenge: value.challenge, expires_at: value.expires_at, permission })
}
export function keeperInboxPermissionLive(r: KeeperInboxAuthRequest, now: number): boolean {
  return keeperInboxPermissionCurrent(r, now) && r.expires_at > now && r.expires_at <= now + 120
}
export function keeperInboxPermissionCurrent(r: KeeperInboxAuthRequest, now: number): boolean {
  const expiration = keeperInboxPermissionExpiration(r)
  return epoch(now) && r.permission.created_at <= now + 300 && expiration > now && expiration <= now + 30 * 86400
}
export const keeperInboxPermissionExpiration = (r: KeeperInboxAuthRequest) => Number(r.permission.tags.find(t => t[0] === 'expiration')![1])
export const keeperInboxPermissionDevice = (r: KeeperInboxAuthRequest) => r.permission.tags.find(t => t[0] === 'device')![1]!
export const keeperInboxPermissionGrant = (r: KeeperInboxAuthRequest) => r.permission.tags.find(t => t[0] === 'grant')![1]!
