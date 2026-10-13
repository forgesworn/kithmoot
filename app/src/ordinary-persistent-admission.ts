import { hexToBytes } from '@noble/hashes/utils'
import { requestPersistentRoomAdmissionEvidence, type PersistentInvitationEvidenceResult } from '@forgesworn/fold-kit/persistent-invitation-evidence'
import { deriveInvitationId, roomInvitation, type RoomInvitation } from '../../src/invitation.js'
import { deriveRoom } from '../../src/room.js'
import type { PersistentRoomAdmission } from '../../src/persistent-invitation.js'
import type { RelayTransport } from '../../src/relay-pool.js'
import { OrdinaryStateOwner, type OrdinaryScope } from './ordinary-state-owner.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { KEPT_ADMISSION_PREFIX, CREDENTIAL_PREFIX, OWN_CREDENTIAL_PREFIX, storeKeptAdmission, type DeviceStore } from './device-store.js'
import { TAB_ADMISSION_PREFIX, storeTabAdmission } from './admission-store.js'
import { RelayConnections } from './relay-settings.js'
import { validateOrdinaryRoutingSnapshot } from './ordinary-routing-snapshot.js'
import { classifyOrdinaryPhysicalName } from './ordinary-physical-snapshot.js'
import { captureOrdinaryStartupContext, validateOrdinaryRoomAccessAndBookmarksSnapshot } from './ordinary-room-access-snapshot.js'
import { parseRoomLink } from '../../src/link.js'
import { ROOM_PREFIX } from './rooms-store.js'
import { bytesToHex } from '@noble/hashes/utils'
import { accountPrefix, makePersistentAdmissionProof, readPersistentAdmissionProof, inspectPersistentAdmissionProofs,
  persistentAdmissionDevice, persistentProofName, persistentTabProofName, tabProofBytes, PERSISTENT_PROOF_PREFIX,
  FIXED_INVITATION_RELAYS, MAX_PERSISTENT_PROOFS_PER_INVITATION, type VerifiedPersistentProof } from './persistent-admission-proof.js'

interface Selection { account: string | null; participant: string; invitationId: string; roomId: string; keep: boolean }
interface Options {
  browser: OrdinaryStateOwner
  tab: OrdinaryStateOwner
  invitation: RoomInvitation
  account: string | null
  participant: string
  roomId: string
  expectedRoomSecret: Uint8Array
  keep: boolean
  live(): boolean
  current(): Selection | undefined
}
interface Sources { browser: readonly (readonly [string, string | null])[]; tab: readonly (readonly [string, string | null])[]; device: string }
function hold(): never { throw new OrdinaryStateHold() }
function clone(admission: PersistentRoomAdmission): PersistentRoomAdmission {
  return { ...admission, secret: new Uint8Array(admission.secret), ...(admission.relays ? { relays: [...admission.relays] } : {}) }
}
function mapped(store: DeviceStore, participant: string): DeviceStore {
  const prefix = accountPrefix(participant)
  return { get: name => store.get(prefix + name), set: (name, value) => store.set(prefix + name, value),
    remove: name => store.remove(prefix + name), keys: () => store.keys().filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length)) }
}
function routing(store: DeviceStore): void {
  const records = new Map(store.keys().filter(name => name === 'kithmoot.relays.v1' || name === 'kithmoot.circle.v1' ||
    name === FIXED_INVITATION_RELAYS || name.startsWith('kithmoot.room-relays.v1.')).map(name => [name, store.get(name)!]))
  try { validateOrdinaryRoutingSnapshot(records, true, { kind: 'browser' }) } finally { records.clear() }
}
/** Actual evidence query + native custody for an already prepared room device.
 * The caller owns transport consent/lane/current membership. First-join device
 * construction, protected bootstrap and final effect adapters remain separate.
 * No default relay, pool construction, publication or plaintext fallback. */
export class OrdinaryPersistentAdmission {
  readonly #options: Options
  readonly #browserScope: OrdinaryScope
  readonly #tabScope: OrdinaryScope
  readonly #id: string
  readonly #work = new Set<Promise<unknown>>()
  readonly #abort = new AbortController()
  #closed = false
  private constructor(options: Options, browserScope: OrdinaryScope, tabScope: OrdinaryScope) {
    this.#options = options; this.#browserScope = browserScope; this.#tabScope = tabScope
    this.#id = deriveInvitationId(options.invitation)
  }
  static async open(input: Options): Promise<OrdinaryPersistentAdmission> {
    const invitation = roomInvitation(new Uint8Array(input.invitation.bearer), input.invitation.inviter, true)
    const captured = { ...input, invitation, expectedRoomSecret: new Uint8Array(input.expectedRoomSecret) }
    let state: OrdinaryPersistentAdmission | undefined
    try {
      if (input.invitation.persistent !== true || captured.expectedRoomSecret.length !== 32 || typeof captured.keep !== 'boolean' ||
          !/^[0-9a-f]{64}$/.test(captured.participant) || captured.account !== null && captured.account !== captured.participant) hold()
      const room = deriveRoom(captured.expectedRoomSecret)
      try { if (room.roomId !== captured.roomId) hold() } finally { room.roomKey.fill(0) }
      const id = deriveInvitationId(invitation)
      const live = () => { const selected = captured.current(); return captured.live() && selected?.account === captured.account &&
        selected.participant === captured.participant && selected.roomId === captured.roomId && selected.invitationId === id && selected.keep === captured.keep }
      const browserScope = await captured.browser.capture('invitation:' + id, live)
      const tabScope = await captured.tab.capture('invitation:' + id, live)
      state = new OrdinaryPersistentAdmission(captured, browserScope, tabScope)
      await state.#read((browser, tab) => {
        state!.#sources(browser, tab)
        persistentAdmissionDevice(browser, captured.roomId, captured.participant, captured.account)
        // Opening exposes no admission. Historical selected proof may require
        // an explicit fresh query after bounded credential/epoch history rolls
        // forward; load and final retention still require current continuity.
        const checked = inspectPersistentAdmissionProofs(browser, tab, { requireSelectedContinuity: false })
        try { state!.#selected(checked.selected) } finally { checked.close() }
      })
      return state
    } catch (error) { if (state) await state.close(); else { invitation.bearer.fill(0); captured.expectedRoomSecret.fill(0) }; throw error }
  }
  #identityLive = (): boolean => {
    const selected = this.#options.current()
    return !this.#closed && this.#options.live() && selected?.account === this.#options.account &&
      selected.participant === this.#options.participant && selected.roomId === this.#options.roomId && selected.invitationId === this.#id
  }
  #live = (): boolean => this.#identityLive() && this.#options.current()?.keep === this.#options.keep && Date.now() < this.#options.tab.expiresAt
  #track<T>(work: Promise<T>): Promise<T> {
    this.#work.add(work); void work.finally(() => this.#work.delete(work)).catch(() => {}); return work
  }
  #input<T>(work: (browser: DeviceStore, tab: DeviceStore) => T, live = this.#live) {
    return { browser: { owner: this.#options.browser, scope: this.#browserScope },
      tab: { owner: this.#options.tab, scope: this.#tabScope }, live, work }
  }
  #read<T>(work: (browser: DeviceStore, tab: DeviceStore) => T): Promise<T> {
    return this.#track(OrdinaryStateOwner.readPairMigrated(this.#input(work)))
  }
  #selected(selected: ReadonlyMap<string, VerifiedPersistentProof>): VerifiedPersistentProof | undefined {
    const key = accountPrefix(this.#options.participant) + 'kithmoot.admission-proof.v1.' + this.#id
    const verified = selected.get(key)
    if (!verified) return undefined
    const bound = verified.proof.binding
    if (bound.account !== this.#options.account || bound.participant !== this.#options.participant || bound.roomId !== this.#options.roomId ||
        JSON.stringify(bound.browser) !== JSON.stringify(this.#browserScope) ||
        JSON.stringify(bound.tab) !== JSON.stringify({ ...this.#tabScope, purpose: this.#options.tab.purpose, expiresAt: this.#options.tab.expiresAt }) ||
        verified.proof.kept.enabled !== this.#options.keep) hold()
    return verified
  }
  #usable(verified: VerifiedPersistentProof, store: DeviceStore): number {
    const now = Math.floor(Date.now() / 1000)
    if (verified.admission.endsAt !== undefined && verified.admission.endsAt <= now) hold()
    // Custody validation deliberately preserves expired credentials. Returning
    // admission additionally requires at least one presently usable bound one.
    const prefix = accountPrefix(this.#options.participant)
    const credentials = [CREDENTIAL_PREFIX, OWN_CREDENTIAL_PREFIX].flatMap(name =>
      [prefix + name + this.#options.roomId, name + this.#options.roomId].flatMap(physical => {
        const raw = store.get(physical); return raw === null ? [] : [JSON.parse(raw) as { id: string; tags: string[][] }]
      }))
    const currentDevice = persistentAdmissionDevice(store, this.#options.roomId, this.#options.participant, this.#options.account)
    const expiry = Math.max(...credentials.filter(event => currentDevice.credentialIds.includes(event.id))
      .map(event => Number(event.tags.find(tag => tag[0] === 'expiration')?.[1])))
    const until = Math.min(expiry, verified.admission.endsAt ?? Number.MAX_SAFE_INTEGER)
    if (!Number.isSafeInteger(until) || until <= now) hold()
    return until
  }
  #sources(browser: DeviceStore, tab: DeviceStore): Sources {
    const browserRecords = new Map(browser.keys().map(name => [name, browser.get(name)!])), tabRecords = new Map(tab.keys().map(name => [name, tab.get(name)!]))
    try {
      const context = captureOrdinaryStartupContext(browserRecords, tabRecords)
      validateOrdinaryRoomAccessAndBookmarksSnapshot(browserRecords, tabRecords, { browser: true, tab: true }, context)
    } finally { browserRecords.clear(); tabRecords.clear() }
    const raw = browser.get(accountPrefix(this.#options.participant) + ROOM_PREFIX + this.#options.roomId) ?? browser.get(ROOM_PREFIX + this.#options.roomId)
    if (raw === null) hold()
    const metadata = JSON.parse(raw) as { link: string; keep?: boolean }
    const link = parseRoomLink(metadata.link)
    try {
      if (metadata.keep !== this.#options.keep || !link.invitation?.persistent || deriveInvitationId(link.invitation) !== this.#id ||
          link.invitation.inviter !== this.#options.invitation.inviter || bytesToHex(link.invitation.bearer) !== bytesToHex(this.#options.invitation.bearer)) hold()
    } finally { link.secret?.fill(0); link.invitation?.bearer.fill(0); link.pairingCode?.fill(0) }
    const prefix = accountPrefix(this.#options.participant), proofs = prefix + PERSISTENT_PROOF_PREFIX + this.#id + '.'
    const browserNames = [...new Set([...browser.keys().filter(name => name.startsWith(proofs) ||
      ['access','bookmarks'].includes(classifyOrdinaryPhysicalName(name, 'browser')?.family ?? '')), prefix + KEPT_ADMISSION_PREFIX + this.#id,
      KEPT_ADMISSION_PREFIX + this.#id, FIXED_INVITATION_RELAYS].sort()
    )]
    const tabNames = [...new Set([...tab.keys().filter(name => ['access','navigation'].includes(classifyOrdinaryPhysicalName(name, 'tab')?.family ?? '')),
      prefix + TAB_ADMISSION_PREFIX + this.#id, TAB_ADMISSION_PREFIX + this.#id, prefix + 'kithmoot.admission-proof.v1.' + this.#id])].sort()
    return { browser: browserNames.map(name => [name, browser.get(name)]), tab: tabNames.map(name => [name, tab.get(name)]),
      device: JSON.stringify(persistentAdmissionDevice(browser, this.#options.roomId, this.#options.participant, this.#options.account)) }
  }
  #sameSources(browser: DeviceStore, tab: DeviceStore, expected: Sources): void {
    if (JSON.stringify(this.#sources(browser, tab)) !== JSON.stringify(expected)) hold()
  }
  async #retain(evidence: unknown, now: number, sources: Sources): Promise<PersistentRoomAdmission> {
    let captured: PersistentRoomAdmission | undefined
    let usableUntil = 0
    try {
      const answer = await OrdinaryStateOwner.mutatePairMigrated(this.#input((browser, tab) => {
        this.#sameSources(browser, tab, sources)
        const keptRaw = browser.get(accountPrefix(this.#options.participant) + KEPT_ADMISSION_PREFIX + this.#id)
        const keptAt = keptRaw === null ? now : (JSON.parse(keptRaw) as { createdAt: number }).createdAt
        if (!Number.isSafeInteger(keptAt) || keptAt < 0) hold()
        const verified = makePersistentAdmissionProof({ invitation: this.#options.invitation, evidence,
          account: this.#options.account, participant: this.#options.participant, browser: this.#browserScope,
          tab: { ...this.#tabScope, purpose: this.#options.tab.purpose, expiresAt: this.#options.tab.expiresAt },
          device: persistentAdmissionDevice(browser, this.#options.roomId, this.#options.participant, this.#options.account),
          keep: this.#options.keep, now: keptAt, expectedRoomSecret: this.#options.expectedRoomSecret })
        try {
          usableUntil = this.#usable(verified, browser); routing(browser)
          const prefix = accountPrefix(this.#options.participant), ownProofs = prefix + PERSISTENT_PROOF_PREFIX + this.#id + '.'
          const fixed = JSON.parse(browser.get(FIXED_INVITATION_RELAYS) ?? '{}') as Record<string, { c: string[]; signed: boolean }>
          const prior = fixed[this.#options.roomId], names = browser.keys().filter(name => name.startsWith(ownProofs))
          if (!this.#options.keep && prior?.signed && names.length === 0) hold()
          // An unsigned hint or bare historical signed row is not a replacement
          // proof. Recovery must reproduce the exact legacy list and claims.
          if (prior?.signed && names.length === 0 && (verified.admission.relays === undefined ||
              JSON.stringify(prior.c) !== JSON.stringify(verified.admission.relays))) hold()
          for (const [owner, name] of [[browser, KEPT_ADMISSION_PREFIX + this.#id], [tab, TAB_ADMISSION_PREFIX + this.#id],
            [browser, prefix + KEPT_ADMISSION_PREFIX + this.#id], [tab, prefix + TAB_ADMISSION_PREFIX + this.#id]] as const) {
            const legacy = owner.get(name)
            if (legacy === null) continue
            const expected = JSON.parse(legacy) as Record<string, unknown>
            const actual = { roomSecret: verified.proof.roomSecret, persistent: true, epoch: 0,
              ...(verified.admission.endsAt !== undefined ? { ends: verified.admission.endsAt } : {}),
              ...(verified.admission.destruct ? { destruct: true } : {}) }
            if (owner === browser) {
              if (!Number.isSafeInteger(expected.createdAt) || (expected.createdAt as number) < 0 || (expected.createdAt as number) > now) hold()
              delete expected.createdAt
            }
            if (JSON.stringify(expected) !== JSON.stringify(actual)) hold()
          }
          const physical = persistentProofName(verified.proof.binding)
          if (this.#options.keep) {
            const time = Date.now()
            // One slot per invitation and tab purpose. Refresh replaces only
            // its own counterpart; another live tab is never orphaned.
            for (const name of names) {
              const old = readPersistentAdmissionProof(browser.get(name)!)
              try { if (name !== physical && old.proof.binding.tab.expiresAt <= time) browser.remove(name) }
              finally { old.admission.secret.fill(0) }
            }
            if (!browser.keys().includes(physical) && browser.keys().filter(name => name.startsWith(ownProofs)).length >= MAX_PERSISTENT_PROOFS_PER_INVITATION) hold()
            browser.set(physical, JSON.stringify(verified.proof))
            storeKeptAdmission(mapped(browser, this.#options.participant), this.#id, verified.admission, keptAt)
            if (verified.admission.relays !== undefined) {
              if (verified.proof.selection.contributors.relays.length === 0) hold()
              const connections = new RelayConnections({ getItem: name => browser.get(name), setItem: (name, value) => browser.set(name, value) }, [])
              connections.setRoomRelays(this.#options.roomId, { fixed: verified.admission.relays, signed: true })
              const saved = JSON.parse(browser.get(FIXED_INVITATION_RELAYS) ?? '{}') as typeof fixed
              if (JSON.stringify(saved[this.#options.roomId]) !== JSON.stringify({ c: verified.admission.relays, signed: true })) hold()
            }
          } else if (names.length || browser.get(prefix + KEPT_ADMISSION_PREFIX + this.#id) !== null ||
              browser.get(KEPT_ADMISSION_PREFIX + this.#id) !== null) hold() // Explicit forget/fence before changing a durable choice.
          storeTabAdmission(mapped(tab, this.#options.participant), this.#options.invitation, verified.admission)
          tab.set(persistentTabProofName(verified.proof.binding), tabProofBytes(verified.proof))
          if (this.#options.keep) browser.remove(KEPT_ADMISSION_PREFIX + this.#id)
          tab.remove(TAB_ADMISSION_PREFIX + this.#id)
          const checked = inspectPersistentAdmissionProofs(browser, tab)
          try { this.#selected(checked.selected); captured = clone(verified.admission); return captured }
          finally { checked.close() }
        } finally { verified.admission.secret.fill(0) }
      }))
      if (!this.#live() || usableUntil <= Math.floor(Date.now() / 1000)) hold()
      return answer
    } catch (error) { captured?.secret.fill(0); throw error }
  }
  /** No origin Web Lock is held while querying. The exact pre-query sources
   * and both captured deletion fences must still match in the final commit. */
  request(transport: RelayTransport, now: number, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<PersistentRoomAdmission> {
    if (!Number.isSafeInteger(now) || now < 0) hold()
    const timeoutMs = options.timeoutMs, signal = options.signal
    return this.#track((async () => {
      const sources = await this.#read((browser, tab) => this.#sources(browser, tab))
      if (!this.#live()) hold()
      let query: PersistentInvitationEvidenceResult | undefined
      try {
        query = await requestPersistentRoomAdmissionEvidence({ transport, invitation: this.#options.invitation,
          timeoutMs, signal: signal ? AbortSignal.any([this.#abort.signal, signal]) : this.#abort.signal })
        if (!this.#live() || query.outcome.status !== 'admitted') hold()
        return await this.#retain(query.evidence, now, sources)
      } finally { if (query?.outcome.status === 'admitted') query.outcome.admission.secret.fill(0) }
    })())
  }
  load(): Promise<PersistentRoomAdmission | undefined> {
    let captured: PersistentRoomAdmission | undefined
    let usableUntil = 0
    return this.#read((browser, tab) => {
      const checked = inspectPersistentAdmissionProofs(browser, tab)
      try {
        const verified = this.#selected(checked.selected)
        if (!verified) {
          const prefix = accountPrefix(this.#options.participant)
          if (tab.get(prefix + TAB_ADMISSION_PREFIX + this.#id) !== null || tab.get(TAB_ADMISSION_PREFIX + this.#id) !== null) hold()
          return undefined
        }
        usableUntil = this.#usable(verified, browser); captured = clone(verified.admission); return captured
      } finally { checked.close() }
    }).then(answer => { if (!this.#live() || answer && usableUntil <= Math.floor(Date.now() / 1000)) hold(); return answer })
      .catch(error => { captured?.secret.fill(0); throw error })
  }
  /** Local invitation custody is removed with both captured fences. Other
   * tab leases must observe the browser fence before effects; their encrypted
   * images are not claimed erased here. Reopening requires an explicit choice. */
  forget(): Promise<void> {
    return this.#track(OrdinaryStateOwner.forgetPairMigrated(this.#input((browser, tab) => {
      const prefix = accountPrefix(this.#options.participant), ownProofs = prefix + PERSISTENT_PROOF_PREFIX + this.#id + '.'
      for (const name of browser.keys()) if (name.startsWith(ownProofs)) browser.remove(name)
      browser.remove(prefix + KEPT_ADMISSION_PREFIX + this.#id); browser.remove(KEPT_ADMISSION_PREFIX + this.#id)
      tab.remove(prefix + TAB_ADMISSION_PREFIX + this.#id); tab.remove(TAB_ADMISSION_PREFIX + this.#id)
      tab.remove(prefix + 'kithmoot.admission-proof.v1.' + this.#id)
      routing(browser)
      const remaining = inspectPersistentAdmissionProofs(browser, { ...tab, keys: () => [] })
      try {
        if (![...remaining.proofs.values()].some(value => value.proof.binding.roomId === this.#options.roomId)) {
          const raw = browser.get(FIXED_INVITATION_RELAYS)
          if (raw !== null) { const fixed = JSON.parse(raw) as Record<string, unknown>; delete fixed[this.#options.roomId]; browser.set(FIXED_INVITATION_RELAYS, JSON.stringify(fixed)) }
        }
      } finally { remaining.close() }
    }, this.#identityLive)).then(() => { this.#closed = true; this.#abort.abort(); this.#options.invitation.bearer.fill(0); this.#options.expectedRoomSecret.fill(0) }))
  }
  retryRetention(): void { this.#options.browser.retryRetention(); this.#options.tab.retryRetention() }
  async close(): Promise<void> {
    this.#closed = true; this.#abort.abort()
    await Promise.allSettled([...this.#work])
    this.#options.invitation.bearer.fill(0); this.#options.expectedRoomSecret.fill(0)
  }
}
