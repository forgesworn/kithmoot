import { NostrRelayPool, normaliseRelayConfig, MAX_POOL_RELAYS, type RelayConfig, type RelayHealth, type RelayAuthentication } from '../../src/relay-pool.js'
import { KINDS } from '../../src/kinds.js'
import { MAX_RELAY_HINTS } from '../../src/network-hints.js'
import { isInvitationRelays } from '../../src/persistent-invitation.js'
import { withRoomRelays } from '../../src/room-relays.js'

import type { ParticipantIdentity } from '../../src/identity.js'

const STORAGE_KEY = 'kithmoot.relays.v1'
/** The relays this person has marked as boxes of their own circle, by hand:
 *  a box's drop tier fronted as `wss://`, named to them by its keeper rather
 *  than read off a card. Saved on the device; the contact book's boxes join
 *  it without being saved. */
const CIRCLE_KEY = 'kithmoot.circle.v1'
/** Each room's own relays, by room id: the ones it was made on (`c`, at most
 *  eight) and whether they came from its signed group invitation (or this
 *  device made the room) rather than a link's unsigned hints. */
const ROOM_RELAYS_KEY = 'kithmoot.room-relays-fixed.v1'
const LEGACY_PUBLIC_RELAYS = new Set(['wss://nos.lol/', 'wss://relay.primal.net/'])
const PUBLIC_FALLBACK_RELAY = 'wss://nostr.mom/'
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>
type RelayHints = (string | RelayConfig)[]

/** Rooms made before the third public fallback joined the defaults carry only this exact
 * pair in their invitation. Give those rooms the current third route at use
 * time without changing arbitrary, private or permissioned relay choices. */
export function currentRoomRelayHints(hints: RelayHints): RelayHints {
  let relays: RelayConfig[]
  try { relays = normaliseRelayConfig(hints) } catch { return hints }
  if (relays.length !== LEGACY_PUBLIC_RELAYS.size || !relays.every(relay => relay.read && relay.write && LEGACY_PUBLIC_RELAYS.has(relay.url))) return hints
  return [...relays, { url: PUBLIC_FALLBACK_RELAY, read: true, write: true }]
}

/** A room's own relays, as this device holds them. */
export interface FixedRoomRelays { c: string[]; signed: boolean }

/**
 * Device preferences, separate from relay hints shared in an invitation.
 *
 * A room's pool has two layers. The room's own relays come first, forced to
 * read and write and never cut: the ones it was made on, and any its
 * authority's `relays` op added since. Every member's pool includes them,
 * whatever else that member uses, so two members of one room always share
 * at least one relay. This device's own relays for the room follow (saved
 * for it, else the link's hints, else the snapshot taken when it was made,
 * else the defaults), filled up to `MAX_POOL_RELAYS`; they are what the cap
 * cuts. The room's relays are kept apart and are never written into a saved
 * list: see `setRoomRelays`.
 */
export class RelayConnections {
  #saved: Record<string, RelayConfig[]> = {}
  #fixed: Record<string, FixedRoomRelays> = {}
  /** The relays each room's authority added, by room id: held for this
   *  session; the signed op itself is kept, and replayed, by the caller. */
  #added = new Map<string, string[]>()
  #marks = new Set<string>()
  #authentication = new Map<string, Map<string, ParticipantIdentity | null>>()
  #authenticationHints = new Map<string, RelayHints>()
  #pools = new Map<NostrRelayPool, PoolOwner>()
  /** The live pool for each scope and set of hints, which every caller asking
   *  for the same shares (see `pool`). */
  #shared = new Map<string, NostrRelayPool>()
  readonly #probeIntervalMs: number
  readonly #visible: () => boolean
  /** `circle` says whether a relay URL is a box of the person's own circle,
   *  verified from current signed box status; such a relay is marked on every
   *  configuration handed out, which is what lets a message to it show as
   *  sheltered (`src/lane.ts`). The mark is a fact about the relay, not a
   *  preference, so it is not saved and cannot be edited into place. */
  constructor(private storage: StorageLike, private defaults: string[], private circle: (url: string) => boolean = () => false, probing: { intervalMs?: number; visible?: () => boolean } = {}) {
    this.#probeIntervalMs = probing.intervalMs ?? 30_000
    // `document` is absent outside a browser tab (a Node test, an agent
    // host); nothing there is ever hidden, so a probe is never skipped for
    // it. Injectable so a test can pretend the tab just went to the
    // background without touching a real `document`.
    this.#visible = probing.visible ?? (() => typeof document === 'undefined' || document.visibilityState === 'visible')
    try {
      const saved: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}')
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [scope, entries] of Object.entries(saved)) {
          if (!Array.isArray(entries) || !this.#validScope(scope)) continue
          try { this.#saved[scope] = normaliseRelayConfig(entries) } catch { /* Ignore invalid saved settings. */ }
        }
      }
    } catch { /* Storage may be unavailable or contain an older shape. */ }
    try {
      const fixed: unknown = JSON.parse(storage.getItem(ROOM_RELAYS_KEY) ?? '{}')
      if (fixed && typeof fixed === 'object' && !Array.isArray(fixed)) {
        for (const [roomId, entry] of Object.entries(fixed as Record<string, unknown>)) {
          const { c, signed } = (entry ?? {}) as Partial<FixedRoomRelays>
          if (/^[a-f0-9]{64}$/.test(roomId) && isInvitationRelays(c)) this.#fixed[roomId] = { c, signed: signed === true }
        }
      }
    } catch { /* A list that cannot be read is learnt again from the room. */ }
    try {
      const marks: unknown = JSON.parse(storage.getItem(CIRCLE_KEY) ?? '[]')
      if (Array.isArray(marks)) for (const url of marks) if (typeof url === 'string') this.#marks.add(url)
    } catch { /* A mark that cannot be read is not a mark. */ }
  }
  /** Whether `url` is a box of the person's circle: marked here by hand, or
   *  verified from current signed box status. */
  isCircle(url: string): boolean { return this.#marks.has(url) || this.circle(url) }
  /** Whether `url` was marked by hand on this device (a card's box is not). */
  isMarked(url: string): boolean { return this.#marks.has(url) }
  /** Mark or unmark a relay as a circle box, by hand. Saved on the device;
   *  every live pool is handed the new marks at once. */
  markCircle(url: string, on: boolean): void {
    const [relay] = normaliseRelayConfig([{ url, read: true, write: true }])
    if (!relay) return
    if (on) this.#marks.add(relay.url); else this.#marks.delete(relay.url)
    this.storage.setItem(CIRCLE_KEY, JSON.stringify([...this.#marks]))
    this.circleChanged()
  }
  /** Authentication is session-only and scoped to the selected room or
   * account-sync connection. Saved relay hints cannot grant identity access. */
  authenticate(scope: string, url: string, identity: ParticipantIdentity | null, hints: RelayHints = []): void {
    if (!this.#validScope(scope)) throw new Error('No room is selected')
    const normal = normaliseRelayConfig([url])[0]!.url
    if (!this.configuration(scope, hints).some(relay => relay.url === normal)) throw new Error('Apply this relay before authenticating')
    if (identity && (!/^[a-f0-9]{64}$/.test(identity.pubkey) || typeof identity.signEvent !== 'function')) throw new Error('Choose a signing account first')
    const grants = this.#authentication.get(scope) ?? new Map<string, ParticipantIdentity | null>()
    grants.set(normal, identity)
    this.#authentication.set(scope, grants)
    this.#authenticationHints.set(scope, hints.map(hint => typeof hint === 'string' ? hint : { ...hint }))
    this.#prune()
    for (const [pool, owner] of this.#pools) if (owner.scope === scope) pool.setAuthentication(this.#grants(scope, pool.configuration()))
  }
  authenticationIdentity(scope: string, url: string): string | undefined {
    return this.#authentication.get(scope)?.get(url)?.pubkey
  }
  clearAuthentication(): void {
    for (const grants of this.#authentication.values()) for (const url of grants.keys()) grants.set(url, null)
    this.#prune()
    for (const [pool, owner] of this.#pools) if (this.#authentication.has(owner.scope)) pool.setAuthentication(this.#grants(owner.scope, pool.configuration()))
  }
  #grants(scope: string, relays: RelayConfig[]): RelayAuthentication[] {
    return [...(this.#authentication.get(scope) ?? [])]
      .filter(([url]) => relays.some(relay => relay.url === url))
      .map(([url, identity]) => ({ url, identity }))
  }

  #validScope(scope: string): boolean { return scope === 'default' || /^(room|inherited):[a-f0-9]{64}$/.test(scope) }
  /** Every relay this device uses for `scope`: the room's own first, then
   *  this device's own for it. */
  configuration(scope: string, hints: RelayHints = []): RelayConfig[] {
    return this.#marked(this.#withRoomRelays(scope, this.#configuration(scope, hints)))
  }
  /** This device's own relays for `scope`, before the room's are put
   *  ahead of them: what the relay settings edit and save. */
  personal(scope: string, hints: RelayHints = []): RelayConfig[] {
    return this.#marked(this.#configuration(scope, hints))
  }

  /** Whether this device took a snapshot of its defaults for the room when
   *  it made it (see `inheritDefaults`). */
  inherits(scope: string): boolean {
    return /^room:[a-f0-9]{64}$/.test(scope) && !!this.#saved[scope.replace(/^room:/, 'inherited:')]
  }
  /** The room's own relays as held on this device, or undefined. */
  roomRelays(roomId: string): FixedRoomRelays | undefined {
    const fixed = this.#fixed[roomId]
    return fixed && { c: [...fixed.c], signed: fixed.signed }
  }
  /** The relays every member of the room uses: its own, then those its
   *  authority added, without repeats. */
  sharedRelays(roomId: string): string[] {
    return [...new Set([...(this.#fixed[roomId]?.c ?? []), ...(this.#added.get(roomId) ?? [])])]
  }

  /**
   * Learn a room's relays. `fixed` is the list it was made on: a signed one
   * (from its group invitation, or this device made the room) replaces what
   * was held; an unsigned one (a link's hints, on first sight) is taken only
   * when nothing was. Anything that is not a list an invitation may carry is
   * ignored. `added` is what its authority's newest `relays` op asked every
   * member to add. Every live pool for the room moves to the result at once.
   * Returns whether anything changed.
   */
  setRoomRelays(roomId: string, { fixed, signed = false, added }: { fixed?: string[]; signed?: boolean; added?: string[] }): boolean {
    if (!/^[a-f0-9]{64}$/.test(roomId)) return false
    const before = this.sharedRelays(roomId).join(' ')
    let stored = false
    const held = this.#fixed[roomId]
    if (fixed && isInvitationRelays(fixed) && (signed ? !held || !held.signed || held.c.join(' ') !== fixed.join(' ') : !held)) {
      this.#fixed = { ...this.#fixed, [roomId]: { c: [...fixed], signed } }
      stored = true
      try { this.storage.setItem(ROOM_RELAYS_KEY, JSON.stringify(this.#fixed)) } catch { /* Still used for this visit. */ }
    }
    if (added) {
      const urls = added.flatMap(url => { try { return [normaliseRelayConfig([url])[0]!.url] } catch { return [] } }).slice(0, MAX_RELAY_HINTS)
      if (urls.join(' ') !== (this.#added.get(roomId) ?? []).join(' ')) this.#added.set(roomId, urls)
    }
    const changed = this.sharedRelays(roomId).join(' ') !== before
    if (changed) {
      this.#prune()
      for (const [pool, owner] of this.#pools) {
        if (owner.scope !== `room:${roomId}`) continue
        const next = this.configuration(owner.scope, owner.hints)
        if (JSON.stringify(next) !== JSON.stringify(pool.configuration())) pool.setRelays(next)
      }
    }
    return changed || stored
  }

  /** Forget everything held for one room: its own relays, the relays its
   *  authority added, and this device's saved choice and snapshot for it.
   *  For a room that self-destructed, so nothing here names it any more. */
  forgetRoom(roomId: string): void {
    if (!/^[a-f0-9]{64}$/.test(roomId)) return
    const scopes = [`room:${roomId}`, `inherited:${roomId}`]
    if (scopes.some(scope => scope in this.#saved)) {
      const next = { ...this.#saved }
      for (const scope of scopes) delete next[scope]
      this.#saved = next
      try { this.storage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* Nothing more is held there. */ }
    }
    if (roomId in this.#fixed) {
      const { [roomId]: _gone, ...rest } = this.#fixed
      this.#fixed = rest
      try { this.storage.setItem(ROOM_RELAYS_KEY, JSON.stringify(rest)) } catch { /* Nothing more is held there. */ }
    }
    this.#added.delete(roomId)
  }

  /** The room's own relays for a `room:<id>` scope; none for any other. */
  roomRelaysFor(scope: string): string[] { return this.#roomRelayUrls(scope) }
  #roomRelayUrls(scope: string): string[] {
    const roomId = /^room:([a-f0-9]{64})$/.exec(scope)?.[1]
    return roomId ? this.sharedRelays(roomId) : []
  }
  /** The room's relays first, read and write, all of them; then `own`,
   *  without repeats, up to `MAX_POOL_RELAYS`. */
  #withRoomRelays(scope: string, own: RelayConfig[]): RelayConfig[] {
    return withRoomRelays(this.#roomRelayUrls(scope), own)
  }
  #configuration(scope: string, hints: RelayHints): RelayConfig[] {
    if (this.#saved[scope]) return normaliseRelayConfig(this.#saved[scope])
    const inherited = this.#saved[scope.replace(/^room:/, 'inherited:')]
    if (hints.length) return normaliseRelayConfig(currentRoomRelayHints(hints.slice(0, MAX_POOL_RELAYS))).map(relay => inherited?.find(saved => saved.url === relay.url) ?? relay)
    return normaliseRelayConfig(inherited ?? this.#saved.default ?? this.defaults)
  }
  #marked(relays: RelayConfig[]): RelayConfig[] {
    return relays.map(relay => {
      const { circle: _claimed, ...rest } = relay
      return this.isCircle(relay.url) ? { ...rest, circle: true } : rest
    })
  }
  /** Attribution is read at use time; changing trust must not reconnect rooms. */
  circleChanged(): void { this.#prune() }
  inheritDefaults(scope: string): void {
    if (!/^room:[a-f0-9]{64}$/.test(scope)) throw new Error('No room is selected')
    // Access modes survive reopening; inherited URLs must never override a
    // later invitation. Only an explicit per-room save pins the endpoint list.
    this.save(scope.replace(/^room:/, 'inherited:'), this.configuration('default'))
  }
  /** A pool for `scope` and `hints`. Callers asking for the same scope and
   *  hints share one pool, and so one socket to each relay: each feature
   *  used to get its own, so signing in alone held three to every default
   *  relay, and the room on screen two to each of its own (the session, and
   *  the rooms list watching it). What comes back is the caller's own hold
   *  on it: `close()` ends that caller's subscriptions, and the pool closes
   *  once nobody holds it. Everything else is the shared pool's. */
  pool(scope: string, hints: RelayHints = []): NostrRelayPool {
    this.#prune()
    const key = poolKey(scope, hints)
    let pool = this.#shared.get(key)
    if (!pool) {
      const configuration = this.configuration(scope, hints)
      pool = new NostrRelayPool(configuration, url => this.isCircle(url), { authentication: this.#grants(scope, configuration) })
      const owner: PoolOwner = { scope, hints, key, holders: 0 }
      this.#pools.set(pool, owner)
      this.#shared.set(key, pool)
      this.#scheduleProbe(pool, owner)
    }
    const shared = pool
    this.#pools.get(shared)!.holders++
    return holding(shared, () => this.#release(shared))
  }
  #release(pool: NostrRelayPool): void {
    const owner = this.#pools.get(pool)
    if (!owner || --owner.holders > 0) return
    pool.close()
    this.#prune()
  }
  /** `enablePing` is off in `NostrRelayPool` (see relay-pool.ts): this is
   *  what replaces it, on a schedule of our own rather than the library's.
   *  Each pool reschedules itself with a fresh jitter after every run, so
   *  several pools started together - every room a person has open at
   *  once - drift apart instead of probing their relays in lockstep. A
   *  probe is skipped while the tab is hidden (nothing is listening to miss
   *  an event) or while that pool has a publish in flight (no reason to
   *  race a liveness round trip against the thing the caller is waiting on). */
  #scheduleProbe(pool: NostrRelayPool, owner: { probeTimer?: ReturnType<typeof setTimeout> }): void {
    const jitter = Math.random() * this.#probeIntervalMs * 0.5
    owner.probeTimer = setTimeout(() => {
      if (pool.closed) return
      if (this.#visible() && !pool.publishing) void pool.probe().catch(() => {})
      this.#scheduleProbe(pool, owner)
    }, this.#probeIntervalMs + jitter)
    ;(owner.probeTimer as unknown as { unref?: () => void }).unref?.()
  }
  save(scope: string, entries: RelayConfig[]): void {
    if (!this.#validScope(scope)) throw new Error('No room is selected')
    // The circle mark is never saved: it is verified at use time.
    const relays = normaliseRelayConfig(entries).map(({ circle: _claimed, ...relay }) => relay)
    if (relays.length > MAX_RELAY_HINTS) throw new Error(`use at most ${MAX_RELAY_HINTS} relays`)
    if (!relays.some(relay => relay.read) || !relays.some(relay => relay.write)) throw new Error('Keep at least one readable relay and one writable relay so the room can receive and send messages.')
    const next = { ...this.#saved, [scope]: relays }
    // Do not claim persistence or change connections if saving failed.
    this.storage.setItem(STORAGE_KEY, JSON.stringify(next))
    this.#saved = next
    for (const [permissionScope, grants] of this.#authentication) {
      const available = this.configuration(permissionScope, this.#authenticationHints.get(permissionScope) ?? [])
      for (const url of grants.keys()) if (!available.some(relay => relay.url === url)) grants.delete(url)
    }
    this.#prune()
    for (const [pool, owner] of this.#pools) {
      if (owner.scope === scope || (scope === 'default' && !owner.hints.length && !this.#saved[owner.scope])) pool.setRelays(this.configuration(owner.scope, owner.hints))
    }
  }
  reconnect(scope: string): void {
    this.#prune()
    for (const [pool, owner] of this.#pools) if (owner.scope === scope) pool.reconnect()
  }
  /** A cheap liveness check on every pool this device currently holds open,
   *  reconnecting any relay whose socket has gone quiet without saying so -
   *  a phone backgrounded mid-handshake, or one that lost the network
   *  underneath a WebKit tab the OS never told the page about. Called on
   *  the app's own "we might be back" signals: tab foregrounded, `pageshow`
   *  from the back-forward cache, and the network coming back. */
  async probeAll(timeoutMs?: number): Promise<void> {
    this.#prune()
    await Promise.all([...this.#pools.keys()].map(pool => pool.probe(timeoutMs).catch(() => {})))
  }
  health(scope: string, hints: RelayHints = []): RelayHealth[] {
    this.#prune()
    return this.configuration(scope, hints).map(relay => {
      const matches = [...this.#pools].filter(([, owner]) => owner.scope === scope).flatMap(([pool]) => pool.health()).filter(health => health.url === relay.url)
      const connected = matches.some(health => health.state === 'connected')
      const lastWrite = matches.filter(health => health.lastPublishedAt).sort((a, b) => b.lastPublishedAt! - a.lastPublishedAt!)[0]
      const failed = matches.find(health => health.lastError)
      const unreturned = [...new Set(matches.flatMap(health => health.unreturned ?? []))]
      return { ...lastWrite, ...relay, lastError: failed?.lastError, unreturned: unreturned.length ? unreturned : undefined,
        authentication: matches.find(health => health.authentication === 'authenticated')?.authentication ?? matches.find(health => health.authentication)?.authentication,
        state: connected ? 'connected' : matches.some(health => health.state === 'connecting') ? 'connecting'
          : matches.some(health => health.state === 'disconnected') ? 'disconnected' : 'idle' }
    })
  }
  #prune(): void {
    for (const [pool, owner] of this.#pools) {
      if (!pool.closed) continue
      clearTimeout(owner.probeTimer); this.#pools.delete(pool)
      if (this.#shared.get(owner.key) === pool) this.#shared.delete(owner.key)
    }
  }
}

interface PoolOwner { scope: string; hints: RelayHints; key: string; holders: number; probeTimer?: ReturnType<typeof setTimeout> }

/** Same scope and the same hints, once normalised, is the only safe sharing:
 *  a room's relays move per owner, worked out again from its hints. */
function poolKey(scope: string, hints: RelayHints): string {
  let normal: unknown
  try { normal = normaliseRelayConfig(hints) } catch { normal = hints }
  return JSON.stringify([scope, normal])
}

/** One caller's hold on a shared pool. Its subscriptions are its own and end
 *  with it; once it has let go it can no longer read or write, as if the
 *  pool had closed for it. The rest goes straight to the shared pool. */
function holding(pool: NostrRelayPool, release: () => void): NostrRelayPool {
  let released = false
  const subscriptions = new Set<() => void>()
  const closed = (): never => { throw new Error('pool is closed') }
  return new Proxy(pool, {
    get(target, property) {
      switch (property) {
        case 'closed': return released || target.closed
        case 'close': return () => {
          if (released) return
          released = true
          for (const stop of [...subscriptions]) stop()
          release()
        }
        case 'subscribe': return (...args: Parameters<NostrRelayPool['subscribe']>) => {
          if (released) closed()
          const stop = target.subscribe(...args)
          const once = (): void => { if (subscriptions.delete(once)) stop() }
          subscriptions.add(once)
          return once
        }
        case 'publish': case 'publishQuietly': case 'query':
          if (released) return () => Promise.reject(new Error('pool is closed'))
          break
        case 'setRelays': case 'reconnect': case 'setAuthentication':
          if (released) return closed
          break
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export function profilePreference(storage: Pick<Storage, 'getItem'>): boolean {
  try { return storage.getItem('kithmoot.profiles.enabled') !== 'false' } catch { return true }
}

export class RelaySettingsPanel {
  #scope = 'default'
  #draft: RelayConfig[] = []
  #timer?: ReturnType<typeof setInterval>
  #returnFocus?: HTMLElement
  constructor(private document: Document, private connections: RelayConnections, private opts: {
    room: () => { scope: string; hints: RelayHints } | undefined
    applied: (scope: string, relays: RelayConfig[]) => void
    /** A circle mark changed: the lane the next message takes may have moved. */
    circleChanged?: () => void
    canAuthenticate?: () => boolean
    authenticate?: (scope: string, url: string) => Promise<boolean>
    /** The room's authority asking every member to use this scope's relays.
     *  `run` resolves to what to tell the person, or '' if they cancelled. */
    share?: { available: (scope: string) => boolean; run: (relays: string[]) => Promise<string> }
  }) {
    this.el('relaySettingsClose').addEventListener('click', () => this.dialog.close())
    this.dialog.addEventListener('close', () => { clearInterval(this.#timer); this.#returnFocus?.focus() })
    this.el('relayScope').addEventListener('change', () => { this.#scope = (this.el('relayScope') as HTMLSelectElement).value; this.#load() })
    this.el('relayAddForm').addEventListener('submit', event => {
      event.preventDefault()
      const input = this.el('relayUrl') as HTMLInputElement
      const mode = (this.el('relayMode') as HTMLSelectElement).value
      try {
        this.#draft = normaliseRelayConfig([...this.#draft, { url: input.value, read: mode !== 'write', write: mode !== 'read' }])
        input.value = ''; this.#render(); this.#message('Relay added to the list. Apply changes to connect.')
      } catch (error) { this.#message((error as Error).message) }
    })
    this.el('relaySave').addEventListener('click', () => {
      try {
        this.connections.save(this.#scope, this.#draft)
        this.opts.applied(this.#scope, this.#draft)
        this.#load(); this.#message('Saved on this device. Connections updated.')
      } catch (error) { this.#message((error as Error).message) }
    })
    this.el('relayShare').addEventListener('click', async () => {
      const scope = this.#scope
      const saved = this.connections.personal(scope, this.#hints())
      if (JSON.stringify(saved) !== JSON.stringify(this.#draft)) { this.#message('Apply changes first, then share them.'); return }
      const button = this.el('relayShare') as HTMLButtonElement
      button.disabled = true
      try {
        const done = await this.opts.share!.run(saved.map(relay => relay.url))
        if (done && scope === this.#scope) this.#message(done)
      } catch (error) { this.#message((error as Error).message) }
      button.disabled = false
    })
    this.el('relayReconnect').addEventListener('click', () => {
      this.connections.reconnect(this.#scope); this.#health(); this.#message('Retrying the saved relay connections.')
    })
  }
  private el(id: string): HTMLElement { return this.document.getElementById(id)! }
  private get dialog(): HTMLDialogElement { return this.el('relaySettings') as HTMLDialogElement }
  open(from: HTMLElement): void {
    this.#returnFocus = from
    const room = this.opts.room()
    const scope = this.el('relayScope') as HTMLSelectElement
    scope.replaceChildren()
    if (room) scope.add(new Option('This room', room.scope))
    scope.add(new Option('Defaults for new rooms and account sync', 'default'))
    this.#scope = room?.scope ?? 'default'; scope.value = this.#scope
    this.#load(); this.dialog.showModal(); scope.focus()
    clearInterval(this.#timer); this.#timer = setInterval(() => this.#health(), 1000)
  }
  #hints(): RelayHints { const room = this.opts.room(); return room?.scope === this.#scope ? room.hints : [] }
  #load(): void {
    this.#draft = this.connections.personal(this.#scope, this.#hints()); this.#render(); this.#message('')
    this.el('relayShareRow').hidden = !this.opts.share?.available(this.#scope)
  }
  #message(text: string): void { this.el('relaySettingsStatus').textContent = text }
  #render(): void {
    const list = this.el('relayList'); list.replaceChildren()
    // The room's own relays: always used, by everybody in it, so listed
    // but not editable. A relay this device also lists is shown once, below.
    for (const url of this.connections.roomRelaysFor(this.#scope)) {
      if (this.#draft.some(relay => relay.url === url)) continue
      const row = this.document.createElement('li'); row.className = 'relayRow relayRoomRow'; row.dataset.url = url
      const address = this.document.createElement('span'); address.className = 'relayAddress'; address.textContent = url
      const health = this.document.createElement('span'); health.className = 'relayHealth'; health.setAttribute('aria-live', 'polite')
      const note = this.document.createElement('span'); note.className = 'relayRoomNote'; note.textContent = 'This room\u2019s relay: everyone in it uses it'
      row.append(address, health, note)
      list.append(row)
    }
    this.#draft.forEach((relay, index) => {
      const row = this.document.createElement('li'); row.className = 'relayRow'; row.dataset.url = relay.url
      const url = this.document.createElement('span'); url.className = 'relayAddress'; url.textContent = relay.url
      const health = this.document.createElement('span'); health.className = 'relayHealth'; health.setAttribute('aria-live', 'polite')
      const mode = this.document.createElement('select'); mode.setAttribute('aria-label', `Access for ${relay.url}`)
      for (const [value, label] of [['both', 'Read / write'], ['read', 'Read only'], ['write', 'Write only']]) mode.add(new Option(label, value))
      mode.value = relay.read && relay.write ? 'both' : relay.read ? 'read' : 'write'
      mode.addEventListener('change', () => { this.#draft[index] = { ...relay, read: mode.value !== 'write', write: mode.value !== 'read' }; this.#message('Access changed. Apply changes to use it.') })
      const remove = this.document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove ${relay.url}`)
      remove.addEventListener('click', () => { this.#draft.splice(index, 1); this.#render(); this.#message('Relay removed from the list. Apply changes to disconnect.') })
      // A relay marked as a box of the person's circle: a message that goes
      // only to such relays shows as sheltered, and nothing else ever does.
      // A card's box is marked for them and cannot be unmarked here.
      const circle = this.document.createElement('label'); circle.className = 'relayCircle'
      const tick = this.document.createElement('input'); tick.type = 'checkbox'
      tick.checked = this.connections.isCircle(relay.url)
      tick.disabled = tick.checked && !this.connections.isMarked(relay.url)
      tick.setAttribute('aria-label', `${relay.url} is a box of my circle`)
      tick.addEventListener('change', () => {
        this.connections.markCircle(relay.url, tick.checked)
        this.opts.circleChanged?.()
        this.#message(tick.checked ? 'Marked as a box of your circle. A message to it alone shows as sheltered.' : 'No longer a box of your circle.')
      })
      circle.append(tick, this.document.createTextNode(tick.disabled ? ' Verified box endpoint' : ' Box of my circle'))
      row.append(url, health, mode, remove, circle)
      if (this.opts.authenticate) {
        const auth = this.document.createElement('button'); auth.type = 'button'; auth.className = 'quiet relayAuthenticate'
        const permitted = this.connections.authenticationIdentity(this.#scope, relay.url)
        auth.textContent = permitted ? 'Stop identifying' : 'Use signed-in account'
        auth.setAttribute('aria-label', `${auth.textContent} with ${relay.url}`)
        const applied = this.connections.configuration(this.#scope, this.#hints()).some(saved => saved.url === relay.url)
        auth.disabled = !applied || (!permitted && !this.opts.canAuthenticate?.())
        auth.title = !applied ? 'Apply this relay first' : !permitted && !this.opts.canAuthenticate?.() ? 'Sign in to choose an authentication identity' : ''
        auth.addEventListener('click', async () => {
          const scope = this.#scope
          auth.disabled = true
          try {
            if (permitted) {
              this.connections.authenticate(scope, relay.url, null, this.#hints())
              this.#message('Identity permission withdrawn. This relay stays disconnected here until you approve it again or remove it.')
            } else if (await this.opts.authenticate!(scope, relay.url)) {
              this.#message('Identity permitted here for this tab. Your signer may ask you to approve authentication.')
            }
          } catch (error) { this.#message((error as Error).message) }
          if (scope === this.#scope) this.#render()
        })
        row.append(auth)
      }
      list.append(row)
    })
    this.#health()
  }
  #health(): void {
    const health = this.connections.health(this.#scope, this.#hints())
    for (const row of this.el('relayList').querySelectorAll<HTMLElement>('.relayRow')) {
      const found = health.find(entry => entry.url === row.dataset.url)
      const text = row.querySelector<HTMLElement>('.relayHealth')!
      const labels = { connected: 'Connected', connecting: 'Connecting…', disconnected: 'Disconnected', closed: 'Closed', idle: 'Not connected yet' }
      text.textContent = found ? labels[found.state] : 'Not applied yet'
      text.dataset.state = found?.state ?? 'idle'
      if (found?.authentication === 'authenticated') text.textContent += ' · Account authenticated'
      else if (found?.authentication === 'allowed' && found.state === 'connecting') text.textContent = 'Authenticating…'
      if (found?.lastPublishedAt) text.textContent += ` · Last accepted write ${new Date(found.lastPublishedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} (${found.publishLatencyMs} ms)`
      if (found?.lastError) text.textContent += ` · ${found.lastError}`
      // Seen, not inferred: it said OK to one and had nothing when asked.
      if (found?.unreturned?.length) text.textContent += found.unreturned.includes(KINDS.CHAT) ? ' · Does not keep chat: accepted a message, then did not return it' : ' · Accepted an event, then did not return it'
    }
  }
}
