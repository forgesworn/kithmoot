import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils'
import type { GroupGrantStore } from '../src/group-grants-keeper.js'
import { parseGroupEvent, type GroupEvent } from '../src/group-grants.js'
import type { RoomAgent } from '../src/agent.js'
import { deriveRoom } from '../src/room.js'
import { localIdentity } from '../src/identity.js'
import { createDeviceCredential } from '../src/credential.js'
import { encodeRosterEvent } from '../src/roster.js'
import type { RosterEntry } from '../src/types.js'

/** A ledger store in memory, with a record of what happened to it. */
export class MemoryStore implements GroupGrantStore {
  text: string | undefined
  saves = 0
  moved: { at: number; text: string | undefined }[] = []
  onSave?: (json: string) => void
  constructor(text?: string) { this.text = text }
  async load(): Promise<string | undefined> { return this.text }
  async save(json: string): Promise<void> {
    this.onSave?.(json)
    this.text = json
    this.saves++
  }
  async moveAside(at: number): Promise<string | undefined> {
    this.moved.push({ at, text: this.text })
    this.text = undefined
    return `ledger.unreadable-${at}`
  }
}

export interface Post { host: string; event: GroupEvent; status: number; reason: string }

interface NodeGrant { createdAt: number; status: 'active' | 'revoked'; device: string; eventId: string; expiration: number; endedByReset: boolean }
interface NodeState { floor?: number; floorEventId?: string; grants: Map<string, NodeGrant> }

/**
 * Enough of a `wildbloomd` group node to judge a keeper's order of events:
 * rules 5 to 11 of the contract (`keeper`, the room list, `key-conflict` for an
 * owner, an enrolled keeper or a key of another group, `floor`, `stale`,
 * `revoked`, `scope-changed`, `scope-taken`), and the status and `X-Reason` the
 * real node answers. It answers over a `fetch`-shaped function, by host name.
 * `busyFirst` makes each host answer its first requests `503`, as a node that
 * is starting or rate limiting does.
 */
export class FakeNodes {
  readonly posts: Post[] = []
  readonly #state = new Map<string, NodeState>()
  readonly #offline = new Set<string>()
  readonly #hung = new Set<string>()
  readonly #script = new Map<string, { status: number; reason?: string; retryAfter?: number }[]>()
  now = 1_800_000_000
  /** Keys that may not be a group's device: the node owner, other enrolled keepers. */
  readonly reserved = new Set<string>()
  /** Rooms the keeper may open here; any when empty. */
  rooms: string[] = []
  /** The first this many requests to each host answer 503. */
  busyFirst = 0
  readonly #asked = new Map<string, number>()
  readonly #groupOf = new Map<string, string>()
  /** When set, the node's clock follows it instead of `now`. */
  clock?: () => number
  constructor(public keeper: string) {}
  get #at(): number { return this.clock ? this.clock() : this.now }

  setOffline(host: string, offline: boolean): void { if (offline) this.#offline.add(host); else this.#offline.delete(host) }
  hang(host: string, on: boolean): void { if (on) this.#hung.add(host); else this.#hung.delete(host) }
  /** The next answers this host gives, before it goes back to behaving. */
  script(host: string, ...answers: { status: number; reason?: string; retryAfter?: number }[]): void { this.#script.set(host, answers) }
  state(host: string): NodeState {
    let s = this.#state.get(host)
    if (!s) { s = { grants: new Map() }; this.#state.set(host, s) }
    return s
  }
  postsTo(host: string): Post[] { return this.posts.filter((p) => p.host === host) }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const host = url.hostname
    if (this.#hung.has(host)) return new Promise<Response>(() => {})
    if (this.#offline.has(host)) throw new TypeError('fetch failed')
    if (url.pathname !== '/groups/v1/events' || init?.method !== 'POST') return new Response(null, { status: 404 })
    const event = JSON.parse(String(init.body)) as GroupEvent
    const asked = (this.#asked.get(host) ?? 0) + 1
    this.#asked.set(host, asked)
    const scripted = this.#script.get(host)?.shift() ?? (asked <= this.busyFirst ? { status: 503, reason: 'busy' } : undefined)
    let status: number
    let reason: string
    let headers: Record<string, string> = {}
    if (scripted) {
      status = scripted.status
      reason = scripted.reason ?? ''
      if (scripted.retryAfter) headers = { 'retry-after': String(scripted.retryAfter) }
    } else [status, reason] = this.#judge(host, event)
    this.posts.push({ host, event, status, reason })
    return new Response(null, { status, headers: { ...(reason ? { 'x-reason': reason } : {}), ...headers } })
  }) as typeof fetch

  #judge(host: string, event: GroupEvent): [number, string] {
    const verdict = parseGroupEvent(event, { now: this.#at, keepers: [this.keeper], servers: [host] })
    if (!verdict.ok) return [verdict.status, verdict.reason]
    const p = verdict.parsed
    const s = this.state(host)
    if (this.rooms.length && !this.rooms.includes(p.roomId)) return [403, 'keeper']
    if (p.type === 'grant' && (this.reserved.has(p.device) || p.device === this.keeper)) return [409, 'key-conflict']
    if (p.type === 'grant') {
      const group = `${p.signer}|${p.roomId}`
      const held = this.#groupOf.get(`${host}|${p.device}`)
      if (held !== undefined && held !== group) return [409, 'key-conflict']
    }
    if (p.type === 'reset') {
      if (s.floor !== undefined && p.createdAt <= s.floor) return s.floorEventId === event.id ? [200, 'unchanged'] : [409, 'stale']
      s.floor = p.createdAt
      s.floorEventId = event.id
      for (const g of s.grants.values()) if (g.createdAt <= p.createdAt) g.endedByReset = true
      return [201, 'accepted']
    }
    if (s.floor !== undefined && p.createdAt <= s.floor) return [409, 'floor']
    const held = s.grants.get(p.grantId)
    if (held) {
      if (held.eventId === event.id) return [200, 'unchanged']
      if (held.device !== p.device) return [409, 'scope-changed']
      if (p.createdAt <= held.createdAt) return [409, 'stale']
      if (held.status === 'revoked' && p.status === 'active') return [409, 'revoked']
    } else if (p.status === 'active') {
      for (const g of s.grants.values()) {
        if (g.device === p.device && g.status === 'active' && !g.endedByReset && g.expiration > this.#at) return [409, 'scope-taken']
      }
    }
    this.#groupOf.set(`${host}|${p.device}`, `${p.signer}|${p.roomId}`)
    s.grants.set(p.grantId, { createdAt: p.createdAt, status: p.status, device: p.device, eventId: event.id, expiration: p.expiration, endedByReset: held?.endedByReset ?? false })
    return [201, 'accepted']
  }
}

export function newKey(): { sk: Uint8Array; pk: string } {
  const sk = generateSecretKey()
  return { sk, pk: getPublicKey(sk) }
}

export const hex32 = (): string => bytesToHex(generateSecretKey())

export async function waitFor(done: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms
  while (!done()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/**
 * A roster entry for a fresh participant and device, encrypted under epoch 0 of
 * the keeper's room: what somebody who kept the old epoch's key can still make
 * after a removal. Not published; the caller puts it on the relay.
 */
export async function oldEpochRosterEntry(keeper: RoomAgent, updatedAt: number): Promise<{ device: string; deviceSk: Uint8Array; participant: string; event: Event }> {
  const { roomId, roomKey } = deriveRoom(keeper.keeperState!.secret)
  const participantSk = generateSecretKey()
  const deviceSk = generateSecretKey()
  const device = getPublicKey(deviceSk)
  const credential = await createDeviceCredential({ identity: localIdentity(participantSk), devicePubkey: device, roomId, expiresAt: updatedAt + 3600 })
  const entry: RosterEntry = { participant: getPublicKey(participantSk), device, credential, tracks: [], claims: {}, updatedAt }
  return { device, deviceSk, participant: entry.participant, event: encodeRosterEvent(entry, { roomId, roomKey, deviceSk }) }
}
