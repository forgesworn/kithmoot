import type { Event } from 'nostr-tools/pure'
import type { Filter } from 'nostr-tools/filter'
import { normalizeURL } from 'nostr-tools/utils'
import { readBoxClaim, readBoxStatus, type BoxPin, type VerifiedBoxStatus } from '../../src/box-status.js'
import { verifyEventUncached } from '../../src/verify.js'
import type { RelayTransport } from '../../src/relay-pool.js'
import { contactFor, contacts, type Contact, type ContactBox, type CircleRelay } from './contact-store.js'
import type { DeviceStore } from './device-store.js'

const PREFIX = 'kithmoot.box-discovery.v1.'
const LIMIT = 32
type Saved = { revision: string; nodeId: string; enabled: boolean; card?: string; serial?: number; claim?: Event; status?: Event; statusConflictAt?: number; claimConflictAt?: number }
type Watch = {
  key: string; contact: string; box: string; revision: string; pool: RelayTransport
  stops: (() => void)[]; seed?: Event; latest?: Event; candidate?: Event
  claimReady: boolean; statusReady: boolean; proof?: VerifiedBoxStatus; message: string
  statusConflictAt?: number; claimConflictAt?: number
}
const keyOf = (contact: string, box: string) => PREFIX + contact + '.' + box
const revision = (c: Contact, b: ContactBox) => JSON.stringify([c.issued, c.expires, c.readAt, b.claim, b.nodeId, c.rz, c.eph])
const signed = (e: Event, kind: number, author?: string): boolean => {
  try { return e.kind === kind && (!author || e.pubkey === author) && Number.isSafeInteger(e.created_at) && e.created_at >= 0 && verifyEventUncached(e) } catch { return false }
}

/** Discovery is opt-in per box. Saved state is replay protection, never an
 * offline ownership grant: each process waits for a fresh initial relay read.
 * The caller owns read-relay selection; no contact hint is ever dialled. */
export class BoxDiscovery {
  #watches = new Map<string, Watch>()
  #timer?: ReturnType<typeof setInterval>
  constructor(private opts: { store: DeviceStore; transport: (unavailable: () => void) => RelayTransport; changed: () => void; now?: () => number; ticking?: boolean }) {
    if (opts.ticking !== false) this.#timer = setInterval(() => this.tick(), 30_000)
  }
  #now(): number { return this.opts.now?.() ?? Math.floor(Date.now() / 1000) }
  #saved(key: string): Saved | undefined {
    try {
      const s = JSON.parse(this.opts.store.get(key) ?? '') as Saved
      if (typeof s.revision === 'string' && typeof s.nodeId === 'string' && typeof s.enabled === 'boolean') return s
    } catch { /* Unreadable preferences grant nothing. */ }
    return undefined
  }
  #current(w: Watch): { contact: Contact; box: ContactBox; saved: Saved } | undefined {
    if (this.#watches.get(w.key) !== w) return
    const contact = contactFor(this.opts.store, w.contact)
    const box = contact?.boxes.find(b => b.p === w.box)
    const saved = this.#saved(w.key)
    if (!contact || !box || !saved?.enabled || contact.expires <= this.#now() || revision(contact, box) !== w.revision || saved.revision !== w.revision) return
    return { contact, box, saved }
  }
  #save(w: Watch, change: Partial<Saved>): boolean {
    const current = this.#current(w)
    if (!current) return false
    this.opts.store.set(w.key, JSON.stringify({ ...current.saved, ...change }))
    return true
  }
  enabled(contact: string, box: string): boolean {
    const c = contactFor(this.opts.store, contact), b = c?.boxes.find(b => b.p === box)
    const saved = this.#saved(keyOf(contact, box))
    return !!c && !!b && saved?.enabled === true && saved.revision === revision(c, b)
  }
  setEnabled(contact: string, box: string, enabled: boolean): void {
    const c = contactFor(this.opts.store, contact), b = c?.boxes.find(b => b.p === box)
    if (!c || !b) throw new Error('This contact no longer has that box.')
    if (enabled && c.expires <= this.#now()) throw new Error('Add a current contact card before checking this box.')
    if (enabled && !this.enabled(contact, box) && this.#watches.size >= LIMIT) throw new Error(`Check at most ${LIMIT} boxes at once. Stop checking another box first.`)
    const key = keyOf(contact, box), old = this.#saved(key)
    this.opts.store.set(key, JSON.stringify({ ...(old?.nodeId === b.nodeId ? old : { claim: old?.claim, claimConflictAt: old?.claimConflictAt }), revision: revision(c, b), nodeId: b.nodeId, enabled }))
    this.reconcile()
    this.opts.changed()
  }
  message(contact: string, box: string): string {
    const w = this.#watches.get(keyOf(contact, box))
    return w?.message ?? (this.enabled(contact, box) ? 'Waiting to check this box.' : 'Box status is not being checked.')
  }
  /** Reconcile after a card is changed or forgotten. Late callbacks cannot
   * recreate it: every write checks both watcher identity and card revision. */
  reconcile(): void {
    const held = new Set<string>()
    for (const c of contacts(this.opts.store)) for (const b of c.boxes) {
      const key = keyOf(c.p, b.p); held.add(key)
      const saved = this.#saved(key)
      const w = this.#watches.get(key)
      if (w && (!saved?.enabled || saved.revision !== revision(c, b) || c.expires <= this.#now())) this.#stop(w)
      if (saved?.enabled && saved.revision === revision(c, b) && c.expires > this.#now() && !this.#watches.has(key) && this.#watches.size < LIMIT) this.#start(c, b, saved)
    }
    for (const w of [...this.#watches.values()]) if (!held.has(w.key)) this.#stop(w)
    for (const key of this.opts.store.keys()) if (key.startsWith(PREFIX) && !held.has(key)) this.opts.store.remove(key)
  }
  #start(c: Contact, b: ContactBox, saved: Saved): void {
    let pool: RelayTransport
    try { pool = this.opts.transport(() => {
      const active = this.#watches.get(keyOf(c.p, b.p))
      if (!active || active.pool !== pool) return
      active.proof = undefined; active.candidate = undefined; active.claimReady = false; active.statusReady = false
      active.message = 'Read relays unavailable. Waiting for a fresh box check.'
      this.opts.changed()
    }) } catch { return }
    const w: Watch = { key: keyOf(c.p, b.p), contact: c.p, box: b.p, revision: saved.revision, pool, stops: [], claimReady: false, statusReady: false, message: 'Checking the box and its keeper’s claim…',
      statusConflictAt: saved.statusConflictAt, claimConflictAt: saved.claimConflictAt }
    this.#watches.set(w.key, w)
    const protect = (f: () => void) => {
      if (!this.#current(w)) return
      try { f() } catch { w.proof = undefined; w.message = 'Box status could not be verified or saved.'; this.opts.changed() }
    }
    const subscribe = (filter: Filter, receive: (e: Event) => void, ready: () => void) => {
      const stop = pool.subscribe([filter], e => protect(() => receive(e)), () => protect(ready))
      if (this.#watches.get(w.key) === w) w.stops.push(stop); else stop()
    }
    try {
      subscribe({ kinds: [10640], authors: [b.p], limit: 8 }, e => {
        if (!signed(e, 10640, b.p) || e.created_at > this.#now() + 300) return
        if (w.candidate && e.created_at < w.candidate.created_at) return
        // A conflicting status at the same timestamp is not a new grant.
        if (w.candidate && e.created_at === w.candidate.created_at && e.id !== w.candidate.id) {
          w.statusConflictAt = e.created_at; this.#save(w, { statusConflictAt: e.created_at }); this.#check(w); return
        }
        // Even a malformed but genuinely box-signed newer statement prevents
        // an older grant being replayed after restart.
        const held = this.#current(w)?.saved.status
        if (held && signed(held, 10640, b.p)) {
          if (e.created_at < held.created_at) return
          if (e.created_at === held.created_at && e.id !== held.id) {
            w.statusConflictAt = e.created_at; this.#save(w, { statusConflictAt: e.created_at }); this.#check(w); return
          }
        }
        w.candidate = e
        this.#save(w, { status: e })
        this.#check(w)
      }, () => { w.statusReady = true; this.#check(w) })
      subscribe({ ids: [b.claim], kinds: [30640], limit: 1 }, e => {
        const r = readBoxClaim(e, this.#now())
        if (!r.ok || e.id !== b.claim || r.claim.node !== b.p || w.seed) return
        w.seed = e
        const previous = saved.claim && readBoxClaim(saved.claim, this.#now())
        if (previous?.ok && previous.claim.master === r.claim.master && previous.claim.node === b.p) w.latest = saved.claim
        this.#claim(w, e)
        subscribe({ kinds: [30640], authors: [r.claim.master], '#d': [b.p], limit: 16 }, update => this.#claim(w, update), () => { w.claimReady = true; this.#check(w) })
      }, () => { if (!w.seed) { w.message = 'The claim on this contact card was not found.'; this.opts.changed() } })
    } catch { w.proof = undefined; w.message = 'The configured read relays could not be checked.'; pool.close() }
  }
  #claim(w: Watch, event: Event): void {
    if (!w.seed) return
    const r = readBoxClaim(event, this.#now())
    if (!r.ok || r.claim.node !== w.box || r.claim.master !== w.seed.pubkey) return
    const previous = w.latest && readBoxClaim(w.latest, this.#now())
    // Retirement is terminal even when relay history arrives newest first.
    if (r.claim.state === 'retired') {
      w.latest = event
      if (this.#save(w, { claim: event })) this.#check(w)
      return
    }
    if (previous?.ok) {
      if (previous.claim.state === 'retired') { this.#check(w); return }
      if (event.created_at < w.latest!.created_at) return
      if (event.created_at === w.latest!.created_at && event.id !== w.latest!.id) {
        w.claimConflictAt = event.created_at; this.#save(w, { claimConflictAt: event.created_at }); this.#check(w); return
      }
    }
    w.latest = event
    if (!this.#save(w, { claim: event })) return
    this.#check(w)
  }
  #check(w: Watch): void {
    w.proof = undefined
    const current = this.#current(w)
    if (!current) return
    const latest = w.latest && readBoxClaim(w.latest, this.#now())
    if (latest?.ok && latest.claim.state === 'retired') w.message = 'This box’s keeper retired its claim.'
    else if (w.latest && w.latest.id !== current.box.claim) w.message = 'The box’s claim changed. Ask for a current contact card.'
    else if (w.claimConflictAt !== undefined && (!w.latest || w.latest.created_at <= w.claimConflictAt)) w.message = 'Conflicting keeper claims; waiting for a newer statement.'
    else if (w.statusConflictAt !== undefined && (!w.candidate || w.candidate.created_at <= w.statusConflictAt)) w.message = 'Conflicting box status; waiting for a newer statement.'
    else if (!w.claimReady || !w.statusReady) w.message = 'Checking the box and its keeper’s claim…'
    else if (!w.candidate || !w.seed) w.message = 'No current signed box status was found.'
    else {
      const saved = current.saved
      const serial = Number.isSafeInteger(saved.serial) && saved.serial! >= current.box.highestSerial ? saved.serial! : current.box.highestSerial
      const held = saved.status && signed(saved.status, 10640, w.box) ? saved.status : undefined
      const pin: BoxPin = { ...current.box, highestSerial: serial, card: serial === saved.serial ? saved.card : current.box.card,
        ...(held ? { statusCreatedAt: held.created_at, statusId: held.id } : {}) }
      const r = readBoxStatus(w.candidate, w.seed, pin, this.#now())
      if (!r.ok) w.message = `Box status is not trusted: ${r.reason}.`
      else if (this.#save(w, { card: r.status.card, serial: r.status.link.serial, status: w.candidate })) {
        w.proof = r.status
        w.message = r.status.dropsUrl ? `Verified message endpoint: ${r.status.dropsUrl}` : r.status.drops ? 'The box has drops on, but advertises no message endpoint.' : 'The box’s drop tier is off.'
      }
    }
    this.opts.changed()
  }
  /** Re-evaluated when a message asks for its lane, not only by a timer. */
  circleRelays(): Map<string, CircleRelay> {
    const out = new Map<string, CircleRelay>()
    for (const w of this.#watches.values()) {
      const current = this.#current(w), proof = w.proof
      if (!current || !proof?.drops || !proof.dropsUrl || proof.validUntil <= this.#now()) continue
      const url = normalizeURL(proof.dropsUrl)
      out.set(url, { url, contact: w.contact, box: w.box, ...(current.contact.name ? { name: current.contact.name } : {}), source: 'refreshed' })
    }
    return out
  }
  tick(): void {
    const count = this.#watches.size
    this.reconcile()
    if (count !== this.#watches.size) this.opts.changed()
    for (const w of this.#watches.values()) if (w.proof && w.proof.validUntil <= this.#now()) this.#check(w)
  }
  restart(): void { for (const w of [...this.#watches.values()]) this.#stop(w); this.reconcile(); this.opts.changed() }
  #stop(w: Watch): void {
    this.#watches.delete(w.key); w.proof = undefined
    for (const stop of w.stops) stop()
    w.pool.close()
  }
  close(): void { clearInterval(this.#timer); for (const w of [...this.#watches.values()]) this.#stop(w) }
}
