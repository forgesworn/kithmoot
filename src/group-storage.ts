import { finalizeEvent, type Event, type EventTemplate } from 'nostr-tools/pure'
import { storageNodeServer } from '@forgesworn/fold-kit'
import {
  BLOSSOM_AUTH_KIND, DEFAULT_MAX_BLOB_ATTACHMENT_BYTES, ENVELOPE_MEDIA_TYPE, encodeBlossomAuthorisation,
} from './attachment.js'
import { verifyEventUncached } from './verify.js'
import { isHostName, type GrantReceiver, type GrantScope, type GroupEvent } from './group-grants.js'

/**
 * The client side of group storage (phase S5 of KithMoot's group-hosted
 * design). A room that lists its own storage nodes keeps its files on them,
 * and a device that holds a grant from the room's keeper uploads to and reads
 * from them with signed tokens. The contract is `docs/GROUP-GRANTS.md` in
 * wildbloom-node, profile `group-grants/1`; section numbers below are its.
 *
 * Pure and injected: no DOM, no storage of its own, no clock but `now`. The
 * `@forgesworn/context` upload, fetch and delete helpers refuse anything but
 * an https origin, so they are not used here; this module builds its own
 * tokens and requests. Its envelope sealing and opening are the caller's.
 *
 * Nothing here ever falls back to a public server or an unauthenticated read,
 * and a token never goes in a URL. Every request goes to a base the room lists.
 */

/** A `get` token's life, seconds (6.3). */
export const GROUP_GET_TOKEN_SECONDS = 120
/** An `upload` token's life, seconds. */
export const GROUP_UPLOAD_TOKEN_SECONDS = 90
/** A `delete` token's life: the week KithMoot keeps a signed delete, and a second (`BLOB_DELETE_RETRY_SECONDS + 1`), exactly the longest the node allows. */
export const GROUP_DELETE_TOKEN_SECONDS = 7 * 86_400 + 1
/** A cached read token is reused only while this much of its life is left, seconds. */
export const GROUP_TOKEN_REUSE_MARGIN_SECONDS = 15
/** How long the probe, `HEAD`, `POST /groups/v1/events` and a `GET` wait for a node's headers, milliseconds. */
export const GROUP_REQUEST_TIMEOUT_MS = 30_000
/** How far a device's clock may differ from a node's `Date` before it is blamed for a refused token, seconds. */
export const GROUP_CLOCK_TOLERANCE_SECONDS = 30

/** Thrown into the outbox when no node takes a file yet. Its message is the status text (6.1). */
export const GROUP_STORAGE_WAITING = 'Waiting for the group’s storage.'

/** What the person is told, for each way a node can leave a request unanswered (contract 11). */
export const GROUP_STORAGE_MESSAGES = {
  'no-grant': 'Group files will be available once the keeper has let this device in.',
  unreachable: 'Waiting for the group\'s storage.',
  refused: 'Waiting for the group\'s storage.',
  clock: 'This device\'s clock is wrong, so the group\'s storage refused it. Check the date and time.',
  'locked-out': 'This device is no longer let in to the group\'s storage.',
  absent: 'This file is on the group\'s computers, and none of them can be reached right now.',
  'node-open': 'One of the group\'s computers is giving files to anyone who asks, so this app has stopped using it. Tell the person who runs it.',
} as const

export type GroupStorageReason = 'no-grant' | 'unreachable' | 'refused' | 'clock' | 'locked-out'

/** What an authenticated `HEAD` found: the blob is there, is not, the device may no longer read (`403`), or the node could not say. */
export type HeadOutcome = 'present' | 'absent' | 'unconfirmed' | 'failed'

export type GroupUploadResult =
  | { status: 'stored'; url: string; base: string; server: string; size: number }
  // `url` is always `${base}/${sha256}`, built here from the base uploaded to. The
  // node's descriptor is only checked: the same sha256 and size, and a URL on the
  // same origin and base path whose last segment is the hash, an extension of 1 to
  // 10 [a-z0-9] allowed. One that fails is a refusal at that node.
  | { status: 'held'; reason: GroupStorageReason; detail: string }

/** Thrown by `get` and `getRange` when no listed node could give the bytes. `reason` is why. */
export class GroupStorageError extends Error {
  constructor(readonly reason: GroupStorageReason | 'absent', message: string) {
    super(message)
    this.name = 'GroupStorageError'
  }
}

export interface GroupStorageOptions {
  roomId: string
  /** The room's node bases, in order, from the held record. */
  nodes: () => readonly string[]
  /** This room's device key. */
  deviceSk: Uint8Array
  /** The device's grants, revocations and resets. */
  receiver: GrantReceiver
  /** Persist the receiver: called after `receiver.acknowledge`. */
  onAcknowledged?: () => void
  fetch?: typeof fetch
  /** Unix seconds. */
  now?: () => number
  /** Which bases this runtime can reach. The web app passes https only, not onion. Default: all. */
  usable?: (base: string) => boolean
  /** Told once per session per node that serves an unauthenticated read (6.8). */
  onNodeOpen?: (server: string) => void
  onClockWrong?: (server: string, skewSeconds: number) => void
  /** No node has a grant for this device that works: the caller sends `storage-grant?` (and rate-limits it). */
  onNoGrant?: () => void
  /** The device's grants have ended everywhere (a revocation or a reset): contract 11. */
  onLockedOut?: () => void
  signal?: AbortSignal
  /** Tests: how long a node may take to answer before its headers arrive. Default `GROUP_REQUEST_TIMEOUT_MS`. */
  requestTimeoutMs?: number
}

const HEX64 = /^[0-9a-f]{64}$/
const DESCRIPTOR_MAX_CHARS = 64 * 1024

/**
 * The unsigned kind 24242 token for one request (6.3). `created_at` is one
 * second in the past, as the context library and contract 6.5 have it. `delete`
 * also carries the `kithmoot-delete-target-v1` tag the app's journal signs, so
 * a stored delete can be tied to the exact URL it was made for (`target`).
 */
export function buildGroupToken(
  verb: 'get' | 'upload' | 'delete',
  sha256: string,
  server: string,
  nowSeconds: number,
  lifetime?: number,
  target?: string,
): EventTemplate {
  const hash = sha256.toLowerCase()
  if (!HEX64.test(hash)) throw new Error('The blob hash must be 64 hex characters.')
  if (!isHostName(server)) throw new Error('The node\'s name must be a lower-case host name.')
  const life = lifetime ?? (verb === 'get' ? GROUP_GET_TOKEN_SECONDS : verb === 'upload' ? GROUP_UPLOAD_TOKEN_SECONDS : GROUP_DELETE_TOKEN_SECONDS)
  if (!Number.isSafeInteger(life) || life <= 0) throw new Error('The token lifetime must be a positive number of seconds.')
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) throw new Error('The token needs a valid clock.')
  if (target !== undefined && verb !== 'delete') throw new Error('Only a delete token names a target.')
  const createdAt = Math.max(0, nowSeconds - 1)
  const tags: string[][] = [['t', verb], ['expiration', String(createdAt + life)], ['server', server], ['x', hash]]
  if (verb === 'delete' && target !== undefined) tags.push(['kithmoot-delete-target-v1', target])
  const content = verb === 'get' ? `Get blob ${hash}` : verb === 'upload' ? `Upload blob ${hash} to ${server}` : `Delete blob ${hash}`
  return { kind: BLOSSOM_AUTH_KIND, created_at: createdAt, tags, content }
}

type Probe = 'closed' | 'open' | 'unknown'

/** A token held for reuse, and when it stops being worth reusing. */
interface CachedToken { header: string; expiration: number }

/** The result of one authenticated request to one node, before a caller reads its answer. */
type Sent = { kind: 'response'; res: Response; server: string } | { kind: 'network' } | { kind: 'cancelled' }

const drain = (res: Response): void => { try { void res.body?.cancel().catch(() => {}) } catch { /* Nothing to free. */ } }

function reasonOf(res: Response): string {
  return (res.headers.get('x-reason') ?? '').trim().toLowerCase().slice(0, 40)
}

/**
 * A device's use of its group's storage nodes. One instance per room and
 * session: it remembers which nodes it has probed and which it found open.
 */
export class GroupStorage {
  readonly #opts: GroupStorageOptions
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #timeoutMs: number
  /** Nodes probed closed and brought up to date this session. */
  readonly #ready = new Set<string>()
  /** Nodes found serving an unauthenticated read this session: never used again until a new instance. */
  readonly #open = new Set<string>()
  readonly #readying = new Map<string, Promise<'ready' | 'open' | 'unreachable'>>()
  readonly #tokens = new Map<string, CachedToken>()
  /** A wrong clock stops further requests for the rest of the session, as the caller is told once. */
  #clockWrong = false

  constructor(opts: GroupStorageOptions) {
    this.#opts = opts
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init))
    this.#now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    this.#timeoutMs = opts.requestTimeoutMs ?? GROUP_REQUEST_TIMEOUT_MS
  }

  // -------------------------------------------------------------------------
  // Which nodes
  // -------------------------------------------------------------------------

  /** The listed bases this runtime can reach, with their `server`, in list order. */
  #listed(): { base: string; server: string }[] {
    const out: { base: string; server: string }[] = []
    for (const base of this.#opts.nodes()) {
      const server = storageNodeServer(base)
      if (server === undefined || !isHostName(server)) continue
      if (this.#opts.usable && !this.#opts.usable(base)) continue
      if (out.some((n) => n.base === base)) continue
      out.push({ base, server })
    }
    return out
  }

  #hasScope(server: string, scope: GrantScope): boolean {
    return this.#opts.receiver.grantsFor(server, this.#now()).some((g) => g.scopes.includes(scope))
  }

  /** Candidates for a verb: usable, granted that scope, not found open. `prefer` goes first when it is listed. */
  #candidates(scope: GrantScope, prefer?: string): { base: string; server: string }[] {
    const listed = this.#listed()
    const ordered = prefer ? [...listed.filter((n) => n.base === prefer), ...listed.filter((n) => n.base !== prefer)] : listed
    return ordered.filter((n) => !this.#open.has(n.base) && this.#hasScope(n.server, scope))
  }

  /** Said when no candidate exists or every one refused: locked out if every listed node has ended this device's grants, else no grant. */
  #noGrant(): { reason: 'no-grant' | 'locked-out' } {
    const now = this.#now()
    const listed = this.#listed()
    const active = listed.some((n) => this.#opts.receiver.grantsFor(n.server, now).length > 0)
    if (!active && listed.length > 0 && listed.every((n) => this.#opts.receiver.lockedOut(n.server, now))) {
      this.#opts.onLockedOut?.()
      return { reason: 'locked-out' }
    }
    this.#opts.onNoGrant?.()
    return { reason: 'no-grant' }
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  /**
   * One request. `timed` gives it the headers timeout (A3): the probe, `HEAD`,
   * `POST /groups/v1/events` and a `GET` wait at most that long for a node's
   * headers, then no longer limit the body. A `PUT /upload` is not timed: a
   * large file on a slow link must not be cut off by a clock of ours, so, like
   * the existing Blossom upload (`uploadEnvelopeBody`), it relies on the
   * caller's abort signal alone.
   */
  async #request(url: string, init: RequestInit, timed: boolean): Promise<Response | 'network' | 'cancelled'> {
    const caller = this.#opts.signal
    if (caller?.aborted) return 'cancelled'
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    caller?.addEventListener('abort', onAbort, { once: true })
    const timer = timed ? setTimeout(() => controller.abort(), this.#timeoutMs) : undefined
    try {
      return await this.#fetch(url, {
        ...init, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error', signal: controller.signal,
      })
    } catch {
      return caller?.aborted ? 'cancelled' : 'network'
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      caller?.removeEventListener('abort', onAbort)
    }
  }

  /** A signed token for (base, hash), as a header. A read token is reused while 15 s of it remain. */
  #token(verb: 'get' | 'upload', base: string, server: string, hash: string, fresh = false): CachedToken {
    const now = this.#now()
    const key = `${verb}|${base}|${hash}`
    const held = this.#tokens.get(key)
    if (verb === 'get' && !fresh && held && held.expiration - now > GROUP_TOKEN_REUSE_MARGIN_SECONDS) return held
    const template = buildGroupToken(verb, hash, server, now)
    const event: Event = finalizeEvent(template, this.#opts.deviceSk)
    const token = { header: encodeBlossomAuthorisation(event), expiration: Number(template.tags.find((t) => t[0] === 'expiration')![1]) }
    if (verb === 'get') {
      this.#tokens.set(key, token)
      // Bounded: a long session reading many blobs forgets the ones it is done with.
      while (this.#tokens.size > 256) this.#tokens.delete(this.#tokens.keys().next().value!)
    }
    return token
  }

  /** `POST /groups/v1/events`: `200`, `201` and `409` are an answer; anything else leaves the event for the next session. */
  async #post(base: string, server: string, event: GroupEvent): Promise<'accepted' | 'refused' | 'network' | 'cancelled'> {
    const res = await this.#request(`${base}/groups/v1/events`, {
      method: 'POST', body: JSON.stringify(event), headers: { 'Content-Type': 'application/json' },
    }, true)
    if (res === 'network' || res === 'cancelled') return res
    drain(res)
    if (res.status === 200 || res.status === 201 || res.status === 409) {
      this.#opts.receiver.acknowledge(server, event.id)
      this.#opts.onAcknowledged?.()
      return 'accepted'
    }
    return 'refused'
  }

  /**
   * Before a node's first request in a session (6.8, 6.4): the probe, then the
   * revocations and resets this device carries, then its own newest grant
   * unless the node has already acknowledged it (A2). A node that serves an
   * unauthenticated read is marked open and used no more. Failure to reach a
   * node is not remembered, so the next call tries again.
   */
  async #ensureReady(base: string, server: string, hash: string): Promise<'ready' | 'open' | 'unreachable'> {
    if (this.#open.has(base)) return 'open'
    if (this.#ready.has(base)) return 'ready'
    const running = this.#readying.get(base)
    if (running) return running
    const task = this.#bringUp(base, server, hash).finally(() => this.#readying.delete(base))
    this.#readying.set(base, task)
    return task
  }

  async #bringUp(base: string, server: string, hash: string): Promise<'ready' | 'open' | 'unreachable'> {
    const verdict = await this.#probe(base, hash)
    if (verdict === 'open') {
      this.#open.add(base)
      this.#opts.onNodeOpen?.(server)
      return 'open'
    }
    if (verdict === 'unknown') return 'unreachable'
    const now = this.#now()
    for (const p of this.#opts.receiver.carry(server, now)) {
      if (await this.#post(base, server, p.event) === 'network') return 'unreachable'
    }
    const own = this.#opts.receiver.ownToPost(server, now)
    if (own && await this.#post(base, server, own) === 'network') return 'unreachable'
    this.#ready.add(base)
    return 'ready'
  }

  /** `HEAD <base>/<hash>` with no `Authorization`. Group mode answers `401` whether or not the blob exists (6.2). */
  async #probe(base: string, hash: string): Promise<Probe> {
    const res = await this.#request(`${base}/${hash}`, { method: 'HEAD' }, true)
    if (res === 'network' || res === 'cancelled') return 'unknown'
    drain(res)
    if (res.status === 401) return 'closed'
    if (res.status === 429 || res.status >= 500) return 'unknown'
    // Any 2xx, 3xx, 404 or 410 (and any other answer that is not a demand for a token): a node that gives or denies a blob without asking who is asking.
    return 'open'
  }

  /**
   * An authenticated request to one node, with the `403 not-granted` rule of
   * 6.4: post this device's newest grant for the node once, then repeat the
   * request once (with the same token if it has 15 s left, else a fresh one).
   * Never loops: at most one post and one repeat per call.
   */
  async #authed(verb: 'get' | 'upload', node: { base: string; server: string }, hash: string, url: string, init: (auth: string) => RequestInit, timed: boolean): Promise<Sent> {
    let token = this.#token(verb, node.base, node.server, hash)
    let res = await this.#request(url, init(token.header), timed)
    if (res === 'network') return { kind: 'network' }
    if (res === 'cancelled') return { kind: 'cancelled' }
    if (res.status === 403 && reasonOf(res) === 'not-granted') {
      drain(res)
      const grant = this.#newestGrant(node.server)
      if (!grant) return { kind: 'response', res: new Response(null, { status: 403, headers: { 'x-reason': 'not-granted' } }), server: node.server }
      const posted = await this.#post(node.base, node.server, grant)
      if (posted === 'network') return { kind: 'network' }
      if (posted === 'cancelled') return { kind: 'cancelled' }
      if (this.#now() >= token.expiration - GROUP_TOKEN_REUSE_MARGIN_SECONDS) token = this.#token(verb, node.base, node.server, hash, true)
      res = await this.#request(url, init(token.header), timed)
      if (res === 'network') return { kind: 'network' }
      if (res === 'cancelled') return { kind: 'cancelled' }
    }
    return { kind: 'response', res, server: node.server }
  }

  #newestGrant(server: string): GroupEvent | undefined {
    let newest: { createdAt: number; event: GroupEvent } | undefined
    for (const g of this.#opts.receiver.grantsFor(server, this.#now())) if (!newest || g.createdAt > newest.createdAt) newest = g
    return newest?.event
  }

  /** A `401` whose reason is `future` or `expired` and whose node's `Date` disagrees with ours by more than 30 s: our clock. */
  #clockSkew(res: Response): number | undefined {
    const why = reasonOf(res)
    if (res.status !== 401 || (why !== 'future' && why !== 'expired')) return undefined
    const date = res.headers.get('date')
    const theirs = date ? Date.parse(date) : NaN
    if (!Number.isFinite(theirs)) return undefined
    const skew = Math.round(theirs / 1000 - this.#now())
    return Math.abs(skew) > GROUP_CLOCK_TOLERANCE_SECONDS ? skew : undefined
  }

  #wrongClock(server: string, skew: number): void {
    this.#clockWrong = true
    this.#opts.onClockWrong?.(server, skew)
  }

  // -------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------

  /**
   * Put an envelope on the first listed node that takes it (6.2): in list
   * order, among nodes this device holds an `upload` grant for and that were
   * not found open. A node that fails moves the call on to the next; nothing
   * is retried within one call beyond the `403` post-and-retry (6.4).
   * `sha256` is the envelope's hash, as sealing computed it.
   */
  async upload(envelope: Blob | Uint8Array, sha256: string): Promise<GroupUploadResult> {
    const hash = sha256.toLowerCase()
    if (!HEX64.test(hash)) throw new Error('The blob hash must be 64 hex characters.')
    const size = envelope instanceof Blob ? envelope.size : envelope.length
    if (this.#clockWrong) return { status: 'held', reason: 'clock', detail: GROUP_STORAGE_MESSAGES.clock }
    const candidates = this.#candidates('upload')
    if (candidates.length === 0) {
      const why = this.#noGrant()
      return { status: 'held', reason: why.reason, detail: GROUP_STORAGE_MESSAGES[why.reason] }
    }
    let body: BodyInit | undefined
    let unreachable = 0
    let refused = 0
    let denied = 0
    for (const node of candidates) {
      if (this.#opts.signal?.aborted) throw new Error('The upload was cancelled.')
      const ready = await this.#ensureReady(node.base, node.server, hash)
      if (ready === 'open') continue
      if (ready === 'unreachable') { unreachable++; continue }
      body ??= await uploadBody(envelope)
      const sent = await this.#authed('upload', node, hash, `${node.base}/upload`, (auth) => ({
        method: 'PUT',
        headers: { Authorization: auth, 'Content-Type': ENVELOPE_MEDIA_TYPE, 'X-SHA-256': hash },
        body,
      }), false)
      if (sent.kind === 'cancelled') throw new Error('The upload was cancelled.')
      if (sent.kind === 'network') { unreachable++; continue }
      const { res } = sent
      const skew = this.#clockSkew(res)
      if (skew !== undefined) {
        drain(res)
        this.#wrongClock(node.server, skew)
        return { status: 'held', reason: 'clock', detail: GROUP_STORAGE_MESSAGES.clock }
      }
      if (res.status === 200 || res.status === 201) {
        const text = await res.text().catch(() => '')
        if (descriptorFits(text, node.base, hash, size)) return { status: 'stored', url: `${node.base}/${hash}`, base: node.base, server: node.server, size }
        refused++
        continue
      }
      drain(res)
      if (res.status === 403) denied++
      else if (res.status === 429 || res.status >= 500) unreachable++
      else refused++
    }
    if (denied > 0 && unreachable === 0) {
      // A node refused a device that holds a grant for it: the keeper is asked again (by the caller, which rate-limits it).
      this.#opts.onNoGrant?.()
      return { status: 'held', reason: 'refused', detail: GROUP_STORAGE_MESSAGES.refused }
    }
    if (unreachable > 0) return { status: 'held', reason: 'unreachable', detail: GROUP_STORAGE_MESSAGES.unreachable }
    if (refused > 0) return { status: 'held', reason: 'refused', detail: GROUP_STORAGE_MESSAGES.refused }
    // Every candidate was found open this session: nothing is left to use.
    return { status: 'held', reason: 'unreachable', detail: GROUP_STORAGE_MESSAGES.unreachable }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Fetch a whole envelope by hash, from `prefer` first if listed, then in list order. The caller checks the hash and opens it. */
  async get(sha256: string, opts: { prefer?: string; maxBytes?: number } = {}): Promise<Blob> {
    const limit = opts.maxBytes ?? DEFAULT_MAX_BLOB_ATTACHMENT_BYTES
    const res = await this.#read(sha256, {}, opts.prefer, (r) => {
      const length = Number(r.headers.get('content-length'))
      return !(Number.isFinite(length) && length > limit)
    })
    const blob = await res.blob()
    if (blob.size > limit) throw new GroupStorageError('refused', 'The file is bigger than this app will take.')
    return blob
  }

  /** One range of a blob, `start` to `endInclusive`. Reuses the `get` token for (node, hash) while 15 s of it remain. */
  async getRange(sha256: string, start: number, endInclusive: number, opts: { prefer?: string } = {}): Promise<Uint8Array> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || start < 0 || endInclusive < start) throw new Error('A range needs a start and an end, in order.')
    const wanted = endInclusive - start + 1
    const res = await this.#read(sha256, { Range: `bytes=${start}-${endInclusive}` }, opts.prefer, (r) => r.status === 206)
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length !== wanted) throw new GroupStorageError('refused', 'A node answered a range with the wrong number of bytes.')
    return bytes
  }

  /** The one read loop: nodes in order, `404` and failures move on, the whole read fails only after every candidate. */
  async #read(sha256: string, headers: Record<string, string>, prefer: string | undefined, accept: (r: Response) => boolean): Promise<Response> {
    const hash = sha256.toLowerCase()
    if (!HEX64.test(hash)) throw new Error('The blob hash must be 64 hex characters.')
    if (this.#clockWrong) throw new GroupStorageError('clock', GROUP_STORAGE_MESSAGES.clock)
    const candidates = this.#candidates('get', prefer)
    if (candidates.length === 0) {
      const why = this.#noGrant()
      throw new GroupStorageError(why.reason, GROUP_STORAGE_MESSAGES[why.reason])
    }
    let reached = 0
    let refused = 0
    for (const node of candidates) {
      if (this.#opts.signal?.aborted) throw new Error('The read was cancelled.')
      const ready = await this.#ensureReady(node.base, node.server, hash)
      if (ready === 'open') continue
      if (ready === 'unreachable') continue
      const sent = await this.#authed('get', node, hash, `${node.base}/${hash}`, (auth) => ({ method: 'GET', headers: { Authorization: auth, ...headers } }), true)
      if (sent.kind === 'cancelled') throw new Error('The read was cancelled.')
      if (sent.kind === 'network') continue
      const { res } = sent
      const skew = this.#clockSkew(res)
      if (skew !== undefined) {
        drain(res)
        this.#wrongClock(node.server, skew)
        throw new GroupStorageError('clock', GROUP_STORAGE_MESSAGES.clock)
      }
      reached++
      if ((res.status === 200 || res.status === 206) && accept(res)) return res
      drain(res)
      if (res.status === 403) refused++
    }
    if (refused > 0 && refused === reached) {
      const why = this.#noGrant()
      throw new GroupStorageError(why.reason === 'locked-out' ? 'locked-out' : 'refused', GROUP_STORAGE_MESSAGES[why.reason === 'locked-out' ? 'locked-out' : 'refused'])
    }
    throw new GroupStorageError('absent', GROUP_STORAGE_MESSAGES.absent)
  }

  /**
   * An authenticated `HEAD` of a blob on a listed base, with a `get` token.
   * `200` is present, `404` absent, `403` unconfirmed (this device's `get`
   * grant has ended, so it can no longer look), anything else, or a base the
   * room does not list, failed. Not covered by the spec's table, so this
   * mapping is this module's.
   */
  async head(base: string, sha256: string): Promise<HeadOutcome> {
    const hash = sha256.toLowerCase()
    if (!HEX64.test(hash)) return 'failed'
    const node = this.#listed().find((n) => n.base === base)
    if (!node || this.#open.has(base)) return 'failed'
    // No active `get` grant: this device can no longer look, which is not the same as the node being down.
    if (!this.#hasScope(node.server, 'get')) return 'unconfirmed'
    const sent = await this.#authed('get', node, hash, `${base}/${hash}`, (auth) => ({ method: 'HEAD', headers: { Authorization: auth } }), true)
    if (sent.kind !== 'response') return 'failed'
    drain(sent.res)
    if (sent.res.status === 200) return 'present'
    if (sent.res.status === 404) return 'absent'
    if (sent.res.status === 403) return 'unconfirmed'
    return 'failed'
  }
}

/** A Blob body for a PUT. WebKit can read and hash an OPFS-backed File, yet send it as a zero-byte body: it is read into memory there only. */
async function uploadBody(envelope: Blob | Uint8Array): Promise<BodyInit> {
  if (!(envelope instanceof Blob)) return envelope.slice().buffer as ArrayBuffer
  const agent = (globalThis as unknown as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? ''
  const webKit = /\bAppleWebKit\//.test(agent) && !/\b(?:Chrome|Chromium|Edg|OPR)\//.test(agent)
  return webKit ? await envelope.arrayBuffer() : envelope
}

/** The node's descriptor is held to what was sent: the hash, the size, and a URL on this base whose last segment is the hash. */
function descriptorFits(text: string, base: string, hash: string, size: number): boolean {
  if (text.length > DESCRIPTOR_MAX_CHARS) return false
  let d: unknown
  try { d = JSON.parse(text) } catch { return false }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false
  const o = d as Record<string, unknown>
  if (typeof o.sha256 !== 'string' || o.sha256.toLowerCase() !== hash || o.size !== size || typeof o.url !== 'string') return false
  try {
    const url = new URL(o.url)
    const root = new URL(base)
    if (url.origin !== root.origin || url.search || url.hash || url.username || url.password) return false
    const segments = url.pathname.split('/')
    const leaf = segments.pop() ?? ''
    if (!new RegExp(`^${hash}(?:\\.[a-z0-9]{1,10})?$`).test(leaf)) return false
    return segments.join('/') === root.pathname.replace(/\/+$/, '')
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Deletes (6.7)
// ---------------------------------------------------------------------------

export type GroupBlobDeleteOutcome =
  | { status: 'deleted'; /** Set when the node's answer could not be confirmed by a read. */ detail?: string }
  | { status: 'kept'; detail: string }
  | { status: 'failed'; detail: string }

export interface DeleteGroupBlobOptions {
  fetch?: typeof fetch
  signal?: AbortSignal
  /** An authenticated `HEAD` of the blob, while the device still holds a key and a `get` grant. Without it, an unauthenticated `HEAD` decides. */
  confirm?: (url: string, sha256: string) => Promise<HeadOutcome>
  /** Tests: how long to wait for a node's headers. */
  requestTimeoutMs?: number
}

/**
 * Delete a blob this device put on a group node: `DELETE <base>/<sha256>` with
 * the stored, single-use signed token, then a look to see whether the node
 * still serves it. `url` is the delete URL on a listed base, which the caller
 * has already matched to one. `auth` is the signed `delete` token, held by the
 * journal for up to a week (it is spent once: a `409 spent` means the claim is
 * back, so it is a failure, never a second delete).
 *
 * A removed device keeps its delete permission for seven days (6.4) but can no
 * longer read, so it cannot always confirm: a `403` to the authenticated
 * `HEAD`, or a `401` to the unauthenticated one (the node answered `401` to
 * every read, found or not), is reported `deleted` with a "not confirmed" detail.
 */
export async function deleteGroupBlob(url: string, auth: Event, opts: DeleteGroupBlobOptions = {}): Promise<GroupBlobDeleteOutcome> {
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  let target: URL
  try { target = new URL(url) } catch { return { status: 'failed', detail: 'File deletion authorisation could not be verified.' } }
  const host = target.hostname
  const hash = target.pathname.split('/').filter(Boolean).at(-1) ?? ''
  const bad = { status: 'failed', detail: 'File deletion authorisation could not be verified.' } as const
  // Owned as plain JSON before it is checked and encoded, so nothing can change it between the two.
  let captured: Event
  try { captured = JSON.parse(JSON.stringify(auth)) as Event } catch { return bad }
  const one = (name: string): string | undefined => {
    const tags = Array.isArray(captured?.tags) ? captured.tags.filter((t) => Array.isArray(t) && t[0] === name) : []
    return tags.length === 1 && typeof tags[0]![1] === 'string' ? tags[0]![1] : undefined
  }
  if (!HEX64.test(hash) || captured?.kind !== BLOSSOM_AUTH_KIND || one('t') !== 'delete' || one('x') !== hash || one('server') !== host ||
      (one('kithmoot-delete-target-v1') !== undefined && one('kithmoot-delete-target-v1') !== url) || !verifyEventUncached(captured)) return bad

  const timeout = opts.requestTimeoutMs ?? GROUP_REQUEST_TIMEOUT_MS
  const send = async (init: RequestInit): Promise<Response | undefined> => {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      return await doFetch(url, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error', signal: controller.signal })
    } catch { return undefined } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }
  const del = await send({ method: 'DELETE', headers: { Authorization: encodeBlossomAuthorisation(captured) } })
  if (!del) return { status: 'failed', detail: `Could not reach ${host}.` }
  drain(del)
  if (del.status === 409) return { status: 'failed', detail: `${host} holds the file again.` }
  if (del.status !== 200 && del.status !== 204 && del.status !== 404) {
    const reason = reasonOf(del)
    return { status: 'failed', detail: `${host} answered ${del.status}${reason ? `: ${reason.replace(/[^a-z0-9 -]/g, '')}` : ''}.` }
  }
  const unconfirmed = { status: 'deleted', detail: `deleted on ${host}, not confirmed (this device can no longer read there)` } as const
  if (opts.confirm) {
    let outcome: HeadOutcome
    try { outcome = await opts.confirm(url, hash) } catch { outcome = 'failed' }
    if (outcome === 'absent') return { status: 'deleted' }
    if (outcome === 'present') return { status: 'kept', detail: `${host} still serves the file.` }
    if (outcome === 'unconfirmed') return unconfirmed
    return { status: 'failed', detail: `Could not confirm file deletion on ${host}.` }
  }
  const check = await send({ method: 'HEAD' })
  if (!check) return { status: 'failed', detail: `Could not confirm file deletion on ${host}.` }
  drain(check)
  if (check.status === 401) return unconfirmed
  if (check.status === 404 || check.status === 410) return { status: 'deleted' }
  if (check.ok) return { status: 'kept', detail: `${host} still serves the file.` }
  return { status: 'failed', detail: `${host} answered ${check.status} when asked whether the file is gone.` }
}
