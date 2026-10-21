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
 * Concurrency: every change to the ledger, and every control message, goes
 * through one queue (`#queue`). HTTP pushes do not: the journal worker pushes
 * from its own timer, so a slow node never delays a removal. The only pushes a
 * caller waits for are the bounded bursts of a removal and a close.
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
  /** After an unreadable ledger (or none), sign a reset at every node first. */
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
}

const emptyLedger = (): GroupGrantLedger => ({ v: 1, bases: {}, floors: {}, grants: [], journal: [], removing: [], refused: [], resets: [] })

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
  #closed = false
  #resetting = false
  #sweepTimer?: ReturnType<typeof setInterval>
  #rosterTimer?: ReturnType<typeof setTimeout>
  #pumpTimer?: ReturnType<typeof setTimeout>
  readonly #inflight = new Set<string>()
  readonly #answered = new Map<string, number>()
  readonly #announced = new Map<string, number>()

  private constructor(config: GroupGrantsConfig, host: GroupGrantHost, nodes: GroupNode[], bytes: string, ledger: GroupGrantLedger) {
    this.#config = config
    this.#host = host
    this.#nodes = nodes
    this.#bytes = bytes
    this.#ledger = ledger
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

  /** Load the ledger and get ready. Throws, naming `--group-reset`, when the ledger cannot be read. */
  static async open(config: GroupGrantsConfig, host: GroupGrantHost): Promise<GroupGrantKeeper> {
    const { nodes, bytes } = GroupGrantKeeper.validate(config)
    const log = config.log ?? (() => {})
    let ledger = emptyLedger()
    let resetting = false
    const text = await config.store.load()
    if (text !== undefined) {
      try {
        ledger = parseLedger(text)
        if (config.resetUnreadable) log('group grants: the ledger is readable, so --group-reset is not needed and is ignored')
      } catch (error) {
        if (!config.resetUnreadable) {
          throw new Error(`the group grant ledger cannot be read (${error instanceof Error ? error.message : 'damaged'}). ` +
            'Its file is left as it is. To start anyway, sign a reset at every group node and issue fresh grants, run with --group-reset: ' +
            'the unreadable file is moved aside, never deleted.')
        }
        const moved = await config.store.moveAside(host.now())
        log(`group grants: the ledger was unreadable; moved aside${moved ? ' as ' + moved : ''}`)
        ledger = emptyLedger()
        resetting = true
      }
    } else if (config.resetUnreadable) resetting = true
    const keeper = new GroupGrantKeeper(config, host, nodes, bytes, ledger)
    keeper.#resetting = resetting
    for (const n of nodes) keeper.#ledger.bases[n.server] = n.base
    return keeper
  }

  /** Complete any removal begun before a stop, reset first if asked, mint, and start the timers. */
  async start(): Promise<void> {
    await this.#run(async () => {
      if (this.#resetting) {
        const now = this.#host.now()
        for (const n of this.#nodes) this.#signReset(n.server, now)
        this.#resetting = false
        this.#log(`group grants: signed a reset at ${this.#nodes.length} node${this.#nodes.length === 1 ? '' : 's'} before issuing new grants`)
        await this.#save()
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
  // The queue
  // -------------------------------------------------------------------------

  #run<T>(task: () => Promise<T>): Promise<T> {
    this.#busy++
    const run = this.#queue.then(task, task)
    this.#queue = run.then(() => undefined, () => undefined).finally(() => { this.#busy--; if (this.#busy === 0) this.#kick() })
    return run
  }

  async #save(): Promise<void> {
    this.#prune(this.#host.now())
    await this.#config.store.save(JSON.stringify(this.#ledger))
  }

  #prune(now: number): void {
    const l = this.#ledger
    l.grants = l.grants.filter((g) => g.status === 'active' || g.expiration + KEEP_ENDED_SECONDS > now)
    l.resets = l.resets.filter((r) => this.#expirationOf(r.event) > now)
    const nowMs = this.#clockMs()
    l.journal = l.journal.filter((j) => {
      if (j.stopped) return (j.stoppedAt ?? 0) + KEEP_STOPPED_SECONDS * 1000 > nowMs
      if (!this.#nodes.some((n) => n.server === j.server) && j.since + UNCONFIGURED_NODE_SECONDS * 1000 < nowMs) {
        this.#log(`group grants: gave up on an event for ${j.server}, a node that is no longer configured`)
        return false
      }
      return true
    })
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
    this.#ledger.journal.push({ ...entry, tries: 0, nextAt: 0, since: this.#clockMs() })
  }

  #mint(device: string, participant: string, server: string, now: number): GrantRecord {
    const id = newGrantId(this.#random)
    const createdAt = nextCreatedAt(now, this.#floor(server))
    const expiration = createdAt + GRANT_LIFETIME_SECONDS
    const scopes = [...KEEPER_SCOPES]
    const event = buildGrant({
      authoritySk: this.#host.authoritySk, roomId: this.#host.roomId, device, server, scopes, bytes: this.#bytes, grantId: id, createdAt, expiration,
    })
    const record: GrantRecord = { id, device, participant, server, createdAt, expiration, status: 'active', scopes, bytes: this.#bytes, event, posted: false }
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
    this.#addJournal({ server: record.server, kind: 'grant', grantId: record.id, device: record.device, event })
  }

  /** Sign the revocation of a live grant. A grant already past its end cannot be revoked and needs no revoking. */
  #revoke(record: GrantRecord, now: number): GroupEvent | undefined {
    if (record.status !== 'active') return undefined
    const createdAt = nextCreatedAt(now, record.createdAt, this.#floor(record.server))
    if (createdAt >= record.expiration) { record.status = 'ended'; return undefined }
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

  // -------------------------------------------------------------------------
  // Mint and renew
  // -------------------------------------------------------------------------

  /** A roster change: look again shortly, coalescing a burst into one sweep. */
  noteRoster(): void {
    if (this.#closed || this.#rosterTimer !== undefined) return
    this.#rosterTimer = setTimeout(() => {
      this.#rosterTimer = undefined
      void this.sweep().catch(() => {})
    }, this.#config.rosterDelayMs ?? 200)
    ;(this.#rosterTimer as unknown as { unref?: () => void }).unref?.()
  }

  /**
   * Mint for every admitted device that has no grant at a configured node,
   * renew those with 10 days or less left, revoke what belongs to a removed
   * participant, and send in the room whatever has not been sent.
   */
  sweep(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    return this.#run(async () => {
      if (this.#closed) return
      const now = this.#host.now()
      // Somebody being removed counts as removed from the moment the ledger records it, before their rekey exists.
      const removed = new Set([...this.#host.removed(), ...this.#ledger.removing])
      const heard = this.#host.devices()
      const heardBy = new Map(heard.map((d) => [d.device, d.participant]))
      let changed = false

      for (const g of this.#ledger.grants) if (g.status === 'active' && g.expiration <= now) { g.status = 'ended'; changed = true }
      // A safety net: a participant removed by any route has nothing live.
      for (const g of this.#ledger.grants) if (live(g, now) && removed.has(g.participant)) { this.#revoke(g, now); changed = true }

      for (const { device, participant } of heard) {
        if (removed.has(participant)) continue
        // A device that now speaks for somebody else: the old grant goes, a new one is issued (rule 11 wants the old revoked first).
        for (const g of this.#ledger.grants) if (g.device === device && live(g, now) && g.participant !== participant) { this.#revoke(g, now); changed = true }
        const mine = this.#ledger.grants.filter((g) => g.device === device && live(g, now))
        const needs = this.#nodes.filter((n) => !mine.some((g) => g.server === n.server))
        if (needs.length) {
          if (!mine.length && this.#liveDevices(participant, now).size >= MAX_DEVICES_PER_PARTICIPANT) {
            if (!this.#ledger.refused.some((r) => r.device === device)) {
              this.#ledger.refused.push({ participant, device, since: now })
              changed = true
              this.#log(`group grants: ${short(participant)} already has ${MAX_DEVICES_PER_PARTICIPANT} devices with grants; device ${short(device)} was not given one`)
            }
          } else if (this.#ledger.grants.length < MAX_GRANTS) {
            for (const n of needs) this.#mint(device, participant, n.server, now)
            this.#ledger.refused = this.#ledger.refused.filter((r) => r.device !== device)
            changed = true
          }
        }
        for (const g of mine) {
          if (g.participant === participant && this.#nodes.some((n) => n.server === g.server) && g.expiration - now <= GRANT_RENEW_WITHIN_SECONDS) {
            this.#renew(g, now)
            changed = true
          }
        }
      }
      // A refused device that has gone, or whose person was removed, is not a problem any more.
      const before = this.#ledger.refused.length
      this.#ledger.refused = this.#ledger.refused.filter((r) => heardBy.get(r.device) === r.participant && !removed.has(r.participant))
      if (this.#ledger.refused.length !== before) changed = true

      if (changed) await this.#save()
      await this.#postUnsent()
      this.#reportRefused()
    })
  }

  #liveDevices(participant: string, now: number): Set<string> {
    return new Set(this.#ledger.grants.filter((g) => g.participant === participant && live(g, now)).map((g) => g.device))
  }

  async #send(op: ControlMessage): Promise<boolean> {
    try {
      await Promise.race([
        this.#host.send(op),
        new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error('timed out')), SEND_TIMEOUT_MS); (t as unknown as { unref?: () => void }).unref?.() }),
      ])
      return true
    } catch { return false }
  }

  /** In the room, whatever has not been: grants, renewals, revocations, resets. One event per op. */
  async #postUnsent(): Promise<void> {
    let changed = false
    for (const g of this.#ledger.grants) {
      if (g.posted) continue
      if (g.status === 'ended') { g.posted = true; changed = true; continue }
      // A revocation is held back until its rekey has been published; see `afterRemoval`.
      if (g.status === 'revoked' && this.#ledger.removing.includes(g.participant)) continue
      if (await this.#send({ op: 'storage-grant', event: g.event })) { g.posted = true; changed = true }
    }
    for (const r of this.#ledger.resets) {
      if (r.posted) continue
      if (await this.#send({ op: 'storage-grant', event: r.event })) { r.posted = true; changed = true }
    }
    if (changed) await this.#save()
  }

  // -------------------------------------------------------------------------
  // storage-grant? and what the hosts are told
  // -------------------------------------------------------------------------

  /** A device asked for its grants (the asker is the message's credential-bound device). */
  answer(device: string, participant: string): Promise<void> {
    if (this.#closed) return Promise.resolve()
    const now = this.#host.now()
    const last = this.#answered.get(device)
    if (last !== undefined && now - last < ANSWER_INTERVAL_SECONDS) return Promise.resolve()
    if (this.#host.removed().has(participant)) return Promise.resolve()
    this.#answered.set(device, now)
    if (this.#answered.size > 4_096) this.#answered.delete(this.#answered.keys().next().value!)
    return this.sweep().then(() => this.#run(async () => {
      const at = this.#host.now()
      for (const g of this.#ledger.grants) {
        if (g.device !== device || g.participant !== participant || !live(g, at)) continue
        await this.#send({ op: 'storage-grant', event: g.event })
      }
    }))
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
    return `Group storage ${server} refused a ${kind === 'reset' ? 'reset' : 'grant'} (${reason}). Ask whoever runs it to check it names this room's keeper.`.slice(0, REPORT_MAX)
  }

  #refusedMessage(): string {
    return `${this.#ledger.refused.length} device${this.#ledger.refused.length === 1 ? ' was' : 's were'} not given group storage: ${MAX_DEVICES_PER_PARTICIPANT} per person is the most.`.slice(0, REPORT_MAX)
  }

  #reportRefused(): void {
    const fresh = this.#ledger.refused.filter((r) => !r.reported)
    if (!fresh.length) return
    for (const r of fresh) r.reported = true
    this.#announced.set('refused', this.#host.now())
    void this.#send({ op: 'error', host: this.#host.keeperParticipant, message: this.#refusedMessage() })
    void this.#save().catch(() => {})
  }

  // -------------------------------------------------------------------------
  // Removal (4.8) and close
  // -------------------------------------------------------------------------

  /**
   * Before the rekey of a removal: record it, sign `revoked` for every grant id
   * issued to any device of the participant at every node, and push them,
   * waiting no longer than the push budget. Throws if the record cannot be saved,
   * so a removal is never made that the ledger does not know of.
   */
  async beforeRemoval(participant: string): Promise<void> {
    const keys = await this.#run(async () => {
      const now = this.#host.now()
      if (!this.#ledger.removing.includes(participant)) this.#ledger.removing.push(participant)
      const signed: string[] = []
      for (const g of this.#ledger.grants) {
        if (g.participant !== participant) continue
        if (this.#revoke(g, now)) signed.push(`${g.server}/${g.event.id}`)
      }
      this.#ledger.refused = this.#ledger.refused.filter((r) => r.participant !== participant)
      await this.#save()
      return signed
    })
    await this.#pushNow((j) => j.kind === 'revoked' && keys.includes(`${j.server}/${j.event.id}`))
  }

  /** After the rekey: send the revocations in the room (now in the new epoch) and close the record. */
  async afterRemoval(participant: string): Promise<void> {
    await this.#run(async () => {
      this.#ledger.removing = this.#ledger.removing.filter((p) => p !== participant)
      await this.#save()
      await this.#postUnsent()
    })
  }

  /** Before the closing rekey: a reset at every node, in the room, and pushed within the push budget. */
  async beforeClose(): Promise<void> {
    await this.#run(async () => {
      const now = this.#host.now()
      const servers = new Set([...this.#nodes.map((n) => n.server), ...Object.keys(this.#ledger.bases)])
      for (const s of servers) this.#signReset(s, now)
      await this.#save()
      await this.#postUnsent()
    })
    await this.#pushNow((j) => j.kind === 'reset')
    this.#closed = true
  }

  // -------------------------------------------------------------------------
  // The push journal (7.2)
  // -------------------------------------------------------------------------

  #orderKey(j: JournalEntry): string | undefined {
    return j.kind === 'reset' ? undefined : `${j.server}|${j.device}`
  }

  /** Entries ready now: not stopped, not in flight, due, and first in line for their device and node. */
  #due(): JournalEntry[] {
    const nowMs = this.#clockMs()
    const blocked = new Set<string>()
    const out: JournalEntry[] = []
    for (const j of this.#ledger.journal) {
      if (j.stopped) continue
      const key = this.#orderKey(j)
      if (key !== undefined) {
        if (blocked.has(key)) continue
        blocked.add(key)
      }
      if (!this.#inflight.has(this.#entryKey(j)) && j.nextAt <= nowMs) out.push(j)
    }
    return out
  }

  #entryKey(j: JournalEntry): string { return `${j.server}/${j.event.id}` }

  #kick(): void {
    if (this.#closed || this.#busy > 0) return
    if (this.#pumpTimer !== undefined) clearTimeout(this.#pumpTimer)
    this.#pumpTimer = undefined
    const due = this.#due()
    for (const j of due) void this.#push(j)
    // Wake for the earliest entry still waiting.
    const nowMs = this.#clockMs()
    let next = Infinity
    const seen = new Set<string>()
    for (const j of this.#ledger.journal) {
      if (j.stopped) continue
      const key = this.#orderKey(j)
      if (key !== undefined) { if (seen.has(key)) continue; seen.add(key) }
      if (!this.#inflight.has(this.#entryKey(j)) && j.nextAt > nowMs) next = Math.min(next, j.nextAt)
    }
    if (next !== Infinity) {
      this.#pumpTimer = setTimeout(() => { this.#pumpTimer = undefined; this.#kick() }, Math.max(10, next - nowMs))
      ;(this.#pumpTimer as unknown as { unref?: () => void }).unref?.()
    }
  }

  /** Push the matching entries now and wait up to the push budget; the rest carry on from the journal. */
  async #pushNow(match: (j: JournalEntry) => boolean): Promise<void> {
    const budget = this.#config.pushBudgetMs ?? 5_000
    const work = this.#ledger.journal.filter((j) => !j.stopped && match(j)).map((j) => this.#push(j, true))
    if (!work.length) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([Promise.allSettled(work), new Promise<void>((resolve) => { timer = setTimeout(resolve, budget); (timer as unknown as { unref?: () => void }).unref?.() })])
    if (timer !== undefined) clearTimeout(timer)
  }

  async #push(entry: JournalEntry, force = false): Promise<void> {
    const key = this.#entryKey(entry)
    if (this.#inflight.has(key)) return
    // Even a forced push keeps the order for one device at one node: earlier events first.
    if (force && !this.#firstInLine(entry)) return
    this.#inflight.add(key)
    let outcome: PushOutcome
    try { outcome = await this.#post(entry) } finally { this.#inflight.delete(key) }
    await this.#run(async () => {
      const held = this.#ledger.journal.find((j) => j === entry || (j.server === entry.server && j.event.id === entry.event.id))
      if (!held) return // superseded while in flight
      if (outcome.kind === 'done') {
        this.#ledger.journal = this.#ledger.journal.filter((j) => j !== held)
      } else if (outcome.kind === 'retry') {
        held.tries++
        const base = this.#config.backoff?.baseMs ?? 30_000
        const max = this.#config.backoff?.maxMs ?? 3_600_000
        const wait = Math.min(max, Math.max(outcome.after ?? 0, base * 2 ** Math.min(held.tries - 1, 12)))
        held.nextAt = this.#clockMs() + Math.round(wait * (0.5 + Math.random() * 0.5))
      } else {
        held.stopped = outcome.reason
        held.stoppedAt = this.#clockMs()
        if (!held.reported) {
          held.reported = true
          this.#log(`group grants: ${held.server} refused a ${held.kind} (${outcome.reason}); not retrying`)
          this.#announced.set(`${held.server}/${outcome.reason}`, this.#host.now())
          void this.#send({ op: 'error', host: this.#host.keeperParticipant, message: this.#stoppedMessage(held.server, held.kind, outcome.reason) })
        }
      }
      await this.#save().catch((error) => this.#log(`group grants: could not save the ledger: ${error instanceof Error ? error.message : 'failed'}`))
    })
  }

  #firstInLine(entry: JournalEntry): boolean {
    const key = this.#orderKey(entry)
    if (key === undefined) return true
    return this.#ledger.journal.find((j) => !j.stopped && this.#orderKey(j) === key) === entry
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
