import type { MlsKeeperInboxScanMode } from './mls-keeper-inbox-fetch.js'
import type { VmlsRevocationIdentity } from '../../src/vmls-revocation-request.js'
import { BrowserMlsGrantEndpoint } from './mls-grant-endpoint.js'
import type { BrowserPersonaCoordinator, CoordinationResult } from './mls-persona-coordinator.js'
import { readMlsMembership, saveMlsMembership } from './mls-membership-store.js'
import { MLS_REVOCATION_SEEN_SECONDS } from './mls-revocation-inbox-store.js'
import { mlsRevocationInboxState } from './mls-revocation-inbox-state.js'
import { BrowserMlsRevocationInbox, type MlsRevocationInboxContext, type MlsRevocationInboxView } from './mls-revocation-inbox.js'
import { verifiedMlsKeeperInboxPageEvent, verifiedMlsKeeperInboxWrap } from './mls-keeper-inbox-relay.js'

export interface MlsKeeperPrivateInboxPermission {
  routeId: string
  mode?: MlsKeeperInboxScanMode
  authenticate: boolean
  current(): boolean
}
export interface MlsKeeperPrivateInboxScanResult {
  mode: MlsKeeperInboxScanMode
  status: 'checked' | 'rate-limited'
  routeId: string
  complete: boolean
  view: MlsRevocationInboxView
}

/** Explicit finite keeper reads from this concrete endpoint's saved Bothy.
 * No directory lookup, public route gate or public fallback. Public and private
 * scans share the witnessed page budget but never share cursor identity. */
export class BrowserMlsKeeperPrivateInboxFetch {
  #running = false
  constructor(private coordinator: Pick<BrowserPersonaCoordinator, 'transact'>,
    private inbox: Pick<BrowserMlsRevocationInbox, 'receive' | 'view'>,
    private endpoint: BrowserMlsGrantEndpoint,
    private context: () => MlsRevocationInboxContext | undefined,
    private now: () => number = () => Math.floor(Date.now() / 1000)) {
    if (!(endpoint instanceof BrowserMlsGrantEndpoint)) throw new Error('Use the dedicated grant endpoint for private inbox reads.')
  }
  async check(identity: VmlsRevocationIdentity, input: MlsKeeperPrivateInboxPermission): Promise<CoordinationResult<MlsKeeperPrivateInboxScanResult>> {
    if (this.#running) throw new Error('A private keeper inbox check is already running.')
    const scope = this.context()
    if (!scope || !scope.current() || !scope.foreground() || !/^[0-9a-f]{64}$/.test(scope.vault.persona) || identity.pubkey !== scope.vault.persona) throw new Error('Open the receiving keeper in the foreground.')
    if (!input || typeof input.routeId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}(?![\s\S])/.test(input.routeId) ||
        input.authenticate !== true || typeof input.current !== 'function') throw new Error('Select a saved private route and explicitly allow keeper identification to that Bothy.')
    const mode = input.mode ?? 'latest'
    if (mode !== 'latest' && mode !== 'retained') throw new Error('Select a latest or retained private inbox check.')
    const permission = { routeId: input.routeId, current: input.current.bind(input) }
    const current = () => {
      const next = this.context()
      return !!next && next.current() && next.foreground() && permission.current() && next.vault.persona === scope.vault.persona &&
        next.vault.principal === scope.vault.principal && next.vault.generation === scope.vault.generation && next.vault.revision === scope.vault.revision
    }
    const signer: VmlsRevocationIdentity = { pubkey: identity.pubkey, signEvent: identity.signEvent.bind(identity),
      encrypt: identity.encrypt.bind(identity), decrypt: identity.decrypt.bind(identity) }
    this.#running = true
    try {
      if (!current()) return { state: 'pending', reason: 'stale', refused: false }
      const initial = await this.inbox.view(current)
      if (initial.state !== 'active') return initial
      const boxes = await this.endpoint.pairedBoxes(scope.vault.persona)
      if (!current()) return { state: 'pending', reason: 'stale', refused: false }
      const saved = boxes.find(box => box.routeId === permission.routeId)
      if (!saved) throw new Error('The selected private Bothy is not saved on this grant connection.')
      const selected = Object.freeze({ routeId: saved.routeId, eventUrl: saved.eventUrl }), key = (item: { keeper: string; routeId: string; eventUrl: string }) =>
        item.keeper === scope.vault.persona && item.routeId === selected.routeId && item.eventUrl === selected.eventUrl
      const reserved = await this.coordinator.transact(scope.vault.persona, async tx => {
        const state = await mlsRevocationInboxState(tx, scope.vault.persona, this.#time())
        const scan = state.privateScan ?? { lastPageAt: null, cursors: [] }
        if (Math.max(scan.lastPageAt ?? -60, state.scan?.lastPageAt ?? -60) + 60 > state.checkedAt) return undefined
        // Retire only cursors whose saved destination is absent, never alias a
        // replacement route or a public relay with an earlier private cursor.
        scan.cursors = scan.cursors.filter(cursor => boxes.some(box => cursor.keeper === scope.vault.persona && box.routeId === cursor.routeId && box.eventUrl === cursor.eventUrl))
        const since = Math.max(0, state.checkedAt - MLS_REVOCATION_SEEN_SECONDS)
        let cursor = scan.cursors.find(key)
        if (!cursor) { cursor = { keeper: scope.vault.persona, routeId: selected.routeId, eventUrl: selected.eventUrl, until: state.checkedAt }; scan.cursors.push(cursor) }
        // Latest probes leave retained backfill intact, including held or
        // expired boundaries. Retained work cannot silently become a new head.
        const until = mode === 'latest' ? state.checkedAt : cursor.until
        scan.lastPageAt = state.checkedAt; state.privateScan = scan
        const journal = await readMlsMembership(tx); journal.inbox = state; await saveMlsMembership(tx, journal)
        return { since, until, retainedUntil: cursor.until, at: state.checkedAt }
      }, current)
      if (reserved.state !== 'active') return reserved
      if (!reserved.value) return { ...initial, value: { status: 'rate-limited', mode, routeId: selected.routeId, complete: false, view: initial.value } }
      const pageScope = reserved.value
      if (pageScope.until < pageScope.since) return { ...initial, value: { status: 'checked', mode, routeId: selected.routeId, complete: false, view: initial.value } }
      const resumed = await this.endpoint.resume(scope.vault.persona)
      if (!current() || !resumed.some(box => box.routeId === selected.routeId && box.eventUrl === selected.eventUrl)) return { state: 'pending', reason: 'stale', refused: false }
      const page = await this.endpoint.keeperInboxPage(selected, { keeper: scope.vault.persona, since: pageScope.since, until: pageScope.until,
        authenticate: true, current })
      if (!current()) return { state: 'pending', reason: 'stale', refused: false }
      if (!page || !Array.isArray(page.events) || page.events.length > 64 || typeof page.complete !== 'boolean') throw new Error('Invalid private keeper inbox page.')
      const pageEvents = page.events.filter(event => verifiedMlsKeeperInboxPageEvent(event, scope.vault.persona, pageScope.since, pageScope.until))
      const candidates = pageEvents.filter(event => verifiedMlsKeeperInboxWrap(event, scope.vault.persona, pageScope.since, pageScope.until))
      const received = await this.inbox.receive(candidates, signer, current)
      if (received.state !== 'active') return received
      return this.coordinator.transact(scope.vault.persona, async tx => {
        const state = await mlsRevocationInboxState(tx, scope.vault.persona, this.#time())
        const cursor = state.privateScan?.cursors.find(key)
        const processed = candidates.every(event => state.seen.some(item => item.id === event.id))
        const oldest = pageEvents.length ? Math.min(...pageEvents.map(event => event.created_at)) : undefined
        // NIP-01 EOSE and a short page do not prove this second is drained:
        // the server may impose a smaller item or byte cap than requested.
        const progress = oldest !== undefined && oldest < pageScope.until
        const complete = page.complete && processed && progress && state.privateScan?.lastPageAt === pageScope.at && cursor?.until === pageScope.retainedUntil
        if (complete && cursor && mode === 'retained') {
          // No subtraction or head reset without a stronger paging proof.
          cursor.until = oldest!
          const journal = await readMlsMembership(tx); journal.inbox = state; await saveMlsMembership(tx, journal)
        }
        return { status: 'checked' as const, mode, routeId: selected.routeId, complete, view: received.value }
      }, current)
    } finally { this.#running = false }
  }
  #time(): number { const now = this.now(); if (!Number.isSafeInteger(now) || now < 0) throw new Error('A trusted request time is unavailable.'); return now }
}
