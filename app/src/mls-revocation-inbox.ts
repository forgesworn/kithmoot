import type { Event } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { unwrapVmlsRevocationRequest, VMLS_REVOCATION_GIFT_WRAP_KIND, type VmlsRevocationIdentity, type VmlsRevocationRequest } from '../../src/vmls-revocation-request.js'
import { verifyEventUncached } from '../../src/verify.js'
import { InvalidPersonaRecord, type BrowserPersonaCoordinator, type CoordinationResult, type PersonaTransaction } from './mls-persona-coordinator.js'
import { readMlsMembership, saveMlsMembership, mlsStandaloneRevocationOperation } from './mls-membership-store.js'
import { MAX_MLS_REVOCATION_PROMPTS, MAX_MLS_REVOCATION_SEEN, MLS_REVOCATION_SEEN_SECONDS, type MlsRevocationInboxState, type MlsRevocationInboxPrompt } from './mls-revocation-inbox-store.js'
import { validateMlsGrant, type BrowserMlsGrantStore, type MlsGrantRecord } from './mls-grant-ledger.js'
import { readMlsRoom, mlsRoomIds } from './mls-room-store.js'
import { loadMlsEngine } from './mls-engine.js'
import type { VaultContext } from './mls-vault.js'
import type { Platform, Session } from '../public/vmls-wasm/vmls_wasm.js'

export const MAX_MLS_REVOCATION_CANDIDATES = 64
export const MAX_MLS_REVOCATION_DECRYPTIONS = 8
export class MlsRevocationInboxFull extends Error {}
export interface MlsRevocationInboxContext { vault: VaultContext; current(): boolean; foreground(): boolean }
export interface MlsKeeperRequestView { prompt: MlsRevocationInboxPrompt; grants: MlsGrantRecord[]; conflict: boolean }
export interface MlsRevocationInboxView { prompts: MlsKeeperRequestView[] }
type Coordinator = Pick<BrowserPersonaCoordinator, 'transact'>
const hex32 = /^[0-9a-f]{64}$/
type RosterCache = Map<string, { device: string; identity: string }[]>

/** Foreground intake only. It owns no network subscription or withdrawal
 * capability. Even a valid request only creates a prompt for explicit review. */
export class BrowserMlsRevocationInbox {
  #running = false
  constructor(private coordinator: Coordinator, private grants: Pick<BrowserMlsGrantStore, 'all'>,
    private context: () => MlsRevocationInboxContext | undefined,
    private now: () => number = () => Math.floor(Date.now() / 1000)) {}

  async view(): Promise<CoordinationResult<MlsRevocationInboxView>> {
    const scope = this.#scope(), current = () => this.#current(scope)
    return this.coordinator.transact(scope.vault.persona, async tx => {
      const state = await this.#state(tx, scope), ledger = await this.#ledger(), prompts: MlsKeeperRequestView[] = [], rosters: RosterCache = new Map()
      for (const prompt of state.prompts) {
        if (prompt.state !== 'pending') continue
        const grants = await this.#authority(tx, prompt.request, ledger, rosters)
        if (grants.length) prompts.push({ prompt: structuredClone(prompt), grants: structuredClone(grants), conflict: false })
      }
      for (const item of prompts) item.conflict = state.prompts.some(other => (other.state === 'pending' || other.state === 'approved') && other.request.sender === item.prompt.request.sender && other.request.device !== item.prompt.request.device)
      return { prompts }
    }, current)
  }

  async receive(wrappers: readonly Event[], identity: VmlsRevocationIdentity): Promise<CoordinationResult<MlsRevocationInboxView>> {
    if (this.#running) throw new Error('A foreground request check is already running.')
    if (!Array.isArray(wrappers) || wrappers.length > MAX_MLS_REVOCATION_CANDIDATES) throw new Error('Too many revocation request candidates.')
    const scope = this.#scope(), current = () => this.#current(scope)
    if (identity.pubkey !== scope.vault.persona) throw new Error('Sign in as the receiving keeper.')
    this.#running = true
    let decryptions = 0
    try {
      for (const candidate of wrappers.slice()) {
        if (!current()) return { state: 'pending', reason: 'stale', refused: false }
        // Every candidate consumes the 64-frame pass budget, including bad
        // signatures and malformed data. Never prompt a signer for those.
        if (!this.#outer(candidate, scope.vault.persona)) continue
        const wrapper: Event = { id: candidate.id, pubkey: candidate.pubkey, sig: candidate.sig, kind: candidate.kind,
          created_at: candidate.created_at, content: candidate.content, tags: [['p', scope.vault.persona]] }
        const before = await this.coordinator.transact(scope.vault.persona, async tx => {
          const state = await this.#state(tx, scope)
          if (state.seen.some(item => item.id === wrapper.id)) return false
          if (state.seen.length >= MAX_MLS_REVOCATION_SEEN) throw new MlsRevocationInboxFull('The request replay journal is full.')
          return true
        }, current)
        if (before.state !== 'active') return before
        if (!before.value) continue
        if (decryptions >= MAX_MLS_REVOCATION_DECRYPTIONS) break
        decryptions++
        const request = await unwrapVmlsRevocationRequest(wrapper, identity, this.#time(), current)
        if (!current()) return { state: 'pending', reason: 'stale', refused: false }
        const saved = await this.coordinator.transact(scope.vault.persona, async tx => {
          const state = await this.#state(tx, scope)
          if (state.seen.some(item => item.id === wrapper.id)) return
          if (state.seen.length >= MAX_MLS_REVOCATION_SEEN) throw new MlsRevocationInboxFull('The request replay journal is full.')
          if (request && request.keeper === scope.vault.persona && request.expiration > state.checkedAt) {
            const ledger = await this.#ledger(), grants = await this.#authority(tx, request, ledger)
            if (grants.length) {
              const operation = mlsStandaloneRevocationOperation(request.sender, request.keeper, request.device)
              const existing = state.prompts.find(item => item.operation === operation)
              if (!existing && state.prompts.length >= MAX_MLS_REVOCATION_PROMPTS) throw new MlsRevocationInboxFull('The keeper request inbox is full.')
              if (!existing) state.prompts.push({ operation, request: structuredClone(request), receivedAt: state.checkedAt, state: 'pending' })
              else if (existing.state !== 'done' && existing.state !== 'approved' && request.createdAt > existing.request.createdAt) {
                existing.request = structuredClone(request); existing.receivedAt = state.checkedAt; existing.state = 'pending'
              }
            }
          }
          state.seen.push({ id: wrapper.id, receivedAt: state.checkedAt })
          const journal = await readMlsMembership(tx); journal.inbox = state; await saveMlsMembership(tx, journal)
        }, current)
        if (saved.state !== 'active') return saved
      }
      if (!current()) return { state: 'pending', reason: 'stale', refused: false }
      return await this.view()
    } finally { this.#running = false }
  }

  async #state(tx: PersonaTransaction, scope: MlsRevocationInboxContext): Promise<MlsRevocationInboxState> {
    const journal = await readMlsMembership(tx), previous = journal.inbox, before = JSON.stringify(previous), now = this.#time()
    if (previous && previous.keeper !== scope.vault.persona) throw new InvalidPersonaRecord('Keeper inbox belongs to another persona')
    if (previous && now < previous.checkedAt) throw new Error('A trusted request time is unavailable.')
    const state = previous ?? { keeper: scope.vault.persona, checkedAt: now, seen: [], prompts: [] }
    state.checkedAt = now
    state.seen = state.seen.filter(item => item.receivedAt + MLS_REVOCATION_SEEN_SECONDS > now)
    // Done device tombstones are permanent. Expired unanswered requests no
    // longer authorise a prompt; their wrap ids retain the longer replay bound.
    state.prompts = state.prompts.filter(item => item.state === 'done' || item.state === 'approved' || item.request.expiration > now)
    if (before !== JSON.stringify(state)) {
      journal.inbox = state; await saveMlsMembership(tx, journal)
    }
    return state
  }
  async #ledger(): Promise<MlsGrantRecord[]> {
    const records = structuredClone(await this.grants.all())
    if (!Array.isArray(records) || records.length > 256) throw new Error('The keeper grant ledger could not be verified.')
    records.forEach(validateMlsGrant)
    if (new Set(records.map(record => `${record.node}/${record.device}`)).size !== records.length) throw new Error('The keeper grant ledger contains duplicate device authority.')
    return records
  }
  async #authority(tx: PersonaTransaction, request: VmlsRevocationRequest, ledger: readonly MlsGrantRecord[], rosters: RosterCache = new Map()): Promise<MlsGrantRecord[]> {
    const grants = ledger.filter(record => record.issuer === request.keeper && record.persona === request.sender && record.device === request.device && record.state !== 'revoked')
    if (!grants.length) return []
    const ids = await mlsRoomIds(tx)
    if (grants.some(grant => grant.rooms.some(use => !ids.includes(use.session)))) throw new Error('A keeper room must be restored before reviewing this request.')
    // Ledger room uses can be empty or stale after a Remove. The signed
    // ledger names authority, but every current keeper roster must still agree
    // about this device; neither ledger uses nor request hints scope the scan.
    for (const id of ids) {
      const room = await readMlsRoom(tx, id)
      if (room.keeper !== request.keeper) {
        if (grants.some(grant => grant.rooms.some(use => use.session === id))) throw new Error('A saved grant room no longer belongs to this keeper.')
        continue
      }
      const cached = rosters.get(id)
      if (cached) {
        if (cached.some(item => item.device === request.device && item.identity !== request.sender)) return []
        continue
      }
      const saved = await tx.readSession(id)
      if (!saved) throw new Error('A keeper room must be restored before reviewing this request.')
      let platform: Platform | undefined, session: Session | undefined
      try {
        const wasm = await loadMlsEngine()
        platform = new wasm.Platform(hexToBytes(room.binding.device), hexToBytes(room.binding.rendezvousKey), { fill: n => crypto.getRandomValues(new Uint8Array(n)) })
        session = wasm.Session.open(platform, hexToBytes(id), saved.plaintext, saved.generation)
        if (bytesToHex(session.id()) !== id || session.generation() !== saved.generation || room.generation !== String(saved.generation)) throw new InvalidPersonaRecord('Keeper room does not match witnessed snapshot')
        const members = session.members() as { member: { device: Uint8Array; identity: Uint8Array } }[]
        const roster = members.map(item => ({ device: bytesToHex(item.member.device), identity: bytesToHex(item.member.identity) }))
        rosters.set(id, roster)
        if (roster.some(item => item.device === request.device && item.identity !== request.sender)) return []
      } finally {
        saved.plaintext.fill(0)
        try { session?.free() } finally { platform?.free() }
      }
    }
    return grants
  }
  #outer(event: Event, keeper: string): boolean {
    try { return !!event && typeof event.id === 'string' && event.id.length === 64 && hex32.test(event.id) &&
      typeof event.pubkey === 'string' && event.pubkey.length === 64 && hex32.test(event.pubkey) &&
      typeof event.sig === 'string' && event.sig.length === 128 && /^[0-9a-f]{128}$/.test(event.sig) && event.kind === VMLS_REVOCATION_GIFT_WRAP_KIND &&
      Number.isSafeInteger(event.created_at) && event.created_at >= 0 &&
      typeof event.content === 'string' && event.content.length <= 40_000 && new TextEncoder().encode(event.content).length <= 40_000 &&
      Array.isArray(event.tags) && event.tags.length === 1 && Array.isArray(event.tags[0]) && event.tags[0].length === 2 && event.tags[0][0] === 'p' && event.tags[0][1] === keeper &&
      verifyEventUncached(event) } catch { return false }
  }
  #time(): number { const value = this.now(); if (!Number.isSafeInteger(value) || value < 0) throw new Error('A trusted request time is unavailable.'); return value }
  #scope(): MlsRevocationInboxContext {
    const scope = this.context()
    if (!scope || !scope.current() || !scope.foreground() || !hex32.test(scope.vault.persona)) throw new Error('Open the keeper account in the foreground before checking requests.')
    return scope
  }
  #current(scope: MlsRevocationInboxContext): boolean {
    const now = this.context()
    return !!now && now.current() && now.foreground() && now.vault.principal === scope.vault.principal && now.vault.persona === scope.vault.persona &&
      now.vault.generation === scope.vault.generation && now.vault.revision === scope.vault.revision
  }
}
