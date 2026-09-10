/**
 * Read the Bothy claim/status chain before using a box's advertised endpoint.
 * NIP-BOTHY V1/V2: the signed contact card pins the node, Link id and exact
 * claim; the box's signed status must endorse that same claim. Link transport
 * hints are never message endpoints. This module makes no network requests.
 */
import type { Event } from 'nostr-tools/pure'
import { base32, base64, base64url } from '@scure/base'
import { bytesToHex } from '@noble/hashes/utils'
import { verifyLinkCard, type LinkCard } from 'nostr-contact-card'
import { verifyEventUncached } from './verify.js'

const HEX = /^[0-9a-f]{64}$/
const GIB = 1024n ** 3n
export const BOX_STATUS_MAX_AGE = 3 * 3600
const bytes = (s: string) => new TextEncoder().encode(s).length
const requireThat = (ok: unknown, reason: string): void => { if (!ok) throw new Error(reason) }

export interface BoxPin {
  p: string
  claim: string
  nodeId: string
  highestSerial: number
  /** Only byte-identical announcements may reuse an already accepted serial. */
  card?: string
  statusCreatedAt?: number
  statusId?: string
}
export interface VerifiedBoxStatus {
  id: string
  createdAt: number
  validUntil: number
  master: string
  card: string
  link: LinkCard
  drops: boolean
  dropsUrl?: string
}
export type BoxStatusResult = { ok: true; status: VerifiedBoxStatus } | { ok: false; reason: string }

function event(value: unknown, kind: number): Event {
  requireThat(value && typeof value === 'object', 'missing signed event')
  const e = value as Event
  requireThat(e.kind === kind && HEX.test(e.id) && HEX.test(e.pubkey) && typeof e.content === 'string', 'event shape')
  requireThat(Number.isSafeInteger(e.created_at) && e.created_at >= 0, 'event time')
  requireThat(Array.isArray(e.tags) && e.tags.length <= 128 && e.tags.every(t => Array.isArray(t) && t.length > 0 && t.length <= 16 && t.every(v => typeof v === 'string' && bytes(v) <= 8192)), 'event tags')
  requireThat(bytes(JSON.stringify(e)) <= 32768, 'event too large')
  requireThat(verifyEventUncached(e), 'event signature')
  return e
}
function tag(e: Event, key: string, required = true): string[] | undefined {
  const tags = e.tags.filter(t => t[0] === key)
  requireThat(tags.length <= 1 && (!required || tags.length === 1), `${key} must occur ${required ? 'exactly' : 'at most'} once`)
  return tags[0]
}
function value(e: Event, key: string, required = true): string | undefined {
  const t = tag(e, key, required)
  if (!t) return undefined
  requireThat(t.length === 2, `${key} shape`)
  return t[1]!
}
function uint(s: string | undefined): bigint {
  requireThat(s !== undefined && /^(0|[1-9][0-9]*)$/.test(s) && s.length <= 20, 'unsigned integer shape')
  const n = BigInt(s!)
  requireThat(n <= 18446744073709551615n, 'unsigned integer overflow')
  return n
}
function oneOf(s: string | undefined, allowed: string[], name: string): void {
  requireThat(s !== undefined && allowed.includes(s), `${name} value`)
}
function list(e: Event, name: string, allowed: string[], required = true): void {
  const t = tag(e, name, required)
  if (!t) return
  const values = t.slice(1)
  requireThat(values.length >= 1 && values.length <= allowed.length && new Set(values).size === values.length && values.every(v => allowed.includes(v)), `${name} values`)
}
function decodeCard(encoded: string): Uint8Array {
  requireThat(encoded.length <= 5464 && /^[A-Za-z0-9+/_-]*={0,2}$/.test(encoded), 'card encoding')
  const raw = encoded.replace(/=+$/, '')
  const padded = raw + '='.repeat((4 - raw.length % 4) % 4)
  return /[-_]/.test(raw) ? base64url.decode(padded) : base64.decode(padded)
}
function endpoint(s: string): string {
  requireThat(bytes(s) <= 256 && s.startsWith('wss://') && !/[\s\p{C}]|[@#]/u.test(s), 'drops endpoint')
  const url = new URL(s)
  requireThat(url.hostname && !url.username && !url.password && !url.hash, 'drops endpoint')
  return url.href
}

export interface VerifiedBoxClaim {
  id: string
  node: string
  master: string
  createdAt: number
  state: 'active' | 'retired'
}

/** Verify authority before considering a claim update or retirement. Stored
 * monotonicity and terminal retirement are enforced by the discovery book. */
export function readBoxClaim(raw: unknown, now: number): { ok: true; claim: VerifiedBoxClaim } | { ok: false; reason: string } {
  try {
    requireThat(Number.isSafeInteger(now) && now >= 0, 'clock')
    const c = event(raw, 30640)
    const node = value(c, 'd')!
    requireThat(HEX.test(node), 'claim node')
    requireThat(c.content === '' && c.created_at <= now + 300, 'claim content or time')
    oneOf(value(c, 'role'), ['phone', 'box'], 'role')
    const state = value(c, 'status')!
    oneOf(state, ['active', 'retired'], 'claim status')
    const allowed = new Set(['d', 'p', 'role', 'status', 'region', 'name', 'alt'])
    requireThat(c.tags.every(t => allowed.has(t[0]!)), 'unknown claim tag')
    const people = c.tags.filter(t => t[0] === 'p')
    requireThat(people.every(t => t.length === 4 && HEX.test(t[1]!) && ['node', 'master', 'stash', 'persona'].includes(t[3]!)), 'claim keys')
    requireThat(new Set(people.map(t => t[1])).size === people.length, 'duplicate claim key')
    for (const role of ['node', 'master']) requireThat(people.filter(t => t[3] === role).length === 1, `claim ${role} key`)
    requireThat(people.find(t => t[3] === 'node')![1] === node && people.find(t => t[3] === 'master')![1] === c.pubkey, 'claim key binding')
    for (const [key, max] of [['region', 64], ['name', 32]] as const) {
      const s = value(c, key, false); if (s !== undefined) requireThat(bytes(s) <= max, `claim ${key} too long`)
    }
    value(c, 'alt', false)
    requireThat(state === 'active' ? people.filter(t => t[3] === 'stash').length === 1 : people.every(t => t[3] !== 'stash' && t[3] !== 'persona'), 'claim stash or retirement')

    return { ok: true, claim: { id: c.id, node, master: c.pubkey, createdAt: c.created_at, state: state as 'active' | 'retired' } }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'invalid box claim' }
  }
}

/** Reject stale, malformed, revoked, substituted and replayed discovery data. */
export function readBoxStatus(rawStatus: unknown, rawClaim: unknown, pin: BoxPin, now: number): BoxStatusResult {
  try {
    requireThat(Number.isSafeInteger(now) && now >= 0, 'clock')
    requireThat(HEX.test(pin.p) && HEX.test(pin.claim) && HEX.test(pin.nodeId) && Number.isSafeInteger(pin.highestSerial) && pin.highestSerial >= 0, 'box pin')
    const c = event(rawClaim, 30640)
    const accepted = readBoxClaim(c, now)
    requireThat(accepted.ok, accepted.ok ? '' : accepted.reason)
    if (!accepted.ok) throw new Error('claim')
    requireThat(accepted.claim.id === pin.claim && accepted.claim.node === pin.p, 'claim is not the contact-endorsed claim')
    requireThat(accepted.claim.state === 'active', 'claim is not active')

    const s = event(rawStatus, 10640)
    requireThat(s.pubkey === pin.p && value(s, 'claim') === c.id, 'status claim binding')
    requireThat(s.content === '' && s.created_at <= now + 300 && s.created_at > now - BOX_STATUS_MAX_AGE, 'status is stale or has invalid time/content')
    if (pin.statusCreatedAt !== undefined) requireThat(s.created_at > pin.statusCreatedAt || (s.created_at === pin.statusCreatedAt && s.id === pin.statusId), 'status replay')
    const node = value(s, 'node')!
    requireThat(/^[a-z2-7]{52}$/.test(node), 'node encoding')
    const nodeBytes = base32.decode(node.toUpperCase() + '====')
    requireThat(base32.encode(nodeBytes).replace(/=+$/, '').toLowerCase() === node && bytesToHex(nodeBytes) === pin.nodeId, 'node pin mismatch')
    const card = decodeCard(value(s, 'card')!)
    const canonicalCard = base64.encode(card)
    const sameCard = pin.card !== undefined && canonicalCard === base64.encode(decodeCard(pin.card))
    const link = verifyLinkCard(card, now, sameCard ? pin.highestSerial - 1 : pin.highestSerial)
    requireThat(link.ok, link.ok ? '' : `Link card: ${link.reason}`)
    if (!link.ok) throw new Error('Link card')
    requireThat(link.card.nodeId === pin.nodeId && uint(value(s, 'card-exp')) === BigInt(link.card.expiresAt), 'card binding')
    const free = uint(value(s, 'free')), pool = uint(value(s, 'pool'))
    requireThat(free <= pool && free % GIB === 0n && pool % GIB === 0n, 'capacity rounding')
    uint(value(s, 'max-blob'))
    list(s, 'classes', ['working', 'circle', 'vital', 'open'])
    oneOf(value(s, 'charge-control'), ['internal', 'external-plug', 'none', 'mains'], 'charge control')
    oneOf(value(s, 'policy'), ['introductions', 'open'], 'policy')
    const sheltered = tag(s, 'sheltered')!
    requireThat(sheltered.length === 3 && uint(sheltered[1]) % GIB === 0n && uint(sheltered[2]) % 100n === 0n, 'sheltered aggregates')
    const bridge = value(s, 'bridge', false)
    if (bridge !== undefined) requireThat(new URL(bridge).protocol === 'https:', 'bridge scheme')
    const lan = value(s, 'lan', false)
    if (lan !== undefined) requireThat(bytes(lan) > 0 && bytes(lan) <= 63, 'lan shape')
    value(s, 'alt', false)
    const software = tag(s, 'software', false)
    if (software) requireThat(software.length === 3 && bytes(software[1]!) > 0 && bytes(software[1]!) <= 64 && /^(unknown|[0-9a-f]{40})$/.test(software[2]!), 'software shape')
    const canary = tag(s, 'canary', false)
    if (canary) requireThat(canary.length === 3 && uint(canary[1]) <= BigInt(s.created_at) && uint(canary[2]) <= 366n * 86400n, 'canary shape')
    list(s, 'carriers', ['link', 'tor', 'i2p'], false)
    const relaying = value(s, 'relaying', false)
    if (relaying !== undefined) oneOf(relaying, ['on', 'off'], 'relaying')
    const retention = tag(s, 'retention', false)
    if (retention) requireThat(retention.length === 4 && retention.slice(1).every(v => /^(blobs|drops|logs)=[a-z0-9-]{1,32}$/.test(v)) && new Set(retention.slice(1).map(v => v.split('=')[0])).size === 3, 'retention shape')
    const drops = tag(s, 'drops', false)
    let dropsUrl: string | undefined
    if (drops) {
      oneOf(drops[1], ['on', 'off'], 'drops')
      requireThat(drops.length === 2 || (drops.length === 3 && drops[1] === 'on'), 'drops shape')
      if (drops.length === 3) dropsUrl = endpoint(drops[2]!)
    }
    const expiration = value(s, 'expiration', false)
    const validUntil = Math.min(s.created_at + BOX_STATUS_MAX_AGE, link.card.expiresAt,
      expiration === undefined ? Infinity : Number(uint(expiration)))
    requireThat(validUntil > now, 'status expired')
    return { ok: true, status: { id: s.id, createdAt: s.created_at, validUntil, master: c.pubkey, card: canonicalCard, link: link.card, drops: drops?.[1] === 'on', ...(dropsUrl ? { dropsUrl } : {}) } }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'invalid box status' }
  }
}
