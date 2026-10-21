import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha2'
import { schnorr } from '@noble/curves/secp256k1.js'
import { storageNodeFromBase } from '@forgesworn/fold-kit'

/**
 * Group grants: kind 27541 events that a room's keeper signs with the room's
 * authority key so a group's own storage node serves only the devices the
 * keeper admitted. The contract is `docs/GROUP-GRANTS.md` in wildbloom-node,
 * profile `group-grants/1`; section numbers below are that document's.
 *
 * Pure: no I/O, no clock of its own, no keeper state. The keeper
 * (`group-grants-keeper.ts`) uses the builders, and every reader of the room's
 * control channel (a client, an agent, the Android app) can use the parser and
 * `GrantReceiver`. A grant event is never published on a relay; it travels in
 * the room's encrypted control channel and by HTTP POST to a node.
 */

/** The event kind. Ephemeral range; never sent to a relay (section 4.1). */
export const GROUP_GRANT_KIND = 27541

/** Longest a grant or reset may last after its `created_at`, seconds (4.4 rule 3). */
export const MAX_GRANT_SECONDS = 7_776_000
/** How far ahead of the verifier's clock `created_at` may be, seconds (4.4 rule 7). */
export const GRANT_FUTURE_SKEW_SECONDS = 30
/** The keeper's grant lifetime (decision O3), seconds. */
export const GRANT_LIFETIME_SECONDS = 30 * 86_400
/** A keeper renews when this little of a grant's life is left (O3), seconds. */
export const GRANT_RENEW_WITHIN_SECONDS = 10 * 86_400
/** The most an event may weigh as JSON, bytes (4.4 rule 1). */
export const MAX_GROUP_EVENT_BYTES = 16 * 1024
/** The most tags an event may carry. */
export const MAX_GROUP_EVENT_TAGS = 16

/** Every scope a grant may name (4.6), in the order they are written. */
export const GRANT_SCOPES = ['upload', 'get', 'delete', 'purge', 'turn', 'relay-read', 'relay-write'] as const
export type GrantScope = (typeof GRANT_SCOPES)[number]

/** What the keeper grants every admitted device (decision O5). */
export const KEEPER_SCOPES: readonly GrantScope[] = ['upload', 'get', 'delete']

export interface GroupEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export type GrantStatus = 'active' | 'revoked'

export interface ParsedGrant {
  type: 'grant'
  event: GroupEvent
  signer: string
  createdAt: number
  expiration: number
  grantId: string
  roomId: string
  device: string
  server: string
  scopes: GrantScope[]
  /** Present exactly when `upload` is a scope. */
  bytes?: bigint
  status: GrantStatus
}

export interface ParsedReset {
  type: 'reset'
  event: GroupEvent
  signer: string
  createdAt: number
  expiration: number
  roomId: string
  server: string
}

export type ParsedGroupEvent = ParsedGrant | ParsedReset

/** A refusal, named as the vectors name it and carrying the status a node answers with. */
export interface GroupEventRefusal {
  ok: false
  status: 400 | 401 | 403 | 413
  reason: 'malformed' | 'lifetime' | 'signature' | 'keeper' | 'server' | 'future' | 'expired' | 'too-large'
}

export type GroupEventVerdict = { ok: true; parsed: ParsedGroupEvent } | GroupEventRefusal

/** What the checks that need context may use. Each is skipped when absent. */
export interface GroupEventContext {
  /** The verifier's clock, unix seconds: rule 7. */
  now?: number
  /** Signers accepted (rule 5): a node's enrolled keepers, or a reader's pinned authority. */
  keepers?: readonly string[]
  /** Host names accepted (rule 6): a node's configured names. */
  servers?: readonly string[]
}

const HEX32 = /^[0-9a-f]{64}$/
const HEX16 = /^[0-9a-f]{32}$/
const HEX64B = /^[0-9a-f]{128}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const MAX_BYTES_VALUE = (1n << 63n) - 1n

const refuse = (status: GroupEventRefusal['status'], reason: GroupEventRefusal['reason']): GroupEventRefusal => ({ ok: false, status, reason })
const malformed = (): GroupEventRefusal => refuse(400, 'malformed')

/** What `wildbloomd` accepts as a host name in a `server` tag: lower-case
 *  letters, digits and hyphens in dot-separated labels. No scheme, port or path. */
export function isHostName(value: string): boolean {
  return value.length > 0 && value.length <= 253 && value.split('.').every((label) =>
    label.length > 0 && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-') && /^[a-z0-9-]+$/.test(label))
}

/** 1 to 2^63 - 1 in canonical decimal, as a `bytes` tag holds it. */
export function canonicalBytes(value: bigint | number | string): string {
  let n: bigint
  try {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('not an integer')
    if (typeof value === 'string' && !DECIMAL.test(value)) throw new Error('not canonical decimal')
    n = BigInt(value)
  } catch {
    throw new Error('bytes must be a whole number of bytes, written in decimal')
  }
  if (n < 1n || n > MAX_BYTES_VALUE) throw new Error('bytes must be from 1 to 2^63 - 1')
  return n.toString()
}

function eventId(e: { pubkey: string; created_at: number; kind: number; tags: string[][]; content: string }): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))))
}

function signatureOk(event: GroupEvent): boolean {
  try {
    if (eventId(event) !== event.id) return false
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey))
  } catch {
    return false
  }
}

const GRANT_TAGS = new Set(['t', 'grant', 'd', 'device', 'server', 'scope', 'bytes', 'status', 'expiration'])
const RESET_TAGS = new Set(['t', 'd', 'server', 'expiration'])

/**
 * Rules 1 to 7 of 4.4 for an event, in order, the first failure deciding: the
 * checks that need no node state. Rules 8 to 11 belong to the node.
 * Rules 5 to 7 run only for what `ctx` supplies.
 */
export function parseGroupEvent(value: unknown, ctx: GroupEventContext = {}): GroupEventVerdict {
  // Rule 1: size, and a strict NIP-01 event.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return malformed()
  let size: number
  try { size = new TextEncoder().encode(JSON.stringify(value)).length } catch { return malformed() }
  if (size > MAX_GROUP_EVENT_BYTES) return refuse(413, 'too-large')
  const keys = Object.keys(value)
  if (keys.length !== 7 || !['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig'].every((k) => keys.includes(k))) return malformed()
  const e = value as Record<string, unknown>
  if (typeof e.id !== 'string' || !HEX32.test(e.id) || typeof e.pubkey !== 'string' || !HEX32.test(e.pubkey) ||
      typeof e.sig !== 'string' || !HEX64B.test(e.sig)) return malformed()
  if (typeof e.created_at !== 'number' || !Number.isSafeInteger(e.created_at) || e.created_at < 0) return malformed()
  // Rule 2: kind, empty content, tags.
  if (e.kind !== GROUP_GRANT_KIND || e.content !== '') return malformed()
  if (!Array.isArray(e.tags) || e.tags.length > MAX_GROUP_EVENT_TAGS) return malformed()
  const tags: string[][] = []
  for (const tag of e.tags) {
    if (!Array.isArray(tag) || tag.length !== 2 || typeof tag[0] !== 'string' || typeof tag[1] !== 'string') return malformed()
    tags.push([tag[0], tag[1]])
  }
  const event: GroupEvent = { id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: GROUP_GRANT_KIND, tags, content: '', sig: e.sig }
  const single = new Map<string, string>()
  const scopes: string[] = []
  for (const [name, val] of tags) {
    if (name === 'scope') { scopes.push(val); continue }
    if (single.has(name)) return malformed()
    single.set(name, val)
  }
  const t = single.get('t')
  if (t !== 'grant' && t !== 'reset') return malformed()
  const allowed = t === 'grant' ? GRANT_TAGS : RESET_TAGS
  if (tags.some(([name]) => !allowed.has(name))) return malformed()
  if (t === 'reset' && scopes.length > 0) return malformed()
  const room = single.get('d')
  const server = single.get('server')
  const expirationText = single.get('expiration')
  if (room === undefined || !HEX32.test(room) || server === undefined || !isHostName(server) ||
      expirationText === undefined || !DECIMAL.test(expirationText)) return malformed()
  const expiration = Number(expirationText)
  if (!Number.isSafeInteger(expiration)) return malformed()

  let parsed: ParsedGroupEvent
  if (t === 'reset') {
    parsed = { type: 'reset', event, signer: event.pubkey, createdAt: event.created_at, expiration, roomId: room, server }
  } else {
    const grantId = single.get('grant')
    const device = single.get('device')
    const status = single.get('status')
    if (grantId === undefined || !HEX16.test(grantId) || device === undefined || !HEX32.test(device) || device === event.pubkey) return malformed()
    if (status !== 'active' && status !== 'revoked') return malformed()
    if (scopes.length < 1 || scopes.length > GRANT_SCOPES.length || new Set(scopes).size !== scopes.length ||
        !scopes.every((s) => (GRANT_SCOPES as readonly string[]).includes(s))) return malformed()
    const uploads = scopes.includes('upload')
    const bytesText = single.get('bytes')
    let bytes: bigint | undefined
    if (uploads !== (bytesText !== undefined)) return malformed()
    if (bytesText !== undefined) {
      if (!DECIMAL.test(bytesText)) return malformed()
      bytes = BigInt(bytesText)
      if (bytes < 1n || bytes > MAX_BYTES_VALUE) return malformed()
    }
    parsed = {
      type: 'grant', event, signer: event.pubkey, createdAt: event.created_at, expiration, grantId, roomId: room, device, server,
      scopes: scopes as GrantScope[], ...(bytes !== undefined ? { bytes } : {}), status,
    }
  }
  // Rule 3.
  if (expiration <= event.created_at || expiration - event.created_at > MAX_GRANT_SECONDS) return refuse(400, 'lifetime')
  // Rule 4.
  if (!signatureOk(event)) return refuse(401, 'signature')
  // Rules 5 to 7.
  if (ctx.keepers && !ctx.keepers.includes(event.pubkey)) return refuse(403, 'keeper')
  if (ctx.servers && !ctx.servers.includes(server)) return refuse(403, 'server')
  if (ctx.now !== undefined) {
    if (event.created_at > ctx.now + GRANT_FUTURE_SKEW_SECONDS) return refuse(403, 'future')
    if (expiration <= ctx.now) return refuse(403, 'expired')
  }
  return { ok: true, parsed }
}

// ---------------------------------------------------------------------------
// Building and signing
// ---------------------------------------------------------------------------

function sign(authoritySk: Uint8Array, createdAt: number, tags: string[][], auxRand?: Uint8Array): GroupEvent {
  const pubkey = bytesToHex(schnorr.getPublicKey(authoritySk))
  const base = { pubkey, created_at: createdAt, kind: GROUP_GRANT_KIND, tags, content: '' }
  const id = eventId(base)
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), authoritySk, auxRand))
  const event: GroupEvent = { id, ...base, sig }
  // A caller's mistake (a bad host name, a repeated scope) is refused here,
  // not discovered by a node.
  const verdict = parseGroupEvent(event)
  if (!verdict.ok) throw new Error(`group grant event is not valid: ${verdict.reason}`)
  return event
}

export interface GrantSpec {
  authoritySk: Uint8Array
  /** `deriveRoom(secret).roomId`: HKDF-SHA256 with the info `kithmoot/v1/room-id`. */
  roomId: string
  device: string
  server: string
  scopes: readonly GrantScope[]
  /** Required when `upload` is a scope; absent otherwise. */
  bytes?: bigint | number | string
  grantId: string
  createdAt: number
  expiration: number
  status?: GrantStatus
  /** 32 bytes of auxiliary randomness for BIP-340. Omit it: only the vectors fix it. */
  auxRand?: Uint8Array
}

/** A fresh grant id: 16 random bytes as 32 lower-case hex. */
export function newGrantId(randomBytes: (n: number) => Uint8Array): string {
  return bytesToHex(randomBytes(16))
}

/** A grant, or, with `status: 'revoked'`, its revocation: the same tags (4.5). Tag order as 4.2. */
export function buildGrant(spec: GrantSpec): GroupEvent {
  const tags: string[][] = [
    ['t', 'grant'], ['grant', spec.grantId], ['d', spec.roomId], ['device', spec.device], ['server', spec.server],
    ...GRANT_SCOPES.filter((s) => spec.scopes.includes(s)).map((s) => ['scope', s]),
  ]
  if (spec.scopes.includes('upload')) {
    if (spec.bytes === undefined) throw new Error('an upload grant needs bytes')
    tags.push(['bytes', canonicalBytes(spec.bytes)])
  } else if (spec.bytes !== undefined) throw new Error('bytes is only for an upload grant')
  tags.push(['status', spec.status ?? 'active'], ['expiration', String(spec.expiration)])
  return sign(spec.authoritySk, spec.createdAt, tags, spec.auxRand)
}

/** The revocation of a grant: its tags again, `status` `revoked`, a later `created_at`, and `expiration` the latest signed for it. */
export function buildRevocation(grant: ParsedGrant, authoritySk: Uint8Array, createdAt: number, auxRand?: Uint8Array): GroupEvent {
  if (createdAt <= grant.createdAt) throw new Error('a revocation must be later than the grant it revokes')
  return buildGrant({
    authoritySk, roomId: grant.roomId, device: grant.device, server: grant.server, scopes: grant.scopes,
    ...(grant.bytes !== undefined ? { bytes: grant.bytes } : {}),
    grantId: grant.grantId, createdAt, expiration: grant.expiration, status: 'revoked', ...(auxRand ? { auxRand } : {}),
  })
}

/** A reset: ends every grant of the room at one node that is not newer than it. `expiration` defaults to 90 days on. */
export function buildReset(spec: { authoritySk: Uint8Array; roomId: string; server: string; createdAt: number; expiration?: number; auxRand?: Uint8Array }): GroupEvent {
  const tags = [['t', 'reset'], ['d', spec.roomId], ['server', spec.server], ['expiration', String(spec.expiration ?? spec.createdAt + MAX_GRANT_SECONDS)]]
  return sign(spec.authoritySk, spec.createdAt, tags, spec.auxRand)
}

/**
 * When to stamp the next event for one grant id, or for one node after a
 * reset: never in a second already used (a node refuses two events for one id
 * in the same second, 4.5), and, after a reset, strictly later than its floor
 * (rule 9). `lastAt` is the newest `created_at` already signed that bounds it.
 */
export function nextCreatedAt(now: number, ...lastAt: (number | undefined)[]): number {
  let at = now
  for (const last of lastAt) if (last !== undefined && last + 1 > at) at = last + 1
  return at
}

// ---------------------------------------------------------------------------
// A group node, as a keeper is told of it
// ---------------------------------------------------------------------------

export interface GroupNode {
  /** The base URL the keeper pushes to, scheme and host and port and any path, no trailing slash. */
  base: string
  /** The `server` tag: the lower-case host name alone. */
  server: string
}

/**
 * A node's base URL to what the keeper needs. `http` and `https` only in this
 * phase; an onion host is refused with its own message (Tor transport is a
 * follow-up). Everything else is fold-kit's `storageNodeFromBase`, so the
 * keeper's `base` and `server` are the exact strings every client derives from
 * the room's list. Throws an Error whose message is fit to show an operator.
 */
export function groupNodeFromBase(text: string): GroupNode {
  // The onion refusal stays first, ahead of the grammar's own refusals, as it was.
  try {
    const url = new URL(text.trim())
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.search && !url.hash &&
        url.hostname.toLowerCase().endsWith('.onion')) {
      throw new Error(`group node ${url.hostname.toLowerCase()}: onion nodes need Tor, which a keeper does not speak yet; use an https base URL`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('onion nodes need Tor')) throw error
    // Not a URL at all: the grammar says so, with its own message.
  }
  const node = storageNodeFromBase(text)
  return { base: node.base, server: node.server }
}

// ---------------------------------------------------------------------------
// The receiver rule (7.1)
// ---------------------------------------------------------------------------

const MAX_KEPT_REVOKED = 4_096
const MAX_KEPT_RESETS = 256
/** This device's own grants: at most this many are kept, and one is let go this long after it ended (the node's delete grace, contract 6.4). */
const MAX_KEPT_OWN = 256
const KEEP_OWN_AFTER_EXPIRY_SECONDS = 7 * 86_400

/**
 * What a device keeps of the `storage-grant` ops it reads (7.1): an event is
 * kept only if it verifies, follows section 4, is signed by the authority
 * pinned in the device's link and names its room. Of those, it keeps the grant
 * whose `device` is its own key (the newest per grant id), and every `revoked`
 * grant and every reset, to carry to nodes. Memory only; the caller persists.
 */
export class GrantReceiver {
  readonly #authority: string
  readonly #roomId: string
  readonly #device: string
  readonly #own = new Map<string, ParsedGrant>()
  readonly #revoked = new Map<string, ParsedGrant>()
  readonly #resets = new Map<string, ParsedReset>()
  readonly #acknowledged = new Set<string>()
  /** The newest `created_at` of any event kept: a clock taken from signed data, for letting go of old own grants. */
  #horizon = 0

  constructor(opts: { authority: string; roomId: string; device: string }) {
    this.#authority = opts.authority.toLowerCase()
    this.#roomId = opts.roomId.toLowerCase()
    this.#device = opts.device.toLowerCase()
  }

  /** Offer one event as read off the control channel. True when it was kept. */
  offer(event: unknown, now?: number): boolean {
    // Rule 7 judges a node's clock, not a reader's: a device whose clock lags must still keep the revocation it is to carry.
    // Expiry is applied when events are handed out (`grantsFor`, `carry`).
    void now
    const verdict = parseGroupEvent(event, { keepers: [this.#authority] })
    const parsed = verdict.ok ? verdict.parsed : undefined
    if (!parsed || parsed.roomId !== this.#roomId) return false
    this.#horizon = Math.max(this.#horizon, parsed.createdAt)
    if (parsed.type === 'reset') {
      const held = this.#resets.get(parsed.server)
      if (held && held.createdAt >= parsed.createdAt) return false
      this.#resets.set(parsed.server, parsed)
      this.#trim(this.#resets, MAX_KEPT_RESETS)
      return true
    }
    let kept = false
    if (parsed.device === this.#device) {
      const held = this.#own.get(parsed.grantId)
      if (!held || parsed.createdAt > held.createdAt) { this.#own.set(parsed.grantId, parsed); kept = true }
      this.#letGoOfOldOwn(now)
    }
    if (parsed.status === 'revoked') {
      const held = this.#revoked.get(parsed.grantId)
      if (!held || parsed.createdAt > held.createdAt) { this.#revoked.set(parsed.grantId, parsed); this.#trim(this.#revoked, MAX_KEPT_REVOKED); kept = true }
    }
    return kept
  }

  /** Own grants a week past their end are of no use to anyone, and the list is capped: it is persisted whole. */
  #letGoOfOldOwn(now?: number): void {
    const at = Math.max(this.#horizon, now ?? 0)
    for (const [id, g] of this.#own) if (g.expiration + KEEP_OWN_AFTER_EXPIRY_SECONDS < at) this.#own.delete(id)
    this.#trim(this.#own, MAX_KEPT_OWN)
  }

  #trim<T>(map: Map<string, T>, max: number): void {
    while (map.size > max) map.delete(map.keys().next().value!)
  }

  /** This device's newest event per grant id for `server`: the grants to present, and nothing revoked or ended at `now`. */
  grantsFor(server: string, now: number): ParsedGrant[] {
    return [...this.#own.values()].filter((g) => g.server === server && g.status === 'active' && g.expiration > now &&
      !this.#revoked.has(g.grantId) && !this.#resetCovers(g))
  }

  #resetCovers(g: ParsedGrant): boolean {
    const reset = this.#resets.get(g.server)
    return reset !== undefined && g.createdAt <= reset.createdAt
  }

  /** Revocations and resets for `server`, not yet seen acknowledged there, still worth carrying at `now`. */
  carry(server: string, now: number): ParsedGroupEvent[] {
    return [...this.#revoked.values(), ...this.#resets.values()]
      .filter((p) => p.server === server && p.expiration > now && !this.#acknowledged.has(`${server}/${p.event.id}`))
  }

  /** A node answered `200`, `201` or `409` for this event. */
  acknowledge(server: string, eventId: string): void {
    this.#acknowledged.add(`${server}/${eventId}`)
  }

  /**
   * This device's own newest active grant event for `server`, unless that
   * event is already acknowledged there: what a device posts on first contact
   * with a node in a session (contract 7.2 item 2). A renewal is a new event
   * id, so it is posted again. `carry` is unchanged: revocations and resets only.
   */
  ownToPost(server: string, now: number): GroupEvent | undefined {
    let newest: ParsedGrant | undefined
    for (const g of this.grantsFor(server, now)) if (!newest || g.createdAt > newest.createdAt) newest = g
    return newest && !this.#acknowledged.has(`${server}/${newest.event.id}`) ? newest.event : undefined
  }

  /**
   * Whether this device had grants at `server` that have all ended: it holds
   * at least one of its own there, none is active at `now`, and one was revoked
   * or covered by a reset. What a client reads as "no longer let in" (contract 11).
   */
  lockedOut(server: string, now: number): boolean {
    const mine = [...this.#own.values()].filter((g) => g.server === server)
    if (mine.length === 0 || this.grantsFor(server, now).length > 0) return false
    return mine.some((g) => this.#revoked.has(g.grantId) || this.#resetCovers(g))
  }

  /**
   * What the receiver holds, to persist: the kept own grants, revocations and
   * resets (each once), and the acknowledged keys of events still held. Bounded
   * by the `MAX_KEPT_*` caps, and the device's own grants are let go a week
   * after they end, since nothing else is kept.
   */
  snapshot(): GrantReceiverSnapshot {
    const events = new Map<string, GroupEvent>()
    for (const p of [...this.#own.values(), ...this.#revoked.values(), ...this.#resets.values()]) events.set(p.event.id, p.event)
    const acknowledged = [...this.#acknowledged].filter((key) => events.has(key.slice(key.lastIndexOf('/') + 1)))
    return { events: [...events.values()], acknowledged }
  }

  /**
   * A receiver from a snapshot. Every event is offered again, so each is
   * verified again: a tampered one is dropped, never trusted for having been
   * stored. An acknowledged key is taken only in the shape `acknowledge` writes.
   */
  static restore(opts: { authority: string; roomId: string; device: string }, snapshot: GrantReceiverSnapshot): GrantReceiver {
    const receiver = new GrantReceiver(opts)
    for (const event of Array.isArray(snapshot?.events) ? snapshot.events : []) receiver.offer(event)
    const held = new Set(receiver.snapshot().events.map((e) => e.id))
    for (const key of Array.isArray(snapshot?.acknowledged) ? snapshot.acknowledged : []) {
      if (typeof key !== 'string' || key.length > 300) continue
      const slash = key.lastIndexOf('/')
      if (slash < 1 || !held.has(key.slice(slash + 1)) || !isHostName(key.slice(0, slash))) continue
      receiver.#acknowledged.add(key)
    }
    return receiver
  }
}

/** A receiver's persisted form (`GrantReceiver.snapshot`). Plain JSON. */
export interface GrantReceiverSnapshot {
  events: GroupEvent[]
  /** `<server>/<event id>`, as `acknowledge` keys them. */
  acknowledged: string[]
}
