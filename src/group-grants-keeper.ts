import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils'
import type { ControlMessage } from './control.js'
import {
  GRANT_LIFETIME_SECONDS, GRANT_RENEW_WITHIN_SECONDS, KEEPER_SCOPES, buildGrant, buildReset, canonicalBytes, groupNodeFromBase,
  newGrantId, nextCreatedAt, parseGroupEvent, type GrantScope, type GroupEvent, type GroupNode,
} from './group-grants.js'

/**
 * The keeper's side of group storage (phase S4 of KithMoot's group-hosted
 * design; contract: wildbloom-node `docs/GROUP-GRANTS.md`, profile
 * `group-grants/1`). When a keeper is configured with group storage nodes it
 * signs a grant with the room's authority key for each admitted device at each
 * node, sends it to the device inside the room's encrypted control channel,
 * pushes it to the node by HTTP, renews it before it lapses, revokes it when a
 * host removes the participant, and signs a reset when the room closes.
 *
 * Everything here is optional: a keeper given no `GroupGrantsConfig` never
 * constructs this class. Nothing here publishes a grant on a relay.
 *
 * Concurrency: every change to the ledger, and nothing else, goes through one
 * queue (`#queue`). Neither HTTP pushes nor control-channel posts do: the
 * journal worker pushes from its own timer and posts are sent after the queue
 * task that decided them, so a slow node or relay never delays a removal. The
 * only pushes a caller waits for are the bounded bursts of a removal and a
 * close. An event is pushed only once a successful save has recorded it (a
 * revocation or a reset may go earlier: they end grants, never add them), and
 * a removal never depends on the ledger being writable.
 */

/** Devices one participant may have with a live grant (decision O5). */
export const MAX_DEVICES_PER_PARTICIPANT = 5
const MAX_GRANTS = 4_096
const REPORT_MAX = 140
const REANNOUNCE_SECONDS = 600
const ANSWER_INTERVAL_SECONDS = 30
const KEEP_ENDED_SECONDS = 86_400
const KEEP_STOPPED_SECONDS = 7 * 86_400
const UNCONFIGURED_NODE_SECONDS = 86_400
const SEND_TIMEOUT_MS = 10_000
const SEND_TOTAL_MS = 20_000
const SEND_CONCURRENCY = 6
const MAX_RETRY_AFTER_MS = 86_400_000
const COOLDOWN_BASE_SECONDS = 3_600
const COOLDOWN_MAX_SECONDS = 86_400

/** Where the ledger lives. The CLI gives a file beside the keeper's state. */
export interface GroupGrantStore {
  load(): Promise<string | undefined>
  save(json: string): Promise<void>
  /** Move the current ledger aside, never deleting it. Returns where it went. */
  moveAside(unixSeconds: number): Promise<string | undefined>
}

export interface GroupGrantsConfig {
  /** Base URLs of the group nodes (`http` or `https`; the `server` tag is each one's host name). */
  nodes: readonly string[]
  /** The per-device byte ceiling. No default: whoever configures the nodes chooses it. */
  bytes: bigint | number | string
  store: GroupGrantStore
  /** After an unreadable ledger, move it aside and sign a reset at every node first (`--group-reset`). */
  resetUnreadable?: boolean
  log?: (line: string) => void
  /** Tests: the HTTP client, randomness, wall clock in milliseconds, and timings. */
  fetch?: typeof fetch
  randomBytes?: (n: number) => Uint8Array
  clockMs?: () => number
  backoff?: { baseMs: number; maxMs: number }
  /** How long a removal or a close waits for nodes before it goes on (default 5 s). */
  pushBudgetMs?: number
  pushTimeoutMs?: number
  /** How often the sweep (mint and renew) runs (default an hour). */
  sweepIntervalMs?: number
  /** Coalescing delay after a roster change (default 200 ms). */
  rosterDelayMs?: number
}

/** What the keeper needs from the room. `RoomAgent` supplies it. */
export interface GroupGrantHost {
  roomId: string
  authoritySk: Uint8Array
  /** The keeper's own participant: the `host` of the errors it reports. */
  keeperParticipant: string
  /** Unix seconds. */
  now(): number
  /** Devices heard in the current epoch, with a credential valid now, and who each speaks for. */
  devices(): { device: string; participant: string }[]
  removed(): ReadonlySet<string>
  /** One message on the room's control channel. */
  send(op: ControlMessage): Promise<void>
  /** Complete a removal the keeper had begun before it stopped. */
  removeParticipant(participant: string): Promise<void>
}

type RecordStatus = 'active' | 'revoked' | 'ended'

export interface GrantRecord {
  id: string
  device: string
  participant: string
  server: string
  /** The newest `created_at` signed for this id. */
  createdAt: number
  /** The latest `expiration` signed for this id. */
  expiration: number
  status: RecordStatus
  scopes: GrantScope[]
  bytes: string
  /** The newest event signed for this id. */
  event: GroupEvent
  /** Whether that event has been sent in the room. */
  posted: boolean
  /** Whether a node has ever accepted an event for this id. Absent in an older ledger: taken as true. */
  recorded?: boolean
  /** A renewal was refused for good: sign a later one at the next look, whatever the lifetime left. */
  needsRenewal?: boolean
}

export interface JournalEntry {
  server: string
  kind: 'grant' | 'revoked' | 'reset'
  grantId?: string
  device?: string
  event: GroupEvent
  tries: number
  /** Wall-clock milliseconds before which it is not tried. */
  nextAt: number
  since: number
  stopped?: string
  stoppedAt?: number
  reported?: boolean
}

interface RefusedDevice { participant: string; device: string; since: number; reported?: boolean }
interface ResetRecord { server: string; event: GroupEvent; posted: boolean }

export interface GroupGrantLedger {
  v: 1
  bases: Record<string, string>
  floors: Record<string, number>
  grants: GrantRecord[]
  journal: JournalEntry[]
  removing: string[]
  refused: RefusedDevice[]
  resets: ResetRecord[]
  /** Per node and device (`server|device`): no new grant is signed before `until` (unix seconds) after a refusal. */
  cooldown?: Record<string, { until: number; n: number }>
}

const emptyLedger = (): GroupGrantLedger => ({ v: 1, bases: {}, floors: {}, grants: [], journal: [], removing: [], refused: [], resets: [], cooldown: {} })

/** A ledger read (or made) before the room is joined. */
export interface PreparedLedger {
  ledger: GroupGrantLedger
  /** Sign a reset at every node before anything else. */
  resetting: boolean
}

/** Read a ledger's JSON, checking every event it holds. Throws on anything unusable. */
export function parseLedger(json: string): GroupGrantLedger {
  const raw = JSON.parse(json) as Partial<GroupGrantLedger>
  if (raw.v !== 1 || typeof raw.bases !== 'object' || raw.bases === null || typeof raw.floors !== 'object' || raw.floors === null ||
      !Array.isArray(raw.grants) || !Array.isArray(raw.journal) || !Array.isArray(raw.removing) || !Array.isArray(raw.refused) || !Array.isArray(raw.resets)) {
    throw new Error('not a group grant ledger')
  }
  const eventOk = (e: unknown): boolean => parseGroupEvent(e).ok
  for (const g of raw.grants) {
    if (!g || typeof g.id !== 'string' || typeof g.device !== 'string' || typeof g.participant !== 'string' || typeof g.server !== 'string' ||
        !Number.isSafeInteger(g.createdAt) || !Number.isSafeInteger(g.expiration) || !['active', 'revoked', 'ended'].includes(g.status) ||
        !Array.isArray(g.scopes) || typeof g.bytes !== 'string' || typeof g.posted !== 'boolean' || !eventOk(g.event)) throw new Error('a grant record is damaged')
  }
  for (const j of raw.journal) {
    if (!j || typeof j.server !== 'string' || !['grant', 'revoked', 'reset'].includes(j.kind) || !Number.isSafeInteger(j.tries) ||
        typeof j.nextAt !== 'number' || typeof j.since !== 'number' || !eventOk(j.event)) throw new Error('a journal entry is damaged')
  }
  for (const r of raw.resets) if (!r || typeof r.server !== 'string' || !eventOk(r.event) || typeof r.posted !== 'boolean') throw new Error('a reset record is damaged')
  if (!raw.removing.every((p) => typeof p === 'string') || !raw.refused.every((r) => r && typeof r.device === 'string' && typeof r.participant === 'string')) throw new Error('the ledger is damaged')
  return raw as GroupGrantLedger
}

const live = (r: GrantRecord, now: number): boolean => r.status === 'active' && r.expiration > now
const short = (hex: string): string => hex.slice(0, 8)

type PushOutcome = { kind: 'done' } | { kind: 'retry'; after?: number } | { kind: 'stop'; reason: string }

interface Outgoing { id: string; event: GroupEvent }

/** 409 answers that mean the node already knows this or a newer event for the id: not a refusal. */
const BENIGN_409 = new Set(['stale', 'revoked', 'unchanged'])

export class GroupGrantKeeper {
  readonly #config: GroupGrantsConfig
  readonly #host: GroupGrantHost
  readonly #nodes: GroupNode[]
  readonly #bytes: string
  readonly #fetch: typeof fetch
  readonly #random: (n: number) => Uint8Array
  readonly #clockMs: () => number
  readonly #log: (line: string) => void
  #ledger: GroupGrantLedger
  #queue: Promise<unknown> = Promise.resolve()
  #busy = 0
  #closing = false
  #closed = false
  #resetting: boolean
  #dirty = false
  #capReported = false
  #sweepTimer?: ReturnType<typeof setInterval>
  #rosterTimer?: ReturnType<typeof setTimeout>
  #pumpTimer?: ReturnType<typeof setTimeout>
  /** Journal entries added since the last successful save: not to be pushed (a grant) until recorded. */
  readonly #unsaved = new Set<JournalEntry>()
  readonly #inflight = new Map<string, Promise<void>>()
  readonly #posting = new Set<string>()
  readonly #answered = new Map<string, number>()
  readonly #announced = new Map<string, number>()

  private constructor(config: GroupGrantsConfig, host: GroupGrantHost, nodes: GroupNode[], bytes: string, prepared: PreparedLedger) {
    this.#config = config
    this.#host = host
    this.#nodes = nodes
    this.#bytes = bytes
    this.#ledger = prepared.ledger
    this.#ledger.cooldown ??= {}
    this.#resetting = prepared.resetting
    this.#fetch = config.fetch ?? ((input, init) => fetch(input, init))
    this.#random = config.randomBytes ?? nobleRandomBytes
    this.#clockMs = config.clockMs ?? (() => Date.now())
    this.#log = config.log ?? (() => {})
  }

  /** Refuse a configuration that cannot work, before anything is dialled. Returns what it parsed. */
  static validate(config: GroupGrantsConfig): { nodes: GroupNode[]; bytes: string } {
    if (!config.nodes.length) throw new Error('group grants need at least one group node')
    if (config.bytes === undefined || config.bytes === null || config.bytes === '') {
      throw new Error('group grants need a byte ceiling per device: it is the node owner\'s choice and has no default')
    }
    const nodes = config.nodes.map(groupNodeFromBase)
    const servers = nodes.map((n) => n.server)
    const dup = servers.find((s, i) => servers.indexOf(s) !== i)
    if (dup) throw new Error(`group node ${dup} is listed twice (two nodes may not share a host name: the grants would be identical)`)
    return { nodes, bytes: canonicalBytes(config.bytes) }
  }

  /**
   * Read the ledger, before the room is joined or a relay dialled. An unreadable
   * one stops the start (naming `--group-reset`) unless the flag was given, when
   * it is moved aside, never deleted. A missing one for a room that already
   * existed is a lost one (a keeper moved to another machine, a restore that
   * left the sidecar behind): a reset is signed at every node before anything
   * is minted, so no grant the keeper no longer remembers can outlive the next
   * removal. A brand-new room has nothing to reset.
   */
  static async prepare(config: GroupGrantsConfig, opts: { roomExisted?: boolean; now: () => number }): Promise<PreparedLedger> {
    GroupGrantKeeper.validate(config)
    const log = config.log ?? (() => {})
    const text = await config.store.load()
    if (text !== undefined) {
      try {
        const ledger = parseLedger(text)
        if (config.resetUnreadable) log('group grants: the ledger is readable, so --group-reset is not needed and is ignored')
        return { ledger, resetting: false }
      } catch (error) {
        if (!config.resetUnreadable) {
          throw new Error(`the group grant ledger cannot be read (${error instanceof Error ? error.message : 'damaged'}). ` +
            'Its file is left as it is. To start anyway, sign a reset at every group node and issue fresh grants, run with --group-reset: ' +
            'the unreadable file is moved aside, never deleted.')
        }
        const moved = await config.store.moveAside(opts.now())
        log(`group grants: the ledger was unreadable; moved aside${moved ? ' as ' + moved : ''}`)
        return { ledger: emptyLedger(), resetting: true }
      }
    }
    if (opts.roomExisted === true) {
      log('group grants: this room existed but has no grant ledger (moved or restored without it, or grants only now switched on): signing a reset at every node before any new grant')
      return { ledger: emptyLedger(), resetting: true }
    }
    return { ledger: emptyLedger(), resetting: config.resetUnreadable === true }
  }

  /** Get ready. `prepared` comes from `prepare`; without it the room is taken as new. */
  static async open(config: GroupGrantsConfig, host: GroupGrantHost, prepared?: PreparedLedger): Promise<GroupGrantKeeper> {
    const { nodes, bytes } = GroupGrantKeeper.validate(config)
    const ready = prepared ?? await GroupGrantKeeper.prepare(config, { roomExisted: false, now: () => host.now() })
    const keeper = new GroupGrantKeeper(config, host, nodes, bytes, ready)
    for (const n of nodes) keeper.#ledger.bases[n.server] = n.base
    return keeper
  }

  /** Complete any removal begun before a stop, reset first if needed, mint, and start the timers. */
  async start(): Promise<void> {
    await this.#run(async () => {
      if (this.#resetting) {
        const now = this.#host.now()
        for (const n of this.#nodes) this.#signReset(n.server, now)
        this.#resetting = false
        this.#log(`group grants: signed a reset at ${this.#nodes.length} node${this.#nodes.length === 1 ? '' : 's'} before issuing new grants`)
        this.#touch()
        await this.#saveSafe()
      }
    })
    for (const p of [...this.#ledger.removing]) {
      try {
        if (this.#host.removed().has(p)) await this.afterRemoval(p)
        else await this.#host.removeParticipant(p)
      } catch (error) {
        this.#log(`group grants: could not finish the removal of ${short(p)}: ${error instanceof Error ? error.message : 'failed'}`)
      }
    }
    await this.sweep()
    const interval = this.#config.sweepIntervalMs ?? 3_600_000
    this.#sweepTimer = setInterval(() => { void this.sweep().catch(() => {}) }, interval)
    ;(this.#sweepTimer as unknown as { unref?: () => void }).unref?.()
    this.#kick()
  }

  close(): void {
    this.#closed = true
    this.#stopTimers()
  }

  #stopTimers(): void {
    if (this.#sweepTimer !== undefined) clearInterval(this.#sweepTimer)
    if (this.#rosterTimer !== undefined) clearTimeout(this.#rosterTimer)
    if (this.#pumpTimer !== undefined) clearTimeout(this.#pumpTimer)
    this.#sweepTimer = this.#rosterTimer = this.#pumpTimer = undefined
  }

  /** A copy of the ledger, for tests and diagnostics. Holds no secret. */
  get ledger(): Readonly<GroupGrantLedger> {
    return JSON.parse(JSON.stringify(this.#ledger)) as GroupGrantLedger
  }

  // -------------------------------------------------------------------------
  // The queue, and saving
  // -------------------------------------------------------------------------

  #run<T>(task: () => Promise<T>): Promise<T> {
    this.#busy++
    const run = this.#queue.then(task, task)
    this.#queue = run.then(() => undefined, () => undefined).finally(() => { this.#busy--; if (this.#busy === 0) this.#kick() })
    return run
  }

  #touch(): void { this.#dirty = true }

  /** Save the whole ledger. Only a successful save lets grants in it be pushed. */
  async #save(): Promise<void> {
    this.#prune(this.#host.now())
    const json = JSON.stringify(this.#ledger)
    await this.#config.store.save(json)
    this.#unsaved.clear()
    this.#dirty = false
  }

  /** Save, and if that fails say so loudly and go on: nothing that matters more than the ledger waits for it. */
  async #saveSafe(): Promise<boolean> {
    try { await this.#save(); return true } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? 'error'
      this.#log(`group grants: could not save the ledger (${code}); what it holds stays in memory, no new grant is pushed until it can be saved, and removals still go ahead`)
      const now = this.#host.now()
      const last = this.#announced.get('save')
      if (last === undefined || now - last >= REANNOUNCE_SECONDS) {
        this.#announced.set('save', now)
        void this.#send({ op: 'error', host: this.#host.keeperParticipant, message: `Group grants could not be saved (${code}). New grants wait; removals still go ahead. Check the keeper's disk.`.slice(0, REPORT_MAX) })
      }
      return false
    }
  }

  #prune(now: number): void {
    const l = this.#ledger
    l.grants = l.grants.filter((g) => g.status === 'active' || g.expiration + KEEP_ENDED_SECONDS > now)
    l.resets = l.resets.filter((r) => this.#expirationOf(r.event) > now)
    const nowMs = this.#clockMs()
    let expired = 0
    l.journal = l.journal.filter((j) => {
      if (j.stopped) return (j.stoppedAt ?? 0) + KEEP_STOPPED_SECONDS * 1000 > nowMs
      if (this.#expirationOf(j.event) <= now) { expired++; this.#unsaved.delete(j); return false }
      if (!this.#nodes.some((n) => n.server === j.server) && j.since + UNCONFIGURED_NODE_SECONDS * 1000 < nowMs) {
        this.#log(`group grants: gave up on an event for ${j.server}, a node that is no longer configured`)
        this.#unsaved.delete(j)
        return false
      }
      return true
    })
    if (expired) this.#log(`group grants: dropped ${expired} journal event${expired === 1 ? '' : 's'} that ran out before a node could take ${expired === 1 ? 'it' : 'them'}`)
    const cd = l.cooldown ?? (l.cooldown = {})
    for (const [key, c] of Object.entries(cd)) if (c.until + KEEP_STOPPED_SECONDS < now) delete cd[key]
  }

  #expirationOf(event: GroupEvent): number {
    const t = event.tags.find((x) => x[0] === 'expiration')
    return t ? Number(t[1]) : 0
  }

  // -------------------------------------------------------------------------
  // Signing
  // -------------------------------------------------------------------------

  #floor(server: string): number | undefined { return this.#ledger.floors[server] }

  #signReset(server: string, now: number): void {
    const createdAt = nextCreatedAt(now, this.#floor(server))
    const event = buildReset({ authoritySk: this.#host.authoritySk, roomId: this.#host.roomId, server, createdAt })
    this.#ledger.floors[server] = createdAt
    this.#ledger.resets = this.#ledger.resets.filter((r) => r.server !== server)
    this.#ledger.resets.push({ server, event, posted: false })
    // A reset ends what the node holds that is not newer than it; what we had not yet delivered is older, so it is moot.
    this.#ledger.journal = this.#ledger.journal.filter((j) => j.server !== server || j.stopped !== undefined)
    for (const g of this.#ledger.grants) if (g.server === server && g.status === 'active') g.status = 'ended'
    this.#addJournal({ server, kind: 'reset', event })
  }

  #addJournal(entry: { server: string; kind: JournalEntry['kind']; event: GroupEvent; grantId?: string; device?: string }): void {
    // A newer event for the same grant id replaces an older one not yet delivered: the node would answer it 409 stale.
    if (entry.grantId) this.#ledger.journal = this.#ledger.journal.filter((j) => !(j.server === entry.server && j.grantId === entry.grantId && !j.stopped))
    const added: JournalEntry = { ...entry, tries: 0, nextAt: 0, since: this.#clockMs() }
    this.#ledger.journal.push(added)
    this.#unsaved.add(added)
    this.#touch()
  }

  #mint(device: string, participant: string, server: string, now: number): GrantRecord {
    const id = newGrantId(this.#random)
    const createdAt = nextCreatedAt(now, this.#floor(server))
    const expiration = createdAt + GRANT_LIFETIME_SECONDS
    const scopes = [...KEEPER_SCOPES]
    const event = buildGrant({
      authoritySk: this.#host.authoritySk, roomId: this.#host.roomId, device, server, scopes, bytes: this.#bytes, grantId: id, createdAt, expiration,
    })
    const record: GrantRecord = { id, device, participant, server, createdAt, expiration, status: 'active', scopes, bytes: this.#bytes, event, posted: false, recorded: false }
    this.#ledger.grants.push(record)
    this.#addJournal({ server, kind: 'grant', grantId: id, device, event })
    return record
  }

  #renew(record: GrantRecord, now: number): void {
    const createdAt = nextCreatedAt(now, record.createdAt, this.#floor(record.server))
    const expiration = createdAt + GRANT_LIFETIME_SECONDS
    const event = buildGrant({
      authoritySk: this.#host.authoritySk, roomId: this.#host.roomId, device: record.device, server: record.server, scopes: record.scopes,
      bytes: this.#bytes, grantId: record.id, createdAt, expiration,
    })
    record.createdAt = createdAt
    record.expiration = expiration
    record.bytes = this.#bytes
    record.event = event
    record.posted = false
    delete record.needsRenewal
    this.#addJournal({ server: record.server, kind: 'grant', grantId: record.id, device: record.device, event })
  }

  /** Sign the revocation of a live grant. A grant already past its end cannot be revoked and needs no revoking. */
  #revoke(record: GrantRecord, now: number): GroupEvent | undefined {
    if (record.status !== 'active') return undefined
    const createdAt = nextCreatedAt(now, record.createdAt, this.#floor(record.server))
    if (createdAt >= record.expiration) { record.status = 'ended'; this.#touch(); return undefined }
    const event = buildGrant({
      authoritySk: this.#host.authoritySk, roomId: this.#host.roomId, device: record.device, server: record.server, scopes: record.scopes,
      bytes: record.bytes, grantId: record.id, createdAt, expiration: record.expiration, status: 'revoked',
    })
    record.status = 'revoked'
    record.createdAt = createdAt
    record.event = event
    record.posted = false
    this.#addJournal({ server: record.server, kind: 'revoked', grantId: record.id, device: record.device, event })
    return event
  }

  #cooling(server: string, device: string, now: number): boolean {
    const c = this.#ledger.cooldown?.[`${server}|${device}`]
    return c !== undefined && c.until > now
  }

  /** After a refusal for good, wait longer each time before signing for this device at this node again. */
  #coolDown(server: string, device: string, now: number): void {
    const cd = this.#ledger.cooldown ?? (this.#ledger.cooldown = {})
    const key = `${server}|${device}`
    const n = (cd[key]?.n ?? 0) + 1
    cd[key] = { n, until: now + Math.min(COOLDOWN_MAX_SECONDS, COOLDOWN_BASE_SECONDS * 2 ** Math.min(n - 1, 10)) }
  }

  // -------------------------------------------------------------------------
  // Mint and renew
  // -------------------------------------------------------------------------

  /** A roster change: look again shortly, coalescing a burst into one sweep. */
  noteRoster(): void {
    if (this.#closed || this.#closing || this.#rosterTimer !== undefined) return
    this.#rosterTimer = setTimeout(() => {
      this.#rosterTimer = undefined
      void this.sweep().catch(() => {})
    }, this.#config.rosterDelayMs ?? 200)
    ;(this.#rosterTimer as unknown as { unref?: () => void }).unref?.()
  }

  /**
   * Mint for every admitted device that has no grant at a configured node,
   * renew those with 10 days or less left, revoke what belongs to a removed
   * participant, and send in the room whatever has not been sent. Does nothing
   * once a close has begun: a closed room is granted nothing.
   */
  sweep(): Promise<void> {
    if (this.#closed || this.#closing) return Promise.resolve()
    return this.#run(() => this.#sweepTask()).then(() => this.#flushPosts())
  }

  async #sweepTask(): Promise<void> {
    if (this.#closed || this.#closing) return
    const now = this.#host.now()
    // Somebody being removed counts as removed from the moment the ledger records it, before their rekey exists.
    const removed = new Set([...this.#host.removed(), ...this.#ledger.removing])
    const heard = this.#host.devices()
    const heardBy = new Map(heard.map((d) => [d.device, d.participant]))
    let capHit = false

    for (const g of this.#ledger.grants) if (g.status === 'active' && g.expiration <= now) { g.status = 'ended'; this.#touch() }
    // A safety net: a participant removed by any route has nothing live.
    for (const g of this.#ledger.grants) if (live(g, now) && removed.has(g.participant)) this.#revoke(g, now)

    for (const { device, participant } of heard) {
      if (removed.has(participant)) continue
      // A device that now speaks for somebody else: the old grant goes, a new one is issued (rule 11 wants the old revoked first).
      for (const g of this.#ledger.grants) if (g.device === device && live(g, now) && g.participant !== participant) this.#revoke(g, now)
      const mine = this.#ledger.grants.filter((g) => g.device === device && live(g, now))
      const needs = this.#nodes.filter((n) => !mine.some((g) => g.server === n.server) && !this.#cooling(n.server, device, now))
      if (needs.length) {
        if (!mine.length && this.#liveDevices(participant, now).size >= MAX_DEVICES_PER_PARTICIPANT) {
          if (!this.#ledger.refused.some((r) => r.device === device)) {
            this.#ledger.refused.push({ participant, device, since: now })
            this.#touch()
            this.#log(`group grants: ${short(participant)} already has ${MAX_DEVICES_PER_PARTICIPANT} devices with grants; device ${short(device)} was not given one`)
          }
        } else if (this.#ledger.grants.length < MAX_GRANTS) {
          for (const n of needs) this.#mint(device, participant, n.server, now)
          this.#ledger.refused = this.#ledger.refused.filter((r) => r.device !== device)
          this.#touch()
        } else capHit = true
      }
      for (const g of mine) {
        const due = g.needsRenewal === true || g.expiration - now <= GRANT_RENEW_WITHIN_SECONDS
        if (due && g.participant === participant && this.#nodes.some((n) => n.server === g.server) && !this.#cooling(g.server, g.device, now)) this.#renew(g, now)
      }
    }
    // A refused device that has gone, or whose person was removed, is not a problem any more.
    const before = this.#ledger.refused.length
    this.#ledger.refused = this.#ledger.refused.filter((r) => heardBy.get(r.device) === r.participant && !removed.has(r.participant))
    if (this.#ledger.refused.length !== before) this.#touch()
    const fresh = this.#ledger.refused.filter((r) => !r.reported)
    for (const r of fresh) { r.reported = true; this.#touch() }

    if (this.#dirty) await this.#saveSafe()
    if (fresh.length) {
      this.#announced.set('refused', now)
      void this.#send({ op: 'error', host: this.#host.keeperParticipant, message: this.#refusedMessage() })
    }
    if (capHit && !this.#capReported) {
      this.#capReported = true
      this.#log(`group grants: ${MAX_GRANTS} grant records are held; no more are signed until some end`)
      void this.#send({ op: 'error', host: this.#host.keeperParticipant, message: `Group grants: the keeper holds ${MAX_GRANTS} records and will sign no more until some end.`.slice(0, REPORT_MAX) })
    }
  }

  #liveDevices(participant: string, now: number): Set<string> {
    return new Set(this.#ledger.grants.filter((g) => g.participant === participant && live(g, now)).map((g) => g.device))
  }

  // -------------------------------------------------------------------------
  // The control channel: never on the queue
  // -------------------------------------------------------------------------

  async #send(op: ControlMessage): Promise<boolean> {
    try {
      await Promise.race([
        this.#host.send(op),
        new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error('timed out')), SEND_TIMEOUT_MS); (t as unknown as { unref?: () => void }).unref?.() }),
      ])
      return true
    } catch { return false }
  }

  /** Send events in the room, a few at a time, giving up waiting after `totalMs`. Returns the ids sent by then. */
  async #sendAll(events: readonly Outgoing[], totalMs = SEND_TOTAL_MS): Promise<Set<string>> {
    const ok = new Set<string>()
    if (!events.length) return ok
    let next = 0
    let over = false
    const worker = async (): Promise<void> => {
      while (!over && next < events.length) {
        const e = events[next++]!
        if (await this.#send({ op: 'storage-grant', event: e.event })) ok.add(e.id)
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, events.length) }, worker)),
      new Promise<void>((resolve) => { timer = setTimeout(() => { over = true; resolve() }, totalMs); (timer as unknown as { unref?: () => void }).unref?.() }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    over = true
    return new Set(ok)
  }

  /**
   * In the room, whatever has not been sent: grants, renewals, revocations,
   * resets, one event per op. The events are chosen under the queue, sent
   * outside it, and marked sent under it again, so a slow relay never stands
   * between a removal and its rekey. Revocations of a participant being removed
   * wait for `afterRemoval`: they belong in the new epoch.
   */
  async #flushPosts(totalMs = SEND_TOTAL_MS): Promise<void> {
    if (this.#closed) return
    const batch = await this.#run(async () => {
      const out: { id: string; event: GroupEvent; grant?: string; reset?: string }[] = []
      for (const g of this.#ledger.grants) {
        if (g.posted) continue
        if (g.status === 'ended') { g.posted = true; this.#touch(); continue }
        if (g.status === 'revoked' && this.#ledger.removing.includes(g.participant)) continue
        if (this.#posting.has(g.event.id)) continue
        out.push({ id: g.event.id, event: g.event, grant: g.id })
      }
      for (const r of this.#ledger.resets) {
        if (r.posted || this.#posting.has(r.event.id)) continue
        out.push({ id: r.event.id, event: r.event, reset: r.server })
      }
      for (const o of out) this.#posting.add(o.id)
      return out
    })
    if (!batch.length) return
    let sent = new Set<string>()
    try { sent = await this.#sendAll(batch, totalMs) } finally {
      await this.#run(async () => {
        for (const o of batch) {
          this.#posting.delete(o.id)
          if (!sent.has(o.id)) continue
          const g = o.grant ? this.#ledger.grants.find((x) => x.id === o.grant && x.event.id === o.id) : undefined
          const r = o.reset ? this.#ledger.resets.find((x) => x.server === o.reset && x.event.id === o.id) : undefined
          if (g) g.posted = true
          if (r) r.posted = true
        }
        if (sent.size) { this.#touch(); await this.#saveSafe() }
      })
    }
  }

  // -------------------------------------------------------------------------
  // storage-grant? and what the hosts are told
  // -------------------------------------------------------------------------

  /** A device asked for its grants (the asker is the message's credential-bound device). */
  answer(device: string, participant: string): Promise<void> {
    if (this.#closed || this.#closing) return Promise.resolve()
    const now = this.#host.now()
    const last = this.#answered.get(device)
    if (last !== undefined && now - last < ANSWER_INTERVAL_SECONDS) return Promise.resolve()
    if (this.#host.removed().has(participant)) return Promise.resolve()
    this.#answered.set(device, now)
    if (this.#answered.size > 4_096) this.#answered.delete(this.#answered.keys().next().value!)
    return this.sweep().then(async () => {
      if (this.#closed || this.#closing) return
      const events = await this.#run(async () => {
        const at = this.#host.now()
        return this.#ledger.grants.filter((g) => g.device === device && g.participant === participant && live(g, at)).map((g) => ({ id: g.event.id, event: g.event }))
      })
      await this.#sendAll(events)
    })
  }

  /** Tell the room about open problems again for somebody who has just arrived, at most every ten minutes per problem. */
  announceProblems(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    const now = this.#host.now()
    const problems = new Map<string, string>()
    for (const j of this.#ledger.journal) if (j.stopped) problems.set(`${j.server}/${j.stopped}`, this.#stoppedMessage(j.server, j.kind, j.stopped))
    if (this.#ledger.refused.length) problems.set('refused', this.#refusedMessage())
    return (async () => {
      for (const [key, message] of problems) {
        const last = this.#announced.get(key)
        if (last !== undefined && now - last < REANNOUNCE_SECONDS) continue
        this.#announced.set(key, now)
        await this.#send({ op: 'error', host: this.#host.keeperParticipant, message })
      }
    })()
  }

  #stoppedMessage(server: string, kind: string, reason: string): string {
    const what = kind === 'reset' ? 'a reset' : kind === 'revoked' ? 'a revocation' : 'a grant'
    let text: string
    if (reason.includes('scope-taken')) text = `Group storage ${server} already holds another live grant for one of this room's devices. Restart the keeper with --group-reset to clear it.`
    else if (reason.includes('floor')) text = `Group storage ${server} refused ${what} dated before a reset. The keeper will sign a later one.`
    else if (reason.includes('keeper') || reason.includes('server') || reason.includes('key-conflict')) text = `Group storage ${server} refused ${what} (${reason}). Ask whoever runs it to check it names this room's keeper and host name.`
    else text = `Group storage ${server} refused ${what} (${reason}).`
    return text.slice(0, REPORT_MAX)
  }

  #refusedMessage(): string {
    return `${this.#ledger.refused.length} device${this.#ledger.refused.length === 1 ? ' was' : 's were'} not given group storage: ${MAX_DEVICES_PER_PARTICIPANT} per person is the most.`.slice(0, REPORT_MAX)
  }

  // -------------------------------------------------------------------------
  // Removal (4.8) and close
  // -------------------------------------------------------------------------

  /**
   * Before the rekey of a removal: record it, sign `revoked` for every grant id
   * issued to any device of the participant at every node, and push every
   * revocation still owed for them, waiting no longer than the push budget.
   * Never throws for want of a writable ledger: if the ledger cannot be saved
   * the revocations stay in memory, are pushed all the same (they only end
   * grants), and the hosts are told; the removal itself does not wait for disk.
   */
  async beforeRemoval(participant: string): Promise<void> {
    const ids = await this.#run(async () => {
      const now = this.#host.now()
      if (!this.#ledger.removing.includes(participant)) this.#ledger.removing.push(participant)
      for (const g of this.#ledger.grants) if (g.participant === participant) this.#revoke(g, now)
      this.#ledger.refused = this.#ledger.refused.filter((r) => r.participant !== participant)
      this.#touch()
      await this.#saveSafe()
      return new Set(this.#ledger.grants.filter((g) => g.participant === participant).map((g) => g.id))
    })
    await this.#pushNow((j) => j.kind === 'revoked' && j.grantId !== undefined && ids.has(j.grantId))
  }

  /** After the rekey: close the record and send the revocations in the room (now in the new epoch). */
  async afterRemoval(participant: string): Promise<void> {
    await this.#run(async () => {
      this.#ledger.removing = this.#ledger.removing.filter((p) => p !== participant)
      this.#touch()
      await this.#saveSafe()
    })
    await this.#flushPosts()
  }

  /**
   * Before the closing rekey: from this moment nothing is minted, renewed or
   * answered; a reset is signed at every node, sent in the room, and pushed
   * within the push budget. The flag is set in the same queue task that signs
   * the resets, so no sweep can slip a grant in after them.
   */
  async beforeClose(): Promise<void> {
    await this.#run(async () => {
      this.#closing = true
      this.#stopTimers()
      const now = this.#host.now()
      const servers = new Set([...this.#nodes.map((n) => n.server), ...Object.keys(this.#ledger.bases)])
      for (const s of servers) this.#signReset(s, now)
      this.#touch()
      await this.#saveSafe()
    })
    const budget = this.#config.pushBudgetMs ?? 5_000
    await this.#flushPosts(budget)
    await this.#pushNow((j) => j.kind === 'reset')
    this.#closed = true
  }

  // -------------------------------------------------------------------------
  // The push journal (7.2)
  // -------------------------------------------------------------------------

  #orderKey(j: JournalEntry): string | undefined {
    return j.kind === 'reset' ? undefined : `${j.server}|${j.device}`
  }

  /** A grant is pushed only once a save has recorded it; a revocation or a reset only ends grants and may go at once. */
  #pushable(j: JournalEntry): boolean { return j.kind !== 'grant' || !this.#unsaved.has(j) }

  /**
   * The entries that are next in line: for one node, a pending reset comes
   * before everything else, and for one device at one node events go in the
   * order they were signed. Stopped entries block nothing; an entry waiting to
   * be saved holds its place.
   */
  #heads(): JournalEntry[] {
    const resetAt = new Set(this.#ledger.journal.filter((j) => !j.stopped && j.kind === 'reset').map((j) => j.server))
    const blocked = new Set<string>()
    const out: JournalEntry[] = []
    for (const j of this.#ledger.journal) {
      if (j.stopped) continue
      if (j.kind !== 'reset' && resetAt.has(j.server)) continue
      const key = this.#orderKey(j)
      if (key !== undefined) {
        if (blocked.has(key)) continue
        blocked.add(key)
      }
      if (this.#pushable(j)) out.push(j)
    }
    return out
  }

  #entryKey(j: JournalEntry): string { return `${j.server}/${j.event.id}` }

  #kick(): void {
    if (this.#closed || this.#busy > 0) return
    if (this.#pumpTimer !== undefined) clearTimeout(this.#pumpTimer)
    this.#pumpTimer = undefined
    const nowMs = this.#clockMs()
    let next = Infinity
    for (const j of this.#heads()) {
      if (this.#inflight.has(this.#entryKey(j))) continue
      if (j.nextAt <= nowMs) void this.#push(j)
      else next = Math.min(next, j.nextAt)
    }
    if (next !== Infinity) {
      this.#pumpTimer = setTimeout(() => { this.#pumpTimer = undefined; this.#kick() }, Math.max(10, next - nowMs))
      ;(this.#pumpTimer as unknown as { unref?: () => void }).unref?.()
    }
  }

  /** Push the matching entries now and wait up to the push budget; the rest carry on from the journal. */
  async #pushNow(match: (j: JournalEntry) => boolean): Promise<void> {
    const budget = this.#config.pushBudgetMs ?? 5_000
    const work = this.#heads().filter(match).map((j) => this.#push(j, true))
    // An entry behind another (a device's earlier event, say) is not forced past it: it goes when its turn comes.
    if (!work.length) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([Promise.allSettled(work), new Promise<void>((resolve) => { timer = setTimeout(resolve, budget); (timer as unknown as { unref?: () => void }).unref?.() })])
    if (timer !== undefined) clearTimeout(timer)
  }

  #push(entry: JournalEntry, force = false): Promise<void> {
    const key = this.#entryKey(entry)
    const running = this.#inflight.get(key)
    if (running) return running
    if (!force && entry.nextAt > this.#clockMs()) return Promise.resolve()
    const work = (async () => {
      let outcome: PushOutcome
      try { outcome = await this.#post(entry) } catch { outcome = { kind: 'retry' } }
      // Out of the in-flight set and onto the queue in one step, so no pump can push it twice in between.
      this.#inflight.delete(key)
      try { await this.#run(() => this.#apply(entry, outcome)) } catch (error) {
        this.#log(`group grants: could not record a push result: ${error instanceof Error ? error.message : 'failed'}`)
      }
    })()
    this.#inflight.set(key, work)
    return work.catch(() => {}).finally(() => { if (this.#inflight.get(key) === work) this.#inflight.delete(key) })
  }

  async #apply(entry: JournalEntry, outcome: PushOutcome): Promise<void> {
    const held = this.#ledger.journal.find((j) => j === entry || (j.server === entry.server && j.event.id === entry.event.id))
    if (!held) return // superseded while in flight
    const now = this.#host.now()
    const record = held.grantId ? this.#ledger.grants.find((g) => g.id === held.grantId && g.server === held.server) : undefined
    if (outcome.kind === 'done') {
      this.#ledger.journal = this.#ledger.journal.filter((j) => j !== held)
      if (held.kind === 'grant' && record) {
        record.recorded = true
        delete record.needsRenewal
        if (this.#ledger.cooldown) delete this.#ledger.cooldown[`${held.server}|${held.device}`]
      }
    } else if (outcome.kind === 'retry') {
      if (this.#expirationOf(held.event) <= now) {
        this.#log(`group grants: dropped an event for ${held.server} that ran out before the node could take it`)
        this.#ledger.journal = this.#ledger.journal.filter((j) => j !== held)
      } else {
        held.tries++
        const base = this.#config.backoff?.baseMs ?? 30_000
        const max = this.#config.backoff?.maxMs ?? 3_600_000
        const backoff = Math.min(max, base * 2 ** Math.min(held.tries - 1, 12)) * (0.5 + Math.random() * 0.5)
        // Jitter spreads the backoff; it never shortens what the node asked for.
        held.nextAt = this.#clockMs() + Math.round(Math.max(backoff, Math.min(outcome.after ?? 0, MAX_RETRY_AFTER_MS)))
      }
    } else {
      held.stopped = outcome.reason
      held.stoppedAt = this.#clockMs()
      // A grant the node refused is not one it holds: the device is not granted. A refused first grant is revoked (so it
      // can never land later, even if the device posts it) and signed afresh after a cooldown; a refused renewal is signed again.
      if (held.kind === 'grant' && record) {
        if (record.recorded === false) this.#revoke(record, now)
        else record.needsRenewal = true
        this.#coolDown(held.server, record.device, now)
      }
      if (!held.reported) {
        held.reported = true
        this.#log(`group grants: ${held.server} refused ${held.kind === 'reset' ? 'a reset' : held.kind === 'revoked' ? 'a revocation' : 'a grant'} (${outcome.reason}); not retrying`)
        this.#announced.set(`${held.server}/${outcome.reason}`, now)
        void this.#send({ op: 'error', host: this.#host.keeperParticipant, message: this.#stoppedMessage(held.server, held.kind, outcome.reason) })
      }
    }
    this.#touch()
    await this.#saveSafe()
  }

  async #post(entry: JournalEntry): Promise<PushOutcome> {
    const base = this.#ledger.bases[entry.server]
    if (!base) return { kind: 'stop', reason: 'no address for the node' }
    const timeout = this.#config.pushTimeoutMs ?? 10_000
    try {
      const response = await this.#fetch(`${base}/groups/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entry.event),
        redirect: 'error',
        signal: AbortSignal.timeout(timeout),
      })
      const status = response.status
      const reason = (response.headers.get('x-reason') ?? '').slice(0, 40).replace(/[^a-z0-9 -]/gi, '')
      const retryAfter = Number(response.headers.get('retry-after'))
      try { await response.body?.cancel() } catch { /* nothing to read */ }
      if (status === 200 || status === 201) return { kind: 'done' }
      if (status === 409) {
        // 7.2 says stop on 409, and a node answers it both when it already knows this or a newer event (fine) and when it
        // refused the grant for good (key-conflict, scope-taken, floor, scope-changed): the second is reported.
        return !reason || BENIGN_409.has(reason) ? { kind: 'done' } : { kind: 'stop', reason: `409 ${reason}` }
      }
      if (status === 403 && reason === 'future') {
        // The node's clock is behind ours by more than 30 seconds: a condition that mends itself, so keep trying until the event's own end.
        return { kind: 'retry' }
      }
      if (status === 403 && reason === 'expired') return { kind: 'done' } // nothing left to deliver: it has ended anyway
      // Keeper policy beyond 7.2, which retries only 429 and 503: a gateway in front of a node answers 502 or 504 while it restarts.
      if (status === 429 || status === 503 || status === 502 || status === 504) {
        return { kind: 'retry', after: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined }
      }
      return { kind: 'stop', reason: `${status}${reason ? ' ' + reason : ''}` }
    } catch {
      return { kind: 'retry' }
    }
  }
}
