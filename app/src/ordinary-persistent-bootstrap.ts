import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { revalidatePersistentInvitationEvidence } from '@forgesworn/fold-kit/persistent-invitation-evidence'
import { createDeviceCredential } from '../../src/credential.js'
import type { ParticipantIdentity } from '../../src/identity.js'
import type { DeviceCredential } from '../../src/types.js'
import { deriveInvitationId, roomInvitation, type RoomInvitation } from '../../src/invitation.js'
import { parseRoomLink, type RoomLink } from '../../src/link.js'
import { deriveRoom } from '../../src/room.js'
import { generateSealKey } from '../../src/seal.js'
import type { PersistentRoomAdmission } from '../../src/persistent-invitation.js'
import { RelayConnections } from './relay-settings.js'
import { OrdinaryStateHold, ordinaryUtf8Length } from './ordinary-state-codec.js'
import { OrdinaryStateOwner, ordinaryPairCustodyFor, ordinaryPairProjectedByteLengths,
  type OrdinaryScope, type OrdinaryPairCustody } from './ordinary-state-owner.js'
import { captureOrdinarySnapshotContext, validateOrdinarySnapshot } from './ordinary-snapshot.js'
import { classifyOrdinaryPhysicalName } from './ordinary-physical-snapshot.js'
import { validateOrdinaryEmbeddedDeviceCredential } from './ordinary-identity-snapshot.js'
import { DEVICE_PREFIX, OWN_CREDENTIAL_PREFIX, OWN_SEAL_PREFIX, KEPT_ADMISSION_PREFIX,
  deviceKeyFor, storeOwnCredentialFor, storeKeptAdmission, type DeviceStore } from './device-store.js'
import { storeTabAdmission, TAB_ADMISSION_PREFIX } from './admission-store.js'
import { rememberRoom, setKeepRoom, ROOM_PREFIX } from './rooms-store.js'
import { accountPrefix, makePersistentAdmissionProof, inspectPersistentAdmissionProofs, persistentAdmissionDeviceInPair,
  persistentProofName, persistentTabProofName, tabProofBytes, FIXED_INVITATION_RELAYS, MAX_PERSISTENT_PROOF_BYTES,
  PERSISTENT_PROOF_V2_PREFIX, PERSISTENT_TAB_PROOF_V2_PREFIX,
  type PersistentDeviceCustody, type VerifiedPersistentProof } from './persistent-admission-proof.js'
import { inspectPersistentCreatorProofs, creatorIsSelected } from './persistent-creator-proof.js'
import { queryInvitationOnProtectedCarrier, type OrdinaryInvitationQueryOptions } from './ordinary-invitation-query.js'
import type { PersistentInvitationEvidenceResult } from '@forgesworn/fold-kit/persistent-invitation-evidence'
import { OrdinaryForegroundSigner } from './ordinary-foreground-signer.js'
import { signOrdinaryVisitorCredential } from './ordinary-participant-signing.js'
import type { ProtocolExecution } from '../../src/protocol-execution.js'
import { RoomSession, RESUME_MIN_REMAINING_SECONDS } from '../../src/session.js'
import { MAX_POOL_RELAYS, normaliseRelayConfig } from '../../src/relay-pool.js'
import type { SendOptions, ChatMessage } from '../../src/chat.js'
import { captureProtocolData } from '../../src/protocol-execution.js'
import { OrdinaryRelayCarrier } from './ordinary-relay-carrier.js'

const HEX = /^[0-9a-f]{64}$/
const DEVICE_OWNER = 'kithmoot.device-owner.'
const CREDENTIAL_BYTES = 4096
function hold(): never { throw new OrdinaryStateHold() }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function map(store: DeviceStore): Map<string, string> { return new Map(store.keys().map(name => [name, store.get(name)!])) }
function view(records: Map<string, string>): DeviceStore {
  return { get: name => records.get(name) ?? null, set: (name, raw) => { records.set(name, raw) },
    remove: name => { records.delete(name) }, keys: () => [...records.keys()] }
}
function scoped(store: DeviceStore, participant: string): DeviceStore {
  const prefix = accountPrefix(participant)
  return { get: name => store.get(prefix + name), set: (name, raw) => store.set(prefix + name, raw),
    remove: name => store.remove(prefix + name), keys: () => store.keys().filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length)) }
}
function wipeLink(link: RoomLink): void { link.secret?.fill(0); link.invitation?.bearer.fill(0); link.pairingCode?.fill(0) }
interface Selection {
  readonly account: string | null
  readonly participant: string
  readonly invitationId: string
  readonly link: string
  readonly keep: boolean
  readonly credentialExpiresAt: number
  readonly identity: ParticipantIdentity
}
interface Options {
  readonly browser: OrdinaryStateOwner
  readonly tab: OrdinaryStateOwner
  readonly invitation: RoomInvitation
  readonly account: string | null
  readonly identity: ParticipantIdentity
  readonly link: string
  readonly keep: boolean
  readonly credentialExpiresAt: number
  readonly current: () => Selection | undefined
  readonly live: () => boolean
}
interface OpenedImage {
  readonly browser: readonly (readonly [string, string])[]
  readonly tab: readonly (readonly [string, string])[]
  readonly browserRevision: number
  readonly tabRevision: number
}
interface Sources extends OpenedImage {
  readonly browser: readonly (readonly [string, string])[]
  readonly tab: readonly (readonly [string, string])[]
  readonly deviceCustody: PersistentDeviceCustody
  readonly browserRevision: number
  readonly tabRevision: number
}
/** Owned copies, released only after acknowledged custody and a fresh native
 * read. The consumer wipes all three buffers when its session ends. These
 * credentials prove custody/participant signing, not current MLS membership. */
export interface OrdinaryPersistentBootstrapResult {
  readonly admission: PersistentRoomAdmission
  readonly deviceKey: Uint8Array
  readonly sealKey: Uint8Array
  readonly credential: DeviceCredential
}
interface OrdinaryMemberProtocolExecution extends ProtocolExecution {
  /** Extra consumer on a genuine carrier's exact current read. */
  validate(browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody): void
  close(): void
  joinLifetime(): Promise<void>
}
type MemberCarrierOptions = Omit<Parameters<typeof OrdinaryRelayCarrier.open>[0], 'browser' | 'tab' | 'scope' | 'account' | 'participant' | 'validate' | 'onClose'>
export interface OrdinaryMemberSessionOptions extends MemberCarrierOptions {
  readonly name?: string
  readonly epochRequestTimeoutMs?: number
}
export interface OrdinaryMemberConversation {
  send(text: string, options?: SendOptions): Promise<void>
  prepare(text: string, options?: SendOptions): Promise<{ publish(): Promise<void> }>
  messages(): Promise<ChatMessage[]>
}
export interface OrdinaryOwnedMemberSession extends OrdinaryMemberConversation {
  readonly roomId: string
  readonly participant: string
  readonly device: string
  join(): Promise<void>
  channel(name: string): Promise<OrdinaryMemberConversation>
  publishDescriptor(config: Parameters<RoomSession['publishDescriptor']>[0]): Promise<void>
  close(): Promise<void>
}
export function wipeOrdinaryPersistentBootstrapResult(result: OrdinaryPersistentBootstrapResult | undefined): void {
  result?.admission.secret.fill(0); result?.deviceKey.fill(0); result?.sealKey.fill(0)
}
/** First-member construction over actual completed Fold query evidence. No
 * transport is created here. The caller must query on an authorised carrier;
 * guarded queries, tab epochs and production entry mounting remain separate.
 * Existing prepared/v1/other-actor room custody is never relabelled. */
export class OrdinaryPersistentBootstrap {
  readonly #options: Options
  readonly #participant: string
  readonly #sign: ParticipantIdentity['signEvent']
  readonly #browserScope: OrdinaryScope
  readonly #tabScope: OrdinaryScope
  readonly #id: string
  readonly #work = new Set<Promise<unknown>>()
  readonly #protocols = new Set<OrdinaryMemberProtocolExecution>()
  readonly #sessionCleanup = new Set<Promise<void>>()
  #sessionStarting = false
  #closed = false
  #attempted = false
  #starting = false
  #forgetting = false
  #effectUntil: number | undefined
  #candidateOperation: string | undefined
  #ownedOperation: string | undefined
  #openedImage: OpenedImage | undefined
  #queryStarting = false
  #queryAbort: AbortController | undefined
  private constructor(options: Options, participant: string, sign: ParticipantIdentity['signEvent'], browser: OrdinaryScope, tab: OrdinaryScope) {
    this.#options = options; this.#participant = participant; this.#sign = sign
    this.#browserScope = browser; this.#tabScope = tab; this.#id = deriveInvitationId(options.invitation)
  }
  static async open(input: Options): Promise<OrdinaryPersistentBootstrap> {
    let invitation: RoomInvitation | undefined, state: OrdinaryPersistentBootstrap | undefined
    try {
      // Capture the actual identity object and sign method before native waits.
      const captured = { ...input }, participant = captured.identity.pubkey, sign = captured.identity.signEvent
      invitation = roomInvitation(new Uint8Array(captured.invitation.bearer), captured.invitation.inviter, true)
      const options = { ...captured, invitation }
      if (captured.invitation.persistent !== true || !HEX.test(participant) || typeof sign !== 'function' ||
          options.account !== null && (options.account !== participant || !OrdinaryForegroundSigner.isNativeSigner(options.identity)) || typeof options.keep !== 'boolean' ||
          !integer(options.credentialExpiresAt) || options.credentialExpiresAt === 0 || typeof options.link !== 'string') hold()
      const link = parseRoomLink(options.link), id = deriveInvitationId(invitation)
      try {
        if (link.secret || link.pairingCode || !link.invitation?.persistent || deriveInvitationId(link.invitation) !== id ||
            link.invitation.inviter !== invitation.inviter || bytesToHex(link.invitation.bearer) !== bytesToHex(invitation.bearer)) hold()
      } finally { wipeLink(link) }
      const live = () => {
        const selected = options.current()
        return options.live() && options.identity.pubkey === participant && options.identity.signEvent === sign &&
          selected?.identity === options.identity && selected.account === options.account && selected.participant === participant &&
          selected.invitationId === id && selected.link === options.link && selected.keep === options.keep &&
          selected.credentialExpiresAt === options.credentialExpiresAt
      }
      const name = 'invitation:' + participant + ':' + id
      const browser = await options.browser.capture(name, live), tab = await options.tab.capture(name, live)
      state = new OrdinaryPersistentBootstrap({ ...options, live }, participant, sign, browser, tab)
      await state.#read((b, t, custody) => {
        state!.#preflight(b, t, custody)
        state!.#ownedOperation = state!.#selected(b, t, custody)?.operation
        state!.#openedImage = state!.#image(b, t, custody)
      })
      return state
    } catch (error) { if (state) await state.close(); else invitation?.bearer.fill(0); throw error }
  }
  #live = (): boolean => {
    if (this.#closed || this.#forgetting) return false
    const external = this.#options.live(), now = Date.now()
    // Caller getters can synchronously revoke this instance. Check the latch
    // after every external continuation, before any signer or mutation starts.
    return external && !this.#closed && !this.#forgetting && now < this.#options.tab.expiresAt &&
      (this.#effectUntil === undefined || Math.floor(now / 1000) < this.#effectUntil)
  }
  #forgetLive = (): boolean => {
    if (this.#closed) return false
    const external = this.#options.live(), now = Date.now()
    return external && !this.#closed && now < this.#options.tab.expiresAt
  }
  #track<T>(work: Promise<T>): Promise<T> {
    OrdinaryStateOwner.joinPairLifetime(this.#options.browser,this.#options.tab,work)
    this.#work.add(work); void work.finally(() => this.#work.delete(work)).catch(() => {}); return work
  }
  #input<T>(work: (browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody) => T, live = this.#live) {
    return { browser: { owner: this.#options.browser, scope: this.#browserScope }, tab: { owner: this.#options.tab, scope: this.#tabScope },
      live, work: (b: DeviceStore, t: DeviceStore, _bn: readonly string[], _tn: readonly string[], custody: OrdinaryPairCustody) => work(b, t, custody) }
  }
  #read<T>(work: (browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody) => T): Promise<T> {
    return this.#track(OrdinaryStateOwner.readPairMigrated(this.#input(work)))
  }
  #preflight(browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody): void {
    const b = map(browser), t = map(tab)
    try {
      validateOrdinarySnapshot(b, t, { browser: true, tab: true }, captureOrdinarySnapshotContext(b, t, custody))
      if (this.#options.account === null) {
        const raw = browser.get('kithmoot.participant'); if (raw === null) hold()
        const key = hexToBytes(raw)
        try { if (getPublicKey(key) !== this.#participant) hold() } finally { key.fill(0) }
      }
    } finally { b.clear(); t.clear() }
  }
  #deviceCustody(browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody, roomId: string): PersistentDeviceCustody {
    const b = map(browser), t = map(tab)
    try {
      const headers = ordinaryPairCustodyFor(custody, b, t), owner = this.#options.keep ? 'browser' : 'tab', header = headers[owner]
      const scope = { name: 'room:' + roomId, generation: header.generation, fence: header.fences.get('room:' + roomId) ?? 0 }
      return owner === 'browser' ? { owner, scope } : { owner, scope: { ...scope, purpose: this.#options.tab.purpose, expiresAt: header.expiresAt } }
    } finally { b.clear(); t.clear() }
  }
  #sources(browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody, roomId: string): Sources {
    this.#preflight(browser, tab, custody)
    return { ...this.#image(browser, tab, custody), deviceCustody: this.#deviceCustody(browser, tab, custody, roomId) }
  }
  #image(browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody): OpenedImage {
    const records = (store: DeviceStore) => store.keys().sort().map(name => [name, store.get(name)!] as const)
    const b = map(browser), t = map(tab)
    try {
      const headers = ordinaryPairCustodyFor(custody, b, t)
      return { browser: records(browser), tab: records(tab), browserRevision: headers.browser.revision, tabRevision: headers.tab.revision }
    } finally { b.clear(); t.clear() }
  }
  #same(browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody, roomId: string, expected: Sources): void {
    if (JSON.stringify(this.#sources(browser, tab, custody, roomId)) !== JSON.stringify(expected)) hold()
  }
  #lifetime(admission: PersistentRoomAdmission): void {
    const now = Math.floor(Date.now() / 1000), expires = this.#options.credentialExpiresAt
    if (!this.#live() || expires <= now || expires > Math.floor(this.#options.tab.expiresAt / 1000) ||
        admission.endsAt !== undefined && (admission.endsAt <= now || expires > admission.endsAt)) hold()
  }
  #fresh(browser: DeviceStore, tab: DeviceStore, roomId: string, admission: PersistentRoomAdmission): void {
    const ownMetadata = accountPrefix(this.#participant) + ROOM_PREFIX + roomId
    for (const [kind, store] of [['browser', browser], ['tab', tab]] as const) for (const name of store.keys()) {
      const family = classifyOrdinaryPhysicalName(name, kind)?.family, raw = store.get(name)!
      if (family === 'identity' || family === 'epoch' || family === 'bookmarks') {
        if (name.endsWith('.' + roomId)) hold()
      } else if (family === 'invitationProofs') {
        const bound = (JSON.parse(raw) as { binding?: { invitationId: string; roomId: string } }).binding
        // Publication intents have no binding; their paired creator proof was
        // verified by the complete composer and is checked on its own row.
        if (!bound) continue
        if (bound.invitationId === this.#id || bound.roomId === roomId) hold()
      } else if (family === 'access') {
        if (name.includes(ROOM_PREFIX)) {
          const metadata = JSON.parse(raw) as { link: string; keep?: boolean; endedAt?: number; endsAt?: number; destruct?: boolean }
          if (name.endsWith('.' + roomId)) {
            // Rejoining after opt-out tab expiry may retain this exact inert
            // own link. It cannot extend an end or revoke known destruction.
            if (kind !== 'browser' || name !== ownMetadata || this.#options.keep || metadata.keep !== false ||
                metadata.link !== this.#options.link || metadata.endedAt !== undefined ||
                metadata.endsAt !== undefined && (admission.endsAt === undefined || admission.endsAt > metadata.endsAt) ||
                metadata.destruct && !admission.destruct) hold()
          } else {
            const linked = parseRoomLink(metadata.link)
            try { if (linked.invitation && deriveInvitationId(linked.invitation) === this.#id) hold() } finally { wipeLink(linked) }
          }
        } else {
          if (name.endsWith('.' + this.#id)) hold()
          const saved = JSON.parse(raw) as { roomSecret: string }, secret = hexToBytes(saved.roomSecret)
          try { const derived = deriveRoom(secret); try { if (derived.roomId === roomId) hold() } finally { derived.roomKey.fill(0) } }
          finally { secret.fill(0) }
        }
      } else if (family === 'routing') {
        if (name === FIXED_INVITATION_RELAYS && Object.hasOwn(JSON.parse(raw), roomId) || name.endsWith('.' + roomId)) hold()
      } else if (family === 'metadata') {
        if (name.endsWith('.' + roomId) || name === 'kithmoot.pinned-rooms.v1' && (JSON.parse(raw) as string[]).includes(roomId)) hold()
      }
    }
  }
  #writeAdmission(browser: DeviceStore, tab: DeviceStore, roomId: string, admission: PersistentRoomAdmission, now: number): void {
    const b = scoped(browser, this.#participant), t = scoped(tab, this.#participant)
    rememberRoom(b, { roomId, link: this.#options.link, openedAt: now,
      ...(admission.endsAt !== undefined ? { endsAt: admission.endsAt, startsAt: now } : {}), ...(admission.destruct ? { destruct: true } : {}) })
    if (!setKeepRoom(b, roomId, this.#options.keep)) hold()
    storeTabAdmission(t, this.#options.invitation, admission)
    if (this.#options.keep) {
      storeKeptAdmission(b, this.#id, admission, now)
      if (admission.relays !== undefined) {
        new RelayConnections({ getItem: name => browser.get(name), setItem: (name, raw) => browser.set(name, raw) }, [])
          .setRoomRelays(roomId, { fixed: admission.relays, signed: true })
      }
    }
  }
  #capacity(browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody, roomId: string, admission: PersistentRoomAdmission, now: number): void {
    const b = map(browser), t = map(tab), prefix = accountPrefix(this.#participant)
    try {
      this.#writeAdmission(view(b), view(t), roomId, admission, now)
      const device = this.#options.keep ? b : t
      device.set(prefix + DEVICE_PREFIX + roomId, JSON.stringify({ sk: '0'.repeat(64), at: now }))
      device.set(prefix + DEVICE_OWNER + roomId, JSON.stringify({ account: this.#participant, roomId }))
      device.set(prefix + OWN_SEAL_PREFIX + roomId, JSON.stringify(['0'.repeat(64)]))
      // Final credential/proof values are canonical JSON text, bounded below
      // before retention. Such text has no raw C0 control or lone surrogate;
      // embedding it in the native JSON tuple costs at most 2*raw UTF-8 bytes.
      // A quote per budget byte therefore dominates every escaped value. The
      // 4096 credential bound exceeds this exact no-label Fold template, even
      // at maximal safe integer timestamps and fixed id/pubkey/signature sizes.
      device.set(prefix + OWN_CREDENTIAL_PREFIX + roomId, '"'.repeat(CREDENTIAL_BYTES))
      const proofName = prefix + PERSISTENT_PROOF_V2_PREFIX + this.#id + '.' + this.#options.tab.purpose.slice(4)
      const tabName = prefix + PERSISTENT_TAB_PROOF_V2_PREFIX + this.#id
      if (this.#options.keep) b.set(proofName, '"'.repeat(MAX_PERSISTENT_PROOF_BYTES))
      t.set(tabName, '"'.repeat(MAX_PERSISTENT_PROOF_BYTES))
      const originalBrowser = map(browser), originalTab = map(tab)
      try { ordinaryPairProjectedByteLengths(custody, originalBrowser, originalTab, { browser: b, tab: t }, true) }
      finally { originalBrowser.clear(); originalTab.clear() }
    } finally { b.clear(); t.clear() }
  }
  #selected(browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody, requireMetadata = true): { operation: string; roomId: string } | undefined {
    const checked = inspectPersistentAdmissionProofs(browser, tab)
    try {
      const prefix = accountPrefix(this.#participant), selected = checked.selected.get(prefix + PERSISTENT_TAB_PROOF_V2_PREFIX + this.#id)
      if (!selected) {
        if (tab.get(prefix + TAB_ADMISSION_PREFIX + this.#id) !== null || tab.keys().some(name => name.startsWith(prefix + 'kithmoot.admission-proof.') && name.endsWith('.' + this.#id)) ||
            browser.keys().some(name => name.startsWith(prefix + 'kithmoot.invitation-proof.') && name.includes('.' + this.#id + '.'))) hold()
        return undefined
      }
      this.#bound(selected, browser, tab, custody, requireMetadata)
      return { operation: selected.proof.binding.operation, roomId: selected.proof.binding.roomId }
    } finally { checked.close() }
  }
  #bound(verified: VerifiedPersistentProof, browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody, requireMetadata = true): void {
    const proof = verified.proof, bound = proof.binding
    if (proof.version !== 2 || bound.account !== this.#options.account || bound.participant !== this.#participant ||
        bound.invitationId !== this.#id || proof.capability.inviter !== this.#options.invitation.inviter ||
        proof.capability.bearer !== bytesToHex(this.#options.invitation.bearer) || proof.kept.enabled !== this.#options.keep ||
        JSON.stringify(bound.browser) !== JSON.stringify(this.#browserScope) ||
        JSON.stringify(bound.tab) !== JSON.stringify({ ...this.#tabScope, purpose: this.#options.tab.purpose, expiresAt: this.#options.tab.expiresAt }) ||
        JSON.stringify(bound.deviceCustody) !== JSON.stringify(this.#deviceCustody(browser, tab, custody, bound.roomId))) hold()
    if (!requireMetadata) return
    const raw = browser.get(accountPrefix(this.#participant) + ROOM_PREFIX + bound.roomId)
    if (raw === null) hold()
    const metadata = JSON.parse(raw) as { link: string; keep?: boolean; endedAt?: number }
    if (metadata.link !== this.#options.link || metadata.keep !== this.#options.keep || metadata.endedAt !== undefined) hold()
  }
  #credential(raw: string, roomId: string, devicePubkey: string, sealPubkey: string, now?: number): DeviceCredential {
    ordinaryUtf8Length(raw, CREDENTIAL_BYTES)
    const event = JSON.parse(raw) as DeviceCredential
    validateOrdinaryEmbeddedDeviceCredential(event, roomId)
    const tags = [['d', roomId], ['device', devicePubkey], ['expiration', String(this.#options.credentialExpiresAt)], ['seal', sealPubkey]]
    if (event.pubkey !== this.#participant || event.content !== '' || JSON.stringify(event.tags) !== JSON.stringify(tags) ||
        now !== undefined && event.created_at !== now) hold()
    return event
  }
  async #load(operation = this.#ownedOperation): Promise<OrdinaryPersistentBootstrapResult | undefined> {
    let result: OrdinaryPersistentBootstrapResult | undefined
    try {
      const answer = await this.#read((browser, tab, custody) => {
        this.#preflight(browser, tab, custody)
        const selected = this.#selected(browser, tab, custody)
        if (!selected) { if (operation !== undefined) hold(); return undefined }
        if (operation === undefined || selected.operation !== operation) hold()
        const checked = inspectPersistentAdmissionProofs(browser, tab)
        let key: Uint8Array | undefined, seal: Uint8Array | undefined, root: Uint8Array | undefined
        try {
          const verified = checked.selected.get(accountPrefix(this.#participant) + PERSISTENT_TAB_PROOF_V2_PREFIX + this.#id)!
          this.#bound(verified, browser, tab, custody); this.#lifetime(verified.admission)
          const device = this.#options.keep ? browser : tab, prefix = accountPrefix(this.#participant)
          key = hexToBytes((JSON.parse(device.get(prefix + DEVICE_PREFIX + selected.roomId)!) as { sk: string }).sk)
          const raw = device.get(prefix + OWN_CREDENTIAL_PREFIX + selected.roomId), seals = JSON.parse(device.get(prefix + OWN_SEAL_PREFIX + selected.roomId)!) as string[]
          if (raw === null || seals.length !== 1) hold()
          seal = hexToBytes(seals[0]!)
          const credential = this.#credential(raw, selected.roomId, getPublicKey(key), getPublicKey(seal))
          if (!verified.proof.binding.device.credentialIds.includes(credential.id)) hold()
          root = new Uint8Array(verified.admission.secret)
          result = { admission: { ...verified.admission, secret: root, ...(verified.admission.relays ? { relays: [...verified.admission.relays] } : {}) },
            deviceKey: key, sealKey: seal, credential: structuredClone(credential) }
          return result
        } catch (error) { key?.fill(0); seal?.fill(0); root?.fill(0); throw error }
        finally { checked.close() }
      })
      if (!this.#live() || answer && (this.#options.credentialExpiresAt <= Math.floor(Date.now() / 1000) ||
          answer.admission.endsAt !== undefined && answer.admission.endsAt <= Math.floor(Date.now() / 1000))) hold()
      return answer
    } catch (error) { wipeOrdinaryPersistentBootstrapResult(result); throw error }
  }
  load(): Promise<OrdinaryPersistentBootstrapResult | undefined> { return this.#track(this.#load()) }
  /** Execution for an actual member session over this exact retained proof.
   * The root supplies synchronous revocation of its owned session/carrier.
   * This first-credential lease does not implement renewal or creator custody. */
  async #borrowProtocolExecution(revoke: () => void, sessionLive: () => boolean): Promise<OrdinaryMemberProtocolExecution> {
    if (typeof revoke !== 'function' || Object.getPrototypeOf(revoke) === Object.getPrototypeOf(async () => {})) hold()
    const owner = this, work = new Set<Promise<unknown>>()
    let closed = false, expected: OpenedImage | undefined, leaseTimer: ReturnType<typeof setTimeout> | undefined
    let active: { b: DeviceStore; t: DeviceStore; c: OrdinaryPairCustody } | undefined, release: (() => void) | undefined
    const live = () => {
      if (closed || !owner.#live()) return false
      const selected = sessionLive()
      return selected === true && !closed && owner.#live() && Math.floor(Date.now() / 1000) < owner.#options.credentialExpiresAt
    }
    const retain = <T>(pending: Promise<T>): Promise<T> => {
      if (!(pending instanceof Promise)) hold()
      OrdinaryStateOwner.joinPairLifetime(owner.#options.browser, owner.#options.tab, pending)
      work.add(pending); void pending.finally(() => work.delete(pending)).catch(() => {}); return pending
    }
    const binding = { browser: { owner: this.#options.browser, scope: this.#browserScope },
      tab: { owner: this.#options.tab, scope: this.#tabScope }, live }
    const validate = (b: DeviceStore, t: DeviceStore, c: OrdinaryPairCustody) => {
      try {
        OrdinaryStateOwner.validatePairBinding(c, binding)
        owner.#preflight(b, t, c)
        const selected = owner.#selected(b, t, c)
        if (!selected || owner.#ownedOperation === undefined || selected.operation !== owner.#ownedOperation ||
            expected === undefined || JSON.stringify(owner.#image(b, t, c)) !== JSON.stringify(expected)) hold()
        OrdinaryStateOwner.validatePairBinding(c, binding)
        active = { b, t, c }
      } catch (error) { protocol.close(); throw error }
    }
    const protocol: OrdinaryMemberProtocolExecution = {
      validate,
      check: () => { if (!active || !live()) hold(); validate(active.b, active.t, active.c) },
      retain,
      run: <T>(operation: string, effect: () => T): Promise<T> => {
        // A renewed own seal/credential needs the missing atomic retention
        // producer and capacity reservation before its first entropy.
        if (operation === 'credential-preparation') return Promise.reject(new OrdinaryStateHold())
        let applicationRefusal: { error: unknown } | undefined
        return retain(OrdinaryStateOwner.readPairMigrated({ ...binding,
          work: (b, t, _bn, _tn, c) => {
            validate(b, t, c)
            let result: T
            try { result = effect() } catch (error) {
              // An application refusal (for example a prepared send whose
              // epoch moved) does not revoke an otherwise current owner.
              // Still repeat custody before releasing that refusal.
              validate(b, t, c)
              if (!(error instanceof OrdinaryStateHold)) applicationRefusal = { error }
              throw error
            }
            // The native owner rejects thenables; provider promises go in a
            // captured container and are retained/awaited outside this read.
            validate(b, t, c)
            return result
          },
        }).catch(error => { if (!applicationRefusal || applicationRefusal.error !== error) protocol.close(); throw error }))
      },
      close: () => {
        if (closed) return
        closed = true; active = undefined; expected = undefined; clearTimeout(leaseTimer); release?.(); release = undefined
        try { revoke() } catch { /* retained work still belongs to both owners */ }
      },
      joinLifetime: async () => { while (work.size) await Promise.allSettled([...work]) },
    }
    try {
      const material = await this.#load()
      try { if (!material) hold() } finally { wipeOrdinaryPersistentBootstrapResult(material) }
      await this.#read((b, t, c) => {
        expected = owner.#image(b, t, c); validate(b, t, c)
        release = OrdinaryStateOwner.retainPairResource(c, binding, { revoke: protocol.close, join: protocol.joinLifetime })
      })
      const expire = () => {
        if (closed) return
        const remaining = owner.#options.credentialExpiresAt * 1000 - Date.now()
        if (remaining <= 0) {
          protocol.close()
          OrdinaryStateOwner.joinPairLifetime(owner.#options.browser, owner.#options.tab, protocol.joinLifetime())
        }
        else leaseTimer = setTimeout(expire, Math.min(2_147_483_647, remaining))
      }
      expire()
      this.#protocols.add(protocol)
      return Object.freeze(protocol)
    } catch (error) { protocol.close(); await protocol.joinLifetime(); throw error }
  }
  /** Create the genuine library session from acknowledged member material.
   * The executor, buffers, raw session and exact carrier stay private. This
   * initial member lease does not yet activate renewal, media or creator roles. */
  openMemberSession(input: OrdinaryMemberSessionOptions): Promise<OrdinaryOwnedMemberSession> {
    if (this.#sessionStarting || this.#protocols.size || this.#closed || this.#forgetting) hold()
    this.#sessionStarting = true
    let carrier: OrdinaryRelayCarrier | undefined, session: RoomSession | undefined, material: OrdinaryPersistentBootstrapResult | undefined
    let protocol: OrdinaryMemberProtocolExecution | undefined, closed = false, closing: Promise<void> | undefined
    const stop = () => {
      closed = true
      try { carrier?.close() } catch { /* other owned components still stop */ }
      try {
        if (session && protocol) {
          const leaving = session.leave(); protocol.retain(leaving); void leaving.catch(() => {})
        }
      } catch { /* the closed protocol cannot permit further effects */ }
    }
    const close = (): Promise<void> => {
      if (closing) return closing
      if (protocol) protocol.close(); else stop()
      // The owned revoke callback may have entered close synchronously.
      if (closing) return closing
      closing = (async () => {
        await protocol?.joinLifetime(); await carrier?.joinLifetime()
        try { session?.disposeProtocolSecrets() }
        finally {
          wipeOrdinaryPersistentBootstrapResult(material); material = undefined
          if (protocol) this.#protocols.delete(protocol)
        }
      })()
      this.#sessionCleanup.add(closing)
      void closing.finally(() => this.#sessionCleanup.delete(closing!)).catch(() => {})
      this.#track(closing)
      return closing
    }
    const field = <T>(name: string): T => {
      const descriptor = Object.getOwnPropertyDescriptor(input, name)
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) hold()
      return descriptor.value as T
    }
    const optional = <T>(name: string): T | undefined => Object.hasOwn(input, name) ? field<T>(name) : undefined
    const start = async (): Promise<OrdinaryOwnedMemberSession> => {
      try {
        if (!this.#live()) hold()
        const live = field<() => boolean>('live'), name = optional<string>('name'), timeout = optional<number>('epochRequestTimeoutMs')
        if (typeof live !== 'function' || name !== undefined && typeof name !== 'string' || timeout !== undefined &&
            (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 90_000)) hold()
        const relays = captureProtocolData(field<MemberCarrierOptions['relays']>('relays'))
        const profile = field<MemberCarrierOptions['profile']>('profile'), websocketImplementation = field<typeof WebSocket>('websocketImplementation')
        if (profile !== 'direct' && profile !== 'tor') hold()
        const selectedRelays = normaliseRelayConfig(relays, profile)
        // A URL or signed destination list does not prove circle ownership.
        // This source has no verified box-status/keeper mark to attach a lane.
        if (selectedRelays.some(relay => relay.circle)) hold()
        // Snapshot consent before the first wait; keep the exact native
        // signer instance so its private provenance and binding survive.
        const grants = optional<MemberCarrierOptions['authentication']>('authentication')
        let authentication: MemberCarrierOptions['authentication']
        if (grants !== undefined) {
          if (!Array.isArray(grants)) hold()
          const length = Object.getOwnPropertyDescriptor(grants, 'length')?.value
          if (!integer(length) || length > MAX_POOL_RELAYS) hold()
          authentication = Object.freeze(Array.from({ length }, (_, index) => {
            const entry = Object.getOwnPropertyDescriptor(grants, String(index))
            if (!entry || !Object.hasOwn(entry, 'value') || typeof entry.value !== 'object' || entry.value === null) hold()
            const url = Object.getOwnPropertyDescriptor(entry.value, 'url'), identity = Object.getOwnPropertyDescriptor(entry.value, 'identity')
            if (!url || !identity || !Object.hasOwn(url, 'value') || !Object.hasOwn(identity, 'value') || typeof url.value !== 'string') hold()
            return Object.freeze({ url: url.value, identity: identity.value })
          }))
        }
        const linked = parseRoomLink(this.#options.link)
        let policy: RoomLink['policy']
        try {
          policy = linked.policy
          // Other policies need their actual admission proofs/carriers. The
          // first-credential member lease supports only the default open rule.
          if (policy && (policy.tier !== 'open' || Object.keys(policy).some(key => key !== 'tier'))) hold()
        } finally { wipeLink(linked) }
        protocol = await this.#borrowProtocolExecution(() => {
          stop()
          // Register owned cleanup synchronously so the bootstrap's own
          // close/forget also joins carrier providers and secret erasure.
          void close().catch(() => {})
        }, () => !closed && carrier?.closed !== true && live())
        material = await this.#load(); if (!material) hold()
        // #load verifies the exact retained credential, device and own seal
        // in native custody. Refuse a lease RoomSession would try to renew
        // before the relay carrier can construct its first socket.
        if (this.#options.credentialExpiresAt - Math.floor(Date.now() / 1000) < RESUME_MIN_REMAINING_SECONDS) hold()
        if (material.admission.relays !== undefined) {
          const destinations = (entries: MemberCarrierOptions['relays']) => JSON.stringify(normaliseRelayConfig(entries, profile)
            .map(({ url, read, write }) => [url, read, write]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
          if (destinations(relays) !== destinations(material.admission.relays)) hold()
        }
        let starting = true
        carrier = await OrdinaryRelayCarrier.open({ browser: this.#options.browser, tab: this.#options.tab, scope: this.#browserScope.name,
          relays, profile, websocketImplementation, account: this.#options.account, participant: this.#participant, authentication,
          live: () => !closed && this.#live() && live(),
          validate: (b, t, c) => {
            protocol!.validate(b, t, c)
            // Recheck on the actual pool/socket construction read, including
            // waits in carrier.open. Later work uses the original lease end.
            if (starting && this.#options.credentialExpiresAt - Math.floor(Date.now() / 1000) < RESUME_MIN_REMAINING_SECONDS) hold()
          }, onClose: () => protocol!.close() })
        const identity: ParticipantIdentity = { pubkey: this.#participant,
          // Renewal needs its own capacity/CAS/credential retention owner.
          // The initial session cannot mint a replacement without that ACK.
          signEvent: () => Promise.reject(new OrdinaryStateHold()),
        }
        session = await protocol.run('session-construction', () => new RoomSession({ transport: carrier!, protocol: protocol!,
          secret: material!.admission.secret, deviceSk: material!.deviceKey, identity, resume: material!.credential, sealKeys: [material!.sealKey],
          retainCredential: () => Promise.reject(new OrdinaryStateHold()), authority: this.#options.invitation.inviter,
          memberEpochDesk: false, epochCatchUp: false,
          onClosed: () => protocol!.close(), onRemoved: () => protocol!.close(), onEpochConflict: () => protocol!.close(),
          requireFreshEpoch: true, expectedEpoch: 0, endsAt: material!.admission.endsAt, policy, name, epochRequestTimeoutMs: timeout,
          timing: { credentialTtlSeconds: this.#options.credentialExpiresAt - material!.credential.created_at },
        }))
        const perform = async <T>(operation: string, effect: () => Promise<T>): Promise<T> => {
          const started = await protocol!.run(operation, () => {
            if (closed) hold()
            const pending = effect(); protocol!.retain(pending); void pending.catch(() => {}); return { pending }
          })
          let result: T
          try { result = await started.pending } catch (error) {
            if (operation === 'session-join') protocol!.close()
            if (closed) hold(); throw error
          }
          return protocol!.run(operation + '-handoff', () => { if (closed) hold(); return result })
        }
        const conversation = (channel?: string): OrdinaryMemberConversation => {
          const log = () => channel === undefined ? session!.chat : session!.channel(channel)
          return Object.freeze({
            send: (text: string, options: SendOptions = {}) => { if (typeof text !== 'string') hold(); const captured = captureProtocolData(options); return perform('chat-send', () => log().send(text, captured)) },
            prepare: async (text: string, options: SendOptions = {}) => {
              if (typeof text !== 'string') hold()
              const captured = captureProtocolData(options), prepared = await protocol!.run('chat-preparation', () => log().prepare(text, captured))
              return Object.freeze({ publish: () => perform('chat-retry', prepared.publish) })
            },
            messages: () => protocol!.run('chat-disclosure', () => structuredClone(log().messages())),
          })
        }
        const chat = conversation()
        return Object.freeze({ ...chat, roomId: session.roomId, participant: session.participant, device: session.device,
          join: async () => { await perform('session-join', () => session!.join([], {})); starting = false },
          channel: async (name: string) => { if (typeof name !== 'string') hold(); await protocol!.run('channel-construction', () => session!.channel(name)); return conversation(name) },
          publishDescriptor: (config: Parameters<RoomSession['publishDescriptor']>[0]) => {
            const captured = captureProtocolData(config); return perform('descriptor-publication', () => session!.publishDescriptor(captured))
          }, close,
        })
      } catch (error) { await close(); throw error }
      finally { this.#sessionStarting = false }
    }
    return this.#track(start())
  }
  /** Dedicated, explicitly selected relay query. Native custody guards the
   * actual constructor, raw REQ/AUTH sends and bounded incoming observations.
   * The result remains historical evidence; bootstrap independently verifies
   * it again before any device entropy or participant credential signing. */
  queryEvidence(input: OrdinaryInvitationQueryOptions): Promise<PersistentInvitationEvidenceResult['evidence']> {
    if (this.#closed || this.#starting || this.#attempted || this.#forgetting || this.#queryStarting || this.#queryAbort) hold()
    this.#queryStarting = true
    const abort = new AbortController(); this.#queryAbort = abort
    try {
      if (!this.#live()) hold()
      const validate = (browser: DeviceStore, tab: DeviceStore, custody: OrdinaryPairCustody) => {
        OrdinaryStateOwner.validatePairBinding(custody,this.#input(()=>{}))
        this.#preflight(browser, tab, custody)
        if (this.#options.credentialExpiresAt <= Math.floor(Date.now() / 1000) ||
            this.#options.credentialExpiresAt > Math.floor(this.#options.tab.expiresAt / 1000)) hold()
        if (!this.#openedImage || JSON.stringify(this.#image(browser, tab, custody)) !== JSON.stringify(this.#openedImage) ||
            this.#selected(browser, tab, custody)?.operation !== this.#ownedOperation || !this.#live()) hold()
      }
      const guard = <T>(effect: (b:DeviceStore,t:DeviceStore,c:OrdinaryPairCustody) => T) => this.#read((browser, tab, custody) => {validate(browser,tab,custody);return effect(browser,tab,custody)})
      const operation = queryInvitationOnProtectedCarrier(this.#options.invitation, input, guard, validate,
        {account:this.#options.account,identity:this.#options.identity},this.#live, abort.signal)
        .finally(() => { if (this.#queryAbort === abort) this.#queryAbort = undefined })
      return this.#track(operation)
    } catch (error) { abort.abort(); this.#queryAbort = undefined; throw error }
    finally { this.#queryStarting = false }
  }
  /** One invocation per instance. Retry an unknown native acknowledgement with
   * retryRetention(); it joins this same candidate and never regenerates or
   * re-signs. A failed attempt needs explicit reopen, which rechecks custody. */
  bootstrap(evidence: unknown): Promise<OrdinaryPersistentBootstrapResult> {
    if (this.#closed || this.#starting || this.#attempted || this.#forgetting || this.#ownedOperation !== undefined || this.#queryStarting || this.#queryAbort) hold()
    this.#starting = true; this.#attempted = true
    try {
      if (!this.#live()) hold()
      const checked = revalidatePersistentInvitationEvidence({ evidence, invitation: this.#options.invitation })
      if (checked.outcome.status !== 'admitted') hold()
      const admission = checked.outcome.admission
      this.#effectUntil = Math.min(this.#options.credentialExpiresAt, admission.endsAt ?? Number.MAX_SAFE_INTEGER)
      let work: Promise<OrdinaryPersistentBootstrapResult>
      try { this.#lifetime(admission); work = this.#bootstrap(JSON.stringify(checked.evidence), admission, Math.floor(Date.now() / 1000)) }
      catch (error) { admission.secret.fill(0); throw error }
      return this.#track(work)
    } finally { this.#starting = false }
  }
  async #bootstrap(evidence: string, admission: PersistentRoomAdmission, now: number): Promise<OrdinaryPersistentBootstrapResult> {
    let deviceKey: Uint8Array | undefined, sealKey: Uint8Array | undefined, pending: Promise<DeviceCredential> | undefined
    const provisional = new Map<string, string>()
    try {
      const room = deriveRoom(admission.secret), roomId = room.roomId; room.roomKey.fill(0)
      const sources = await this.#read((browser, tab, custody) => {
        const captured = this.#sources(browser, tab, custody, roomId)
        if (!this.#openedImage || JSON.stringify(this.#image(browser, tab, custody)) !== JSON.stringify(this.#openedImage)) hold()
        this.#lifetime(admission); this.#fresh(browser, tab, roomId, admission); this.#capacity(browser, tab, custody, roomId, admission, now)
        const logical = DEVICE_PREFIX + roomId
        // A single-room view prevents deviceKeyFor's pruning from observing
        // any other room, including other retained tab identities.
        const narrowed: DeviceStore = { get: name => { if (name !== logical) hold(); return provisional.get(name) ?? null },
          set: (name, raw) => { if (name !== logical) hold(); provisional.set(name, raw) }, remove: hold,
          keys: () => provisional.has(logical) ? [logical] : [] }
        deviceKeyFor(narrowed, roomId, now, () => { deviceKey = generateSecretKey(); return deviceKey })
        const generatedSeal = generateSealKey(); sealKey = generatedSeal.secretKey
        if (!deviceKey || provisional.get(logical) !== JSON.stringify({ sk: bytesToHex(deviceKey), at: now }) || generatedSeal.pubkey !== getPublicKey(sealKey)) hold()
        return captured
      })
      await this.#read((browser, tab, custody) => {
        this.#same(browser, tab, custody, roomId, sources); this.#fresh(browser, tab, roomId, admission); this.#lifetime(admission)
        if (!deviceKey || !sealKey) hold()
        // createDeviceCredential invokes this sign method synchronously before
        // its first await. Preserve the provider's actual `this` binding.
        const sign=this.#options.account!==null&&OrdinaryForegroundSigner.isNativeSigner(this.#options.identity)?OrdinaryForegroundSigner.borrowNativeSignEvent(this.#options.identity,{live:this.#live,
          validate:(b,t,c)=>{OrdinaryStateOwner.validatePairBinding(c,this.#input(()=>{}));
            this.#same(b,t,c,roomId,sources);this.#fresh(b,t,roomId,admission);this.#lifetime(admission)}}):undefined
        const identity: ParticipantIdentity = { pubkey: this.#participant,
          signEvent: unsigned => sign?sign.call(this.#options.identity, unsigned):
            Promise.resolve(signOrdinaryVisitorCredential(browser,tab,custody,{account:this.#options.account,participant:this.#participant,roomId,
              devicePubkey:getPublicKey(deviceKey!),seal:getPublicKey(sealKey!),expiresAt:this.#options.credentialExpiresAt,createdAt:now},unsigned)) }
        pending = createDeviceCredential({ identity, roomId, devicePubkey: getPublicKey(deviceKey), seal: getPublicKey(sealKey),
          expiresAt: this.#options.credentialExpiresAt, now: () => now })
        void pending.catch(() => {})
      })
      if (!pending) hold()
      const signed = await pending
      this.#lifetime(admission)
      const rawCredential = JSON.stringify(signed), credential = this.#credential(rawCredential, roomId, getPublicKey(deviceKey!), getPublicKey(sealKey!), now)
      await OrdinaryStateOwner.retainPairScopesMigrated(this.#input((browser, tab, custody) => {
        this.#same(browser, tab, custody, roomId, sources); this.#fresh(browser, tab, roomId, admission); this.#lifetime(admission)
        const device = this.#options.keep ? browser : tab, prefix = accountPrefix(this.#participant)
        device.set(prefix + DEVICE_OWNER + roomId, JSON.stringify({ account: this.#participant, roomId }))
        device.set(prefix + DEVICE_PREFIX + roomId, provisional.get(DEVICE_PREFIX + roomId)!)
        storeOwnCredentialFor(scoped(device, this.#participant), roomId, credential, sealKey!)
        this.#writeAdmission(browser, tab, roomId, admission, now)
        const verified = makePersistentAdmissionProof({ invitation: this.#options.invitation, evidence: JSON.parse(evidence),
          account: this.#options.account, participant: this.#participant, browser: this.#browserScope,
          tab: { ...this.#tabScope, purpose: this.#options.tab.purpose, expiresAt: this.#options.tab.expiresAt },
          deviceCustody: sources.deviceCustody, device: persistentAdmissionDeviceInPair(browser, tab, roomId, this.#participant, this.#options.account,
            this.#options.keep ? 'browser' : 'tab'), keep: this.#options.keep, now, expectedRoomSecret: admission.secret })
        try {
          const rawProof = JSON.stringify(verified.proof), rawTab = tabProofBytes(verified.proof)
          ordinaryUtf8Length(rawProof, MAX_PERSISTENT_PROOF_BYTES); ordinaryUtf8Length(rawTab, MAX_PERSISTENT_PROOF_BYTES)
          if (this.#options.keep) browser.set(persistentProofName(verified.proof.binding), rawProof)
          tab.set(persistentTabProofName(verified.proof.binding), rawTab)
          this.#preflight(browser, tab, custody); this.#lifetime(admission)
          this.#candidateOperation = verified.proof.binding.operation
        } finally { verified.admission.secret.fill(0) }
      }))
      if (!this.#candidateOperation) hold()
      this.#ownedOperation = this.#candidateOperation
      this.#lifetime(admission)
      const result = await this.#load(this.#ownedOperation)
      if (!result) hold()
      return result
    } finally {
      deviceKey?.fill(0); sealKey?.fill(0); admission.secret.fill(0); provisional.clear(); this.#openedImage = undefined
      // Even if the fresh read revoked after signer invocation, close joins
      // this exact unabortable promise outside the origin lock. No late result
      // can reach retention; owned private buffers have already been erased.
      if (pending) await pending.catch(() => {})
    }
  }
  /** Delete this actor/invitation's V2 custody in one native pair and advance
   * both invitation fences, even if retention has not yet created records.
   * Other actors, historical invitations and unrelated room keys are retained. */
  forget(): Promise<void> {
    if (this.#closed || this.#forgetting) hold()
    this.#forgetting = true
    for (const protocol of this.#protocols) protocol.close()
    this.#queryAbort?.abort()
    return this.#track(OrdinaryStateOwner.forgetPairMigrated(this.#input((browser, tab, custody) => {
      this.#preflight(browser, tab, custody)
      const selected = this.#selected(browser, tab, custody, false), roomId = selected?.roomId
      if (selected && (this.#ownedOperation === undefined || selected.operation !== this.#ownedOperation)) hold()
      // Failed or definitely aborted first-use work owns no selected operation.
      // It may revoke its actor-scoped invitation fences, but deletes no rows.
      if (!selected) return
      const prefix = accountPrefix(this.#participant), proofPrefix = prefix + PERSISTENT_PROOF_V2_PREFIX + this.#id + '.'
      for (const name of browser.keys()) if (name.startsWith(proofPrefix)) browser.remove(name)
      browser.remove(prefix + KEPT_ADMISSION_PREFIX + this.#id)
      tab.remove(prefix + PERSISTENT_TAB_PROOF_V2_PREFIX + this.#id); tab.remove(prefix + TAB_ADMISSION_PREFIX + this.#id)
      if (roomId !== undefined) {
        const members = inspectPersistentAdmissionProofs(browser, tab), creators = inspectPersistentCreatorProofs(browser)
        try {
          const remaining = [...members.proofs.values(), ...members.selected.values()]
          const sameActor = remaining.some(value => value.proof.binding.participant === this.#participant && value.proof.binding.roomId === roomId) ||
            [...creators.proofs.values()].some(value => value.proof.binding.participant === this.#participant && value.proof.binding.roomId === roomId)
          if (!sameActor) {
            const device = this.#options.keep ? browser : tab
            for (const name of [DEVICE_PREFIX, DEVICE_OWNER, OWN_CREDENTIAL_PREFIX, OWN_SEAL_PREFIX]) device.remove(prefix + name + roomId)
            // Only this actor's exact selected link/choice is ours to remove.
            const name = prefix + ROOM_PREFIX + roomId, raw = browser.get(name)
            if (raw !== null) {
              const metadata = JSON.parse(raw) as { link: string; keep?: boolean }
              if (metadata.link === this.#options.link && metadata.keep === this.#options.keep) browser.remove(name)
            }
          }
          const rawFixed = browser.get(FIXED_INVITATION_RELAYS)
          if (rawFixed !== null) {
            const fixed = JSON.parse(rawFixed) as Record<string, { c: string[]; signed: boolean }>, row = fixed[roomId]
            if (row && !remaining.some(value => value.proof.binding.roomId === roomId && value.proof.selection.relays !== null &&
                JSON.stringify(value.proof.selection.relays) === JSON.stringify(row.c)) &&
                ![...creators.proofs.values()].some(value => value.proof.binding.roomId === roomId &&
                  creatorIsSelected(browser, value.proof) && JSON.stringify(value.admission.relays) === JSON.stringify(row.c))) {
              delete fixed[roomId]; browser.set(FIXED_INVITATION_RELAYS, JSON.stringify(fixed))
            }
          }
        } finally { members.close(); creators.close() }
      }
      this.#preflight(browser, tab, custody)
    }, this.#forgetLive)).then(async () => {
      if (this.#protocols.size) await Promise.all([...this.#protocols].map(protocol => protocol.joinLifetime()))
      await Promise.all([...this.#sessionCleanup])
      this.#protocols.clear(); this.#closed = true; this.#openedImage = undefined; this.#options.invitation.bearer.fill(0)
    })
      .catch(error => { this.#forgetting = false; throw error }))
  }
  retryRetention(): void { this.#options.browser.retryRetention(); this.#options.tab.retryRetention() }
  /** Revocation is synchronous; native uncertainty and an unabortable signer
   * must finish before close returns. Late results are refused and keys wiped. */
  /** A signer callback may revoke synchronously and then return/reject. Never
   * await close() from the provider promise close itself is joining. */
  revoke(): void {
    this.#closed = true; this.#queryAbort?.abort()
    for (const protocol of this.#protocols) protocol.close()
  }
  async close(): Promise<void> {
    this.revoke(); while (this.#work.size) await Promise.allSettled([...this.#work])
    await Promise.all([...this.#protocols].map(protocol => protocol.joinLifetime())); this.#protocols.clear()
    this.#openedImage = undefined; this.#options.invitation.bearer.fill(0)
  }
}
