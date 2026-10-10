import type { Event } from 'nostr-tools/pure'
import { KIND_DM_RELAYS, latestDmRelayList } from '../../src/dm-relays.js'
import { verifyEventUncached } from '../../src/verify.js'
import { normaliseRelayConfig, type RelayConfig } from '../../src/relay-pool.js'
import type { VmlsRevocationIdentity } from '../../src/vmls-revocation-request.js'
import { type BrowserPersonaCoordinator, type CoordinationResult } from './mls-persona-coordinator.js'
import { readMlsMembership, saveMlsMembership } from './mls-membership-store.js'
import { MLS_REVOCATION_SEEN_SECONDS } from './mls-revocation-inbox-store.js'
import { mlsRevocationInboxState } from './mls-revocation-inbox-state.js'
import { BrowserMlsRevocationInbox, type MlsRevocationInboxContext, type MlsRevocationInboxView } from './mls-revocation-inbox.js'
import { verifiedMlsKeeperInboxWrap, type MlsKeeperInboxPage, type MlsKeeperInboxQuery } from './mls-keeper-inbox-relay.js'

export interface MlsKeeperInboxScanResult {
  status: 'no-list' | 'rate-limited' | 'checked'
  relay?: string
  complete: boolean
  view: MlsRevocationInboxView
}
export interface MlsKeeperInboxReadPermission {
  relay: RelayConfig
  authenticate: boolean
  current(): boolean
}

/** Explicit foreground checks only. Each relay has its own witnessed cursor;
 * a page and its signer attempts are reserved before external effects. */
export class BrowserMlsKeeperInboxFetch {
  #running = false
  constructor(private coordinator: Pick<BrowserPersonaCoordinator, 'transact'>,
    private inbox: Pick<BrowserMlsRevocationInbox, 'receive' | 'view'>,
    private transport: { directory(keeper: string): Promise<readonly Event[]>; page(query: MlsKeeperInboxQuery): Promise<MlsKeeperInboxPage> },
    private context: () => MlsRevocationInboxContext | undefined,
    private now: () => number = () => Math.floor(Date.now() / 1000)) {}

  async check(identity: VmlsRevocationIdentity, permissions: readonly MlsKeeperInboxReadPermission[] = []): Promise<CoordinationResult<MlsKeeperInboxScanResult>> {
    if (this.#running) throw new Error('A foreground keeper inbox check is already running.')
    const scope = this.#scope(), current = () => this.#current(scope)
    if (identity.pubkey !== scope.vault.persona) throw new Error('Sign in as the receiving keeper.')
    const signer: VmlsRevocationIdentity = { pubkey: identity.pubkey, signEvent: identity.signEvent.bind(identity), encrypt: identity.encrypt.bind(identity), decrypt: identity.decrypt.bind(identity) }
    if (!Array.isArray(permissions) || permissions.length > 6) throw new Error('Invalid keeper inbox read permissions.')
    if (permissions.some(permission => !permission || typeof permission.authenticate !== 'boolean' || typeof permission.current !== 'function')) throw new Error('Invalid keeper inbox read permissions.')
    const allowed = permissions.map(permission => ({ relay: normaliseRelayConfig([permission.relay])[0]!, authenticate: permission.authenticate, current: permission.current.bind(permission) }))
    if (new Set(allowed.map(item => item.relay.url)).size !== allowed.length) throw new Error('Duplicate keeper inbox read permission.')
    this.#running = true
    try {
      const initial = await this.inbox.view()
      if (initial.state !== 'active') return initial
      const directory = await this.coordinator.transact(scope.vault.persona, async tx => {
        const state = await mlsRevocationInboxState(tx, scope.vault.persona, this.#time())
        if (state.scan?.lastPageAt !== null && state.scan?.lastPageAt !== undefined && state.scan.lastPageAt + 60 > state.checkedAt) return { limited: true as const }
        if (state.directory && state.directory.at + 900 > state.checkedAt) {
          if (!state.directory.complete) throw new Error('The last keeper directory lookup is unconfirmed. Wait fifteen minutes before checking again.')
          return { relays: state.directory.relays.slice() }
        }
        state.directory = { at: state.checkedAt, complete: false, relays: [] }
        const journal = await readMlsMembership(tx); journal.inbox = state; await saveMlsMembership(tx, journal)
        return { lookupAt: state.checkedAt }
      }, current)
      if (directory.state !== 'active') return directory
      if ('limited' in directory.value) return { ...initial, value: { status: 'rate-limited', complete: false, view: initial.value } }
      let relays: string[]
      if (directory.value.relays !== undefined) relays = directory.value.relays
      else {
        const events = await this.transport.directory(scope.vault.persona)
        if (!current()) return { state: 'pending', reason: 'stale', refused: false }
        if (!Array.isArray(events) || events.length > 8) throw new Error('The keeper relay directory is too large.')
        const verified = events.filter(event => {
          try { return event.kind === KIND_DM_RELAYS && event.pubkey === scope.vault.persona && Number.isSafeInteger(event.created_at) && event.created_at >= 0 && event.created_at <= this.#time() && JSON.stringify(event).length <= 32_000 && verifyEventUncached(event) } catch { return false }
        })
        relays = latestDmRelayList(verified, scope.vault.persona)
        const cached = await this.coordinator.transact(scope.vault.persona, async tx => {
          const state = await mlsRevocationInboxState(tx, scope.vault.persona, this.#time())
          if (!state.directory || state.directory.at !== directory.value.lookupAt || state.directory.complete) throw new Error('The keeper directory lookup was superseded.')
          state.directory = { at: state.directory.at, complete: true, relays: relays.slice() }
          const journal = await readMlsMembership(tx); journal.inbox = state; await saveMlsMembership(tx, journal)
        }, current)
        if (cached.state !== 'active') return cached
      }
      if (!relays.length) return { ...initial, value: { status: 'no-list', complete: false, view: initial.value } }
      const reserved = await this.coordinator.transact(scope.vault.persona, async tx => {
        const state = await mlsRevocationInboxState(tx, scope.vault.persona, this.#time())
        const scan = state.scan ?? { lastPageAt: null, nextRelay: null, cursors: [] }
        if (scan.lastPageAt !== null && scan.lastPageAt + 60 > state.checkedAt) return undefined
        // Drop removed relays, retaining each remaining relay's own progress.
        scan.cursors = scan.cursors.filter(cursor => relays.includes(cursor.relay))
        const url = scan.nextRelay && relays.includes(scan.nextRelay) ? scan.nextRelay : relays[0]!
        const permission = allowed.find(item => item.relay.url === url)
        if (permission && (!permission.relay.read || !permission.current())) throw new Error('Keeper inbox relay permission changed.')
        const relay = permission?.relay ?? normaliseRelayConfig([{ url, read: true, write: false }])[0]!
        if (relay.circle && !permission?.authenticate) throw new Error('Allow keeper authentication before reading this circle relay.')
        const since = Math.max(0, state.checkedAt - MLS_REVOCATION_SEEN_SECONDS)
        let cursor = scan.cursors.find(item => item.relay === url)
        if (!cursor) { cursor = { relay: url, until: state.checkedAt }; scan.cursors.push(cursor) }
        if (cursor.until < since) cursor.until = state.checkedAt
        scan.lastPageAt = state.checkedAt
        scan.nextRelay = relays[(relays.indexOf(url) + 1) % relays.length]!
        state.scan = scan
        const journal = await readMlsMembership(tx); journal.inbox = state; await saveMlsMembership(tx, journal)
        return { relay: { ...relay }, since, until: cursor.until, at: state.checkedAt, permission }
      }, current)
      if (reserved.state !== 'active') return reserved
      if (!reserved.value) return { ...initial, value: { status: 'rate-limited', complete: false, view: initial.value } }
      const selected = reserved.value, live = () => current() && (!selected.permission || selected.permission.current())
      const page = await this.transport.page({ relay: selected.relay, keeper: scope.vault.persona, since: selected.since, until: selected.until, current: live,
        ...(selected.permission?.authenticate ? { authentication: signer } : {}) })
      if (!live()) return { state: 'pending', reason: 'stale', refused: false }
      if (!page || !Array.isArray(page.events) || page.events.length > 64 || typeof page.complete !== 'boolean') throw new Error('Invalid keeper inbox page.')
      const candidates = page.events.filter(event => verifiedMlsKeeperInboxWrap(event, scope.vault.persona, selected.since, selected.until))
      const received = await this.inbox.receive(candidates, signer)
      if (received.state !== 'active') return received
      return await this.coordinator.transact(scope.vault.persona, async tx => {
        const state = await mlsRevocationInboxState(tx, scope.vault.persona, this.#time())
        const cursor = state.scan?.cursors.find(item => item.relay === selected.relay.url)
        const processed = candidates.every(event => state.seen.some(item => item.id === event.id))
        const complete = page.complete && processed && state.scan?.lastPageAt === selected.at && cursor?.until === selected.until
        if (complete && cursor) {
          // Read the boundary second inclusively once before moving past it.
          const oldest = candidates.length ? Math.min(...candidates.map(event => event.created_at)) : selected.since
          cursor.until = oldest < selected.until ? oldest : Math.max(0, selected.until - 1)
          if (!candidates.length || cursor.until < selected.since) cursor.until = state.checkedAt
          const journal = await readMlsMembership(tx); journal.inbox = state; await saveMlsMembership(tx, journal)
        }
        return { status: 'checked' as const, relay: selected.relay.url, complete, view: received.value }
      }, live)
    } finally { this.#running = false }
  }
  #time(): number { const now = this.now(); if (!Number.isSafeInteger(now) || now < 0) throw new Error('A trusted request time is unavailable.'); return now }
  #scope(): MlsRevocationInboxContext {
    const scope = this.context()
    if (!scope || !scope.current() || !scope.foreground() || !/^[0-9a-f]{64}$/.test(scope.vault.persona)) throw new Error('Open the keeper account in the foreground before checking requests.')
    return scope
  }
  #current(scope: MlsRevocationInboxContext): boolean {
    const now = this.context()
    return !!now && now.current() && now.foreground() && now.vault.principal === scope.vault.principal && now.vault.persona === scope.vault.persona && now.vault.generation === scope.vault.generation && now.vault.revision === scope.vault.revision
  }
}
