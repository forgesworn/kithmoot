import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { Capability, Session, VmlsSignRequest, VmlsEcdhRequest, VmlsSnapshot, VmlsRemoval, VmlsGrantRef, VmlsGrant,
  VmlsMlsState, VmlsCredentialState, VmlsGrantState, VmlsClaim, VmlsNextRemoval } from '../public/vmls-wasm/vmls_wasm.js'
import type { RendezvousReceipt, RendezvousVault } from './rendezvous-vault.js'
import { withMlsRendezvous } from './mls-rendezvous-custody.js'
import { loadMlsEngine } from './mls-engine.js'
import { CoordinatedMlsVault } from './mls-coordinated-vault.js'
import { base64Encode, type ConsentPrompt, type SignLeafBindingRequest, type SignLeafBindingReply, type VaultContext, type VaultResult } from './mls-vault.js'
import { BrowserPersonaCoordinator, InvalidPersonaRecord, type PersonaReader } from './mls-persona-coordinator.js'
import { BrowserMlsSessionHost, StaleMlsOperation, type HostedMlsResult, type HostedMlsStep, type MlsSessionContext, type MlsSessionEdits } from './mls-session-host.js'
import { appendMlsHistory, rememberMlsOrdering, createMlsRoom, readMlsRoom, saveMlsRoom, mlsHistory, mlsRoomIds, MlsRoomRefused, type MlsPackageRoute, type MlsRoomRecord } from './mls-room-store.js'
import { MAX_MLS_REMOVALS, readMlsMembership, removalBytes, saveMlsMembership, type MlsRemovalRecord } from './mls-membership-store.js'
import { MlsRevocationOutboxFull, rememberStandaloneRevocations } from './mls-revocation-outbox.js'
import { BrowserMlsBoxClient, type BoxAnswer } from './mls-box-client.js'
import { vmlsMemberGrantReference } from '../../src/vmls-revocation-request.js'

export interface MlsRoomContext { vault: VaultContext; rendezvousKey: string; current(): boolean }
export interface MlsJoinOptions {
  /** Account authenticated as the keeper by the accepted invitation answer. */
  operation: string; name: string; homeBox: string; introductionBox: string; adderRz: string; keeper: string; counter: bigint; expiresAt: number
  rendezvous: RendezvousReceipt
}
export type MlsRoomResult<T> = HostedMlsResult<T> | { state: 'refused'; reason: string }
export type MlsAddResult = MlsRoomResult<MlsRoomEffect> | { state: 'transport'; answer: Exclude<BoxAnswer<{ fresh: boolean }>, { state: 'ok' }> }
interface EngineStep { snapshot: VmlsSnapshot | null; events: any[]; outbound: any[] }
export interface MlsRoomEffect { events: any[]; outbound: any[]; ack?: any; outcome?: any; session: string; generation: string }
export interface MlsRemovalStatus {
  operation: string; session: string; kind: 'device' | 'person'; target: string; compromised: boolean; createdAt: number
  leaves: string[]
  attempts: number; failure: string | null; mls: VmlsMlsState; credential: VmlsCredentialState; grants: VmlsGrant[]
  claim: VmlsClaim; claimCopy: string | undefined; next: VmlsNextRemoval
  request?: { keeper: string; device: string; sessions: string[]; boxes: string[] }
}
export interface MlsRemovalEffect extends MlsRoomEffect { membership: MlsRemovalStatus }
export interface MlsMemberStatus {
  leafId: string
  identity: string
  device: string
  homeBox: string
  bindingExpiresAt: number
  own: boolean
  pending: boolean
}
const hex = (v: string) => /^[0-9a-f]{64}(?![\s\S])/.test(v)
const exactKeys = (value: object, keys: string) => Object.keys(value).sort().join(',') === keys
const validRequest = (value: unknown): value is NonNullable<MlsRemovalRecord['request']> => {
  if (!value || typeof value !== 'object' || !exactKeys(value, 'boxes,device,keeper,sessions')) return false
  const request = value as NonNullable<MlsRemovalRecord['request']>
  return hex(request.keeper) && hex(request.device) && Array.isArray(request.sessions) && request.sessions.length >= 1 && request.sessions.length <= 64 &&
    request.sessions.every(hex) && new Set(request.sessions).size === request.sessions.length &&
    Array.isArray(request.boxes) && request.boxes.length >= 1 && request.boxes.length <= 64 && request.boxes.every(hex) &&
    new Set(request.boxes).size === request.boxes.length
}
const validGrantState = (value: unknown): value is VmlsGrantState => {
  if (!value || typeof value !== 'object' || typeof (value as VmlsGrantState).type !== 'string') return false
  const state = value as VmlsGrantState
  return state.type === 'NotAuthorised'
    ? exactKeys(state, 'requested,type') && typeof state.requested === 'boolean'
    : ['Pending', 'Revoked', 'Failed'].includes(state.type) && exactKeys(state, 'type')
}
const checked = <T>(r: VaultResult<T>): T => { if (!r.ok) throw new MlsRoomRefused(r.refusal); return r.value }
const request = (r: VmlsSignRequest): SignLeafBindingRequest => ({ v: 1, operation: bytesToHex(r.operation), body: base64Encode(r.body), digest: bytesToHex(r.digest), expires_at: Number(r.expiresAt) })
const effect = (s: Session, step: EngineStep, extra = {}): HostedMlsStep<MlsRoomEffect> => ({ snapshot: step.snapshot, value: { session: bytesToHex(s.id()), generation: String(s.generation()), events: step.events, outbound: step.outbound, ...extra } })
const grantKey = (grant: VmlsGrantRef) => ({ node: bytesToHex(grant.node), grant: bytesToHex(grant.grant), keeper: grant.keeper })
const removalStatus = (record: MlsRemovalRecord, removal: VmlsRemoval, session: Session): MlsRemovalStatus => ({
  operation: record.operation, session: record.session, kind: record.kind, target: record.target, compromised: record.compromised,
  leaves: removal.leafIds().map(bytesToHex).sort(),
  createdAt: record.createdAt, attempts: record.attempts, failure: record.failure, mls: removal.mls(), credential: removal.credential(),
  grants: removal.grants(), claim: removal.claim(), claimCopy: removal.claimCopy(), next: removal.next(session),
  ...(record.request ? { request: structuredClone(record.request) } : {}),
})
const memberStatuses = (session: Session): MlsMemberStatus[] => (session.members() as any[]).map(info => ({
  leafId: bytesToHex(info.member.leafId), identity: bytesToHex(info.member.identity), device: bytesToHex(info.member.device),
  homeBox: bytesToHex(info.homeBox), bindingExpiresAt: Number(info.bindingExpiresAt), own: info.own, pending: info.pending,
}))
const removalEffectValue = (session: Session, removal: VmlsRemoval, record: MlsRemovalRecord): MlsRemovalEffect => ({
  session: bytesToHex(session.id()), generation: String(session.generation()), events: [], outbound: [], membership: removalStatus(record, removal, session),
})
const removalEffect = (session: Session, step: EngineStep, membership: MlsRemovalStatus): HostedMlsStep<MlsRemovalEffect> => ({
  snapshot: step.snapshot, value: { session: bytesToHex(session.id()), generation: String(session.generation()), events: step.events, outbound: step.outbound, membership },
})
function decodeRemoval(wasm: Awaited<ReturnType<typeof loadMlsEngine>>, record: MlsRemovalRecord,
  authority: { keeper?: string; persona: string }): VmlsRemoval {
  const bytes = removalBytes(record)
  let removal: VmlsRemoval | undefined
  try {
    removal = wasm.removalDecode(bytes)
    const person = removal.personIdentity(), leaves = removal.leafIds().map(bytesToHex)
    if (bytesToHex(removal.sessionId()) !== record.session ||
        (record.kind === 'device' && (person !== undefined || leaves.length !== 1 || leaves[0] !== record.target)) ||
        (record.kind === 'person' && (person === undefined || bytesToHex(person) !== record.target))) {
      throw new InvalidPersonaRecord('Membership journal binding differs')
    }
    if (record.request) {
      const expected = record.request.boxes.map(node => ({ node, grant: vmlsMemberGrantReference(node, record.request!.device), keeper: false }))
      const actual = removal.grants().map(item => grantKey(item.grant))
      if (!authority.keeper || record.request.keeper !== authority.keeper || record.request.keeper === authority.persona ||
          JSON.stringify(record.request.sessions) !== JSON.stringify([record.session]) || JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new InvalidPersonaRecord('Membership revocation request binding differs')
      }
    } else if (removal.grants().some(item => !item.grant.keeper)) {
      throw new InvalidPersonaRecord('Unbound member revocation grant')
    }
    return removal
  } catch (error) {
    try { removal?.free() } catch { /* preserve the record failure */ }
    if (error instanceof InvalidPersonaRecord) throw error
    throw new InvalidPersonaRecord('Membership journal cannot be decoded')
  } finally { bytes.fill(0) }
}
const DEFERRED_REMOVAL = new Set(['CommitInFlight', 'UpdateRequired', 'AwaitingCommitAck', 'OutboxFull', 'Callback'])
/** A successful authenticated box request permits 120 seconds of clock skew.
 * Wait beyond that entire window before treating a saved package route as
 * impossible to use at the box. */
export const MLS_PACKAGE_EXPIRY_SKEW_SECONDS = 120
function freeCapabilities(capabilities: Capability[]): void {
  let failure: unknown
  for (const capability of capabilities) try { capability.free() } catch (error) { failure ??= error }
  if (failure) throw failure
}
class PackageRegistrationStopped extends Error {
  constructor(readonly answer: Exclude<BoxAnswer<{ fresh: boolean }>, { state: 'ok' }>) { super('MLS package registration stopped') }
}
async function assertMembershipMutationAllowed(tx: PersonaReader, wasm: Awaited<ReturnType<typeof loadMlsEngine>>, session: string,
  room: MlsRoomRecord, persona: string, active: Session): Promise<void> {
  const journal = await readMlsMembership(tx)
  // The operator's witnessed approval closes the interval before the exact
  // Remove journal is recorded. Grant failure or request expiry cannot release
  // this hold. The fresh witnessed roster must no longer contain the device.
  for (const prompt of journal.inbox?.prompts ?? []) if (prompt.state === 'approved') {
    for (const intent of prompt.approval!.rooms) if (intent.session === session && intent.action === 'remove') {
      if (room.keeper !== persona || prompt.request.keeper !== persona) throw new InvalidPersonaRecord('Keeper send hold no longer matches its room')
      if (memberStatuses(active).some(member => member.device === prompt.request.device)) throw new MlsRoomRefused('compromised-removal')
    }
  }
  for (const record of journal.removals) if (record.session === session && record.compromised) {
    const removal = decodeRemoval(wasm, record, { keeper: room.keeper, persona })
    try { if (removal.mls() !== 'Committed') throw new MlsRoomRefused('compromised-removal') }
    finally { removal.free() }
  }
}

/** Development-only room operations. This is not a box driver: authenticated
 * capability/reply transport, invitation admission and UI remain separate.
 * No constructor loads WASM, opens storage or connects to the network. */
export class BrowserMlsRoomOperations {
  #epoch = 0
  #cancel = new Set<() => void>()
  constructor(private readonly coordinator: BrowserPersonaCoordinator, private readonly vault: CoordinatedMlsVault,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}
  invalidate(): void { this.#epoch++; for (const cancel of this.#cancel) cancel() }

  /** Single-box join ceremony: homeBox is the expected group's box and this
   * leaf's box; introductionBox is explicitly resolved by the invitation.
   * Only an active result releases Introduction bytes. Retry an uncertain
   * adoption by discovering/reopening its saved session, never by rejoining. */
  async join(context: MlsRoomContext, options: MlsJoinOptions, source: RendezvousVault, consent: ConsentPrompt): Promise<MlsRoomResult<MlsRoomEffect>> {
    options = { ...options, rendezvous: { ...options.rendezvous } }
    const ctx = Object.freeze({ ...context.vault }), rz = context.rendezvousKey, epoch = this.#epoch, valid = context.current.bind(context)
    const current = () => epoch === this.#epoch && valid() && this.vault.current(ctx)
    let ownedResult: MlsRoomResult<MlsRoomEffect> | undefined, released = false
    let credentialExpiresAt = 0, deadline = 0
    try {
      if (!hex(options.operation) || options.rendezvous.identity !== ctx.persona || options.rendezvous.rendezvousPubkey !== rz || !hex(options.homeBox) || !hex(options.introductionBox) || !hex(options.adderRz) || !hex(options.keeper) ||
        typeof options.counter !== 'bigint' || options.counter < 0n || options.counter > 0x7fffffffffffffffn || !Number.isSafeInteger(options.expiresAt) || typeof options.name !== 'string' || options.name.length < 1 || options.name.length > 120) throw new MlsRoomRefused('malformed')
      let releaseCurrent = () => false
      const result = await withMlsRendezvous(source, options.rendezvous, this.now, current, async custody => {
        releaseCurrent = custody.releaseCurrent
        return ownedResult = await this.#using<MlsRoomEffect>({ vault: ctx, rendezvousKey: rz, current: custody.current }, async scope => {
          credentialExpiresAt = scope.credentialExpiresAt
          const { host, wasm, platform, device, credentialId, hostContext } = scope
          const pending = wasm.Session.prepareCapability(platform, BigInt(this.now()), {
            binding: { ...scope.binding, homeBox: hexToBytes(options.homeBox), expiresAt: BigInt(options.expiresAt) },
            expiresAt: BigInt(options.expiresAt), adderRz: hexToBytes(options.adderRz), counter: options.counter,
          })
          let disposed = false, wake!: () => void, timer: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined
          let cleanupFailure: { error: unknown } | undefined, held: HostedMlsResult<MlsRoomEffect> | undefined
          const cancelled = new Promise<undefined>(resolve => { wake = () => resolve(undefined) })
          const cancel = () => {
            if (disposed) return
            disposed = true
            try { pending.free() } catch (error) { cleanupFailure ??= { error } } finally { wake() }
          }
          this.#cancel.add(cancel)
          try {
            const ask: VmlsSignRequest = pending.signRequest(), dh: VmlsEcdhRequest = pending.ecdhRequest(), typed = request(ask)
            deadline = typed.expires_at
            const ecdh = Object.freeze({ v: 1 as const, operation: bytesToHex(dh.operation), peer_rz: bytesToHex(dh.peerRz), expires_at: Number(dh.expiresAt) })
            if (ecdh.operation !== typed.operation || ecdh.expires_at !== typed.expires_at || ecdh.peer_rz !== options.adderRz) throw new MlsRoomRefused('malformed')
            const live = () => !disposed && scope.current() && custody.current() && this.now() <= typed.expires_at
            const remaining = Math.min(typed.expires_at + 1, options.expiresAt, options.rendezvous.expiresAt) - this.now()
            if (!Number.isSafeInteger(remaining) || remaining <= 0 || remaining > 601) throw new StaleMlsOperation()
            timer = setTimeout(cancel, remaining * 1000)
            // A child mutation in another tab invalidates synchronously, and a
            // bounded poll releases the custody lock even if consent never returns.
            poll = setInterval(() => { if (!live()) cancel() }, 50)
            const sharedAnswer = custody.derive(ecdh)
            const signing = this.vault.signLeafBindingV1(ctx, typed, async s => {
              if (!live()) return 'deny'
              const decision = await consent(s)
              return live() ? decision : 'deny'
            })
            const signed = await Promise.race([signing, cancelled])
            if (!signed || !live()) throw new StaleMlsOperation()
            const reply = checked(signed)
            return held = await host.create({ ...hostContext, current: live }, () => {
              const accepted = checked(this.vault.acceptSignReply(typed, reply))
              if (!live() || accepted.device !== device) throw new StaleMlsOperation()
              const shared = custody.accept(ecdh, sharedAnswer)
              try {
                const made: { session: Session; step: EngineStep } = pending.complete(BigInt(this.now()), ask.operation, hexToBytes(accepted.signature), shared)
                return { session: made.session, step: effect(made.session, made.step) }
              } finally { shared.fill(0) }
            }, {
              validate: async tx => {
                checked(await this.vault.checkRoomDevice(tx, ctx, device, credentialId, options.homeBox))
                for (const id of await mlsRoomIds(tx)) if ((await readMlsRoom(tx, id)).join?.operation === options.operation) throw new MlsRoomRefused('join-exists')
                if (!live()) throw new StaleMlsOperation()
              },
              persist: async (tx, session) => {
                if (session.installation() !== null || session.phase().type !== 'PendingJoin' || bytesToHex(session.homeBox()) !== '00'.repeat(32)) throw new InvalidPersonaRecord('Invalid pending join')
                await createMlsRoom(tx, { version: 1, session: bytesToHex(session.id()), generation: String(session.generation()), name: options.name,
                  keeper: options.keeper,
                  binding: { device, credentialId, rendezvousKey: rz, homeBox: options.homeBox, installation: null }, history: [],
                  join: { operation: options.operation, adderRz: options.adderRz, introductionBox: options.introductionBox, counter: String(options.counter), expiresAt: options.expiresAt } })
              },
            })
          } finally {
            if (timer !== undefined) clearTimeout(timer)
            if (poll !== undefined) clearInterval(poll)
            this.#cancel.delete(cancel); cancel()
            if (cleanupFailure) { wipe(held); throw cleanupFailure.error }
          }
        }, options.expiresAt)
      })
      if (result.state === 'active' && (!releaseCurrent() || this.now() >= Math.min(options.expiresAt, credentialExpiresAt) || this.now() > deadline)) return { state: 'pending', reason: 'stale', refused: false }
      released = true
      return result
    } catch (error) { if (error instanceof MlsRoomRefused) return { state: 'refused', reason: error.reason }; throw error }
    finally { if (!released) wipe(ownedResult) }
  }

  /** Recover an uncertain adoption by its stable caller operation, without
   * requiring the expired provisioned child or making another capability. */
  findJoin(context: MlsRoomContext, operation: string): Promise<MlsRoomResult<string | null>> {
    return this.#using<string | null>(context, async scope => {
      if (!hex(operation)) throw new MlsRoomRefused('malformed')
      return this.coordinator.readConfirmed(scope.ctx.persona, async tx => {
        checked(await this.vault.checkRoomDevice(tx, scope.ctx, scope.device, scope.credentialId))
        for (const id of await mlsRoomIds(tx)) {
          const room = await readMlsRoom(tx, id)
          if (room.join?.operation !== operation) continue
          if (room.binding.device !== scope.device || room.binding.credentialId !== scope.credentialId || room.binding.rendezvousKey !== scope.rz) throw new MlsRoomRefused('stale-device')
          return id
        }
        return null
      }, scope.current)
    })
  }

  async #using<T>(context: MlsRoomContext, work: (scope: {
    host: BrowserMlsSessionHost<Session>; wasm: Awaited<ReturnType<typeof loadMlsEngine>>;
    platform: InstanceType<Awaited<ReturnType<typeof loadMlsEngine>>['Platform']>;
    binding: { credential: any; expiresAt?: bigint }; device: string; credentialId: string; credentialExpiresAt: number;
    ctx: VaultContext; current: () => boolean; hostContext: MlsSessionContext; rz: string;
  }) => Promise<HostedMlsResult<T>>, validUntil = Infinity): Promise<MlsRoomResult<T>> {
    const ctx = Object.freeze({ ...context.vault }), rz = context.rendezvousKey, epoch = this.#epoch
    const valid = context.current.bind(context)
    const current = () => epoch === this.#epoch && valid() && this.vault.current(ctx)
    let platform: InstanceType<Awaited<ReturnType<typeof loadMlsEngine>>['Platform']> | undefined
    let cancel: (() => void) | undefined, output: HostedMlsResult<T> | undefined, released = false
    const close = () => {
      const stopping = cancel; cancel = undefined
      try { if (stopping) { this.#cancel.delete(stopping); stopping() } }
      finally { const freeing = platform; platform = undefined; freeing?.free() }
    }
    try {
      if (!current()) throw new StaleMlsOperation()
      if (!hex(rz)) throw new MlsRoomRefused('malformed')
      const identity = checked(await this.vault.credential(ctx)), wasm = await loadMlsEngine()
      if (!current()) throw new StaleMlsOperation()
      const live = () => current() && this.now() < Math.min(identity.device.credentialExpiresAt, validUntil)
      platform = new wasm.Platform(hexToBytes(identity.device.device), hexToBytes(rz), { fill: n => crypto.getRandomValues(new Uint8Array(n)) })
      const host = new BrowserMlsSessionHost(this.coordinator, (id, plaintext, mark) => wasm.Session.open(platform!, id, plaintext, mark))
      cancel = () => host.invalidate(); this.#cancel.add(cancel)
      const c = identity.credential
      const value = output = await work({ host, wasm, platform, device: identity.device.device, credentialId: identity.device.credentialId, credentialExpiresAt: identity.device.credentialExpiresAt,
        binding: { credential: { pubkey: hexToBytes(c.pubkey), createdAt: BigInt(c.created_at), tags: structuredClone(c.tags), content: c.content, sig: hexToBytes(c.sig) } },
        ctx, current: live, hostContext: { persona: ctx.persona, current: live }, rz })
      close()
      if (!live()) return { state: 'pending', reason: 'stale', refused: false }
      released = true
      return value
    } catch (error) {
      if (error instanceof MlsRoomRefused) return { state: 'refused', reason: error.reason }
      if (error instanceof StaleMlsOperation) return { state: 'pending', reason: 'stale', refused: false }
      throw error
    } finally {
      try { close() } finally { if (!released) wipe(output) }
    }
  }

  /** Caller supplies a box identity and installation from authenticated
   * capabilities. This API does not claim those transport checks itself. */
  create(context: MlsRoomContext, options: { name: string; homeBox: string; installation: string; expiresAt: number }, consent: ConsentPrompt): Promise<MlsRoomResult<MlsRoomEffect>> {
    options = { ...options }
    return this.#using<MlsRoomEffect>(context, async scope => {
      const { host, wasm, platform, device, credentialId, ctx, current, hostContext, rz } = scope
      if (!hex(options.homeBox) || !hex(options.installation) || !Number.isSafeInteger(options.expiresAt) || typeof options.name !== 'string' || options.name.length < 1 || options.name.length > 120) throw new MlsRoomRefused('malformed')
      const pending = wasm.Session.prepareCreate(platform, BigInt(this.now()), { ...scope.binding, homeBox: hexToBytes(options.homeBox), expiresAt: BigInt(options.expiresAt) }, hexToBytes(options.installation))
      let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, wake!: () => void
      const cancelled = new Promise<undefined>(resolve => { wake = () => resolve(undefined) })
      let cleanupFailure: { error: unknown } | undefined, held: HostedMlsResult<MlsRoomEffect> | undefined
      const cancel = () => {
        if (disposed) return
        disposed = true
        try { pending.free() } catch (error) { cleanupFailure ??= { error } } finally { wake() }
      }
      this.#cancel.add(cancel)
      try {
        const ask: VmlsSignRequest = pending.request(), typed = request(ask)
        const remaining = Number(ask.expiresAt) - this.now()
        if (!Number.isSafeInteger(remaining) || remaining < 0 || remaining > 600) throw new StaleMlsOperation()
        timer = setTimeout(cancel, (remaining + 1) * 1000)
        const signed = await Promise.race([this.vault.signLeafBindingV1(ctx, typed, consent), cancelled])
        if (!signed || disposed || !current()) throw new StaleMlsOperation()
        const reply = checked(signed)
        const live = () => !disposed && current() && this.now() <= typed.expires_at && this.now() < options.expiresAt
        return held = await host.create({ ...hostContext, current: live }, () => {
          const accepted = checked(this.vault.acceptSignReply(typed, reply))
          if (!live() || accepted.device !== device) throw new StaleMlsOperation()
          const made: { session: Session; step: EngineStep } = pending.complete(BigInt(this.now()), ask.operation, hexToBytes(accepted.signature))
          return { session: made.session, step: effect(made.session, made.step) }
        }, {
          validate: async tx => { checked(await this.vault.checkRoomDevice(tx, ctx, device, credentialId, options.homeBox)) },
          persist: async (tx, session) => {
            const room: MlsRoomRecord = { version: 1, session: bytesToHex(session.id()), generation: String(session.generation()), name: options.name,
              keeper: ctx.persona, binding: { device, credentialId, rendezvousKey: rz, homeBox: options.homeBox, installation: options.installation }, history: [] }
            await createMlsRoom(tx, room)
          },
        })
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        this.#cancel.delete(cancel); cancel()
        if (cleanupFailure) { wipe(held); throw cleanupFailure.error }
      }
    }, options.expiresAt)
  }

  #edits<T>(ctx: VaultContext, expected: { device: string; credentialId: string; rz: string }, id: string,
    use: (room: MlsRoomRecord, tx: Parameters<NonNullable<MlsSessionEdits<Session, T>['before']>>[0], session: Session) => void | Promise<void>,
    persist?: (room: MlsRoomRecord, session: Session, value: T, tx: Parameters<NonNullable<MlsSessionEdits<Session, T>['persist']>>[0]) => void | Promise<void>,
    needsConsent: () => boolean = () => false): MlsSessionEdits<Session, T> {
    let room: MlsRoomRecord
    return {
      before: async (tx, session) => {
        room = await readMlsRoom(tx, id)
        const b = room.binding
        const installation: Uint8Array | null = session.installation()
        if (room.generation !== String(session.generation()) || bytesToHex(session.homeBox()) !== (b.installation === null ? '00'.repeat(32) : b.homeBox) || (installation === null ? null : bytesToHex(installation)) !== b.installation) throw new InvalidPersonaRecord('Room and session binding differ')
        if (b.device !== expected.device || b.credentialId !== expected.credentialId || b.rendezvousKey !== expected.rz) throw new MlsRoomRefused('stale-device')
        checked(await this.vault.checkRoomDevice(tx, ctx, b.device, b.credentialId, needsConsent() ? b.homeBox : undefined))
        await use(room, tx, session)
      },
      persist: async (tx, session, value) => {
        const events = (value as Partial<MlsRoomEffect> | undefined)?.events
        if (events) rememberMlsOrdering(room, events)
        await persist?.(room, session, value, tx)
        room.generation = String(session.generation())
        await saveMlsRoom(tx, room)
      },
    }
  }

  /** Register and add capabilities already opened through the invitation's
   * authenticated Introduction. This method takes ownership immediately,
   * snapshots metadata through the genuine WASM method, registers every D5
   * package before opening the Add transaction, then rechecks the snapshots
   * against the handles consumed by Session.add. */
  async addCapabilities(context: MlsRoomContext, id: string, supplied: Capability[], client: BrowserMlsBoxClient, boxNow: number): Promise<MlsAddResult> {
    const capabilities = [...supplied]
    let consumed = false
    try {
      return await this.#using<MlsRoomEffect>(context, async scope => {
        if (!(client instanceof BrowserMlsBoxClient) || !Number.isSafeInteger(boxNow) || boxNow < 0 ||
            capabilities.length < 1 || capabilities.length > 64 || capabilities.some(capability => !(capability instanceof scope.wasm.Capability))) throw new MlsRoomRefused('malformed')
        const routes = capabilities.map(capability => {
          const info = scope.wasm.Capability.prototype.info.call(capability), expiresAt = Number(info.expiresAt)
          const route: MlsPackageRoute = { packageId: bytesToHex(info.packageId), welcomeMailbox: bytesToHex(info.welcomeMailbox),
            homeBox: bytesToHex(info.homeBox), leafId: bytesToHex(info.leafId), expiresAt }
          if (![route.packageId, route.welcomeMailbox, route.homeBox, route.leafId].every(hex) || !Number.isSafeInteger(expiresAt) ||
              expiresAt <= boxNow || expiresAt - boxNow > 7 * 86400 || expiresAt <= this.now()) throw new MlsRoomRefused('invalid-package-route')
          return Object.freeze(route)
        })
        let room: MlsRoomRecord
        const validate = async (session: Session, tx: PersonaReader) => {
          const watched = new Set((session.watchList() as MlsWatch[]).map(item => bytesToHex(item.mailbox))), known = room.packages ?? []
          if (room.binding.installation === null) throw new MlsRoomRefused('not-joined')
          if (client.box !== room.binding.homeBox || routes.some(route => route.homeBox !== room.binding.homeBox || watched.has(route.welcomeMailbox))) throw new MlsRoomRefused('invalid-package-route')
          if (known.length + routes.length > 64 || new Set([...known, ...routes].map(route => route.packageId)).size !== known.length + routes.length ||
              new Set([...known, ...routes].map(route => route.welcomeMailbox)).size !== known.length + routes.length) throw new MlsRoomRefused('package-route-full')
          await assertMembershipMutationAllowed(tx, scope.wasm, id, room, scope.ctx.persona, session)
        }
        const checked = await scope.host.step(scope.hostContext, id, session => ({ snapshot: null, value: undefined }),
          this.#edits(scope.ctx, scope, id, async (r, tx, session) => { room = r; await validate(session, tx) }))
        if (checked.state !== 'active') return checked
        for (const route of routes) {
          if (!scope.current() || !BrowserMlsBoxClient.prototype.isCurrent.call(client)) throw new StaleMlsOperation()
          const packageId = hexToBytes(route.packageId), mailbox = hexToBytes(route.welcomeMailbox)
          try {
            const answer = await BrowserMlsBoxClient.prototype.registerPackage.call(client, packageId, mailbox, route.expiresAt, boxNow)
            if (answer.state !== 'ok') throw new PackageRegistrationStopped(answer)
          } finally { packageId.fill(0); mailbox.fill(0) }
        }
        if (!scope.current() || !BrowserMlsBoxClient.prototype.isCurrent.call(client)) throw new StaleMlsOperation()
        return scope.host.step(scope.hostContext, id, session => {
          capabilities.forEach((capability, index) => {
            const info = scope.wasm.Capability.prototype.info.call(capability), expected = routes[index]
            if (bytesToHex(info.packageId) !== expected.packageId || bytesToHex(info.welcomeMailbox) !== expected.welcomeMailbox ||
                bytesToHex(info.homeBox) !== expected.homeBox || bytesToHex(info.leafId) !== expected.leafId || Number(info.expiresAt) !== expected.expiresAt) throw new MlsRoomRefused('invalid-package-route')
          })
          consumed = true
          return effect(session, session.add(BigInt(this.now()), capabilities))
        }, this.#edits(scope.ctx, scope, id, async (r, tx, session) => { room = r; await validate(session, tx) },
          r => { r.packages = [...(r.packages ?? []), ...routes] }))
      })
    } catch (error) {
      if (error instanceof PackageRegistrationStopped) return { state: 'transport', answer: error.answer }
      throw error
    } finally { if (!consumed) freeCapabilities(capabilities) }
  }

  removeDevice(context: MlsRoomContext, id: string, options: { operation: string; leafId: string; members: MlsMemberStatus[]; grants: VmlsGrantRef[]; compromised: boolean; request?: MlsRemovalRecord['request'] }): Promise<MlsRoomResult<MlsRemovalStatus>> {
    return this.#beginRemoval(context, id, { ...options, kind: 'device', target: options.leafId })
  }

  removePerson(context: MlsRoomContext, id: string, options: { operation: string; identity: string; members: MlsMemberStatus[]; grants: VmlsGrantRef[]; compromised: boolean }): Promise<MlsRoomResult<MlsRemovalStatus>> {
    return this.#beginRemoval(context, id, { ...options, kind: 'person', target: options.identity })
  }

  #beginRemoval(context: MlsRoomContext, id: string, options: { operation: string; kind: 'device' | 'person'; target: string; members: MlsMemberStatus[]; grants: VmlsGrantRef[]; compromised: boolean; request?: MlsRemovalRecord['request'] }): Promise<MlsRoomResult<MlsRemovalStatus>> {
    if (options.request !== undefined && !validRequest(options.request)) return Promise.resolve({ state: 'refused', reason: 'malformed' })
    const grants = options.grants.map(grant => ({ node: grant.node.slice(), grant: grant.grant.slice(), keeper: grant.keeper }))
    const members = structuredClone(options.members).sort((a, b) => a.leafId.localeCompare(b.leafId))
    options = { ...options, members, grants, ...(options.request ? { request: structuredClone(options.request) } : {}) }
    return this.#using<MlsRemovalStatus>(context, async scope => {
      if (!hex(options.operation) || !hex(options.target) || typeof options.compromised !== 'boolean') throw new MlsRoomRefused('malformed')
      let room!: MlsRoomRecord, journal!: Awaited<ReturnType<typeof readMlsMembership>>, record: MlsRemovalRecord | undefined, removal: VmlsRemoval | undefined, encoded: Uint8Array | undefined
      try {
        return await scope.host.step(scope.hostContext, id, session => {
          if (record) {
            removal = decodeRemoval(scope.wasm, record, { keeper: room.keeper, persona: scope.ctx.persona })
            const expected = grants.map(grantKey), actual = removal.grants().map(item => grantKey(item.grant))
            if (JSON.stringify(expected) !== JSON.stringify(actual) || JSON.stringify(record.request) !== JSON.stringify(options.request)) throw new MlsRoomRefused('replay')
          } else {
            const actual = memberStatuses(session).filter(member => options.kind === 'person' ? member.identity === options.target : member.leafId === options.target)
              .sort((a, b) => a.leafId.localeCompare(b.leafId))
            if (!members.length || JSON.stringify(actual) !== JSON.stringify(members)) throw new MlsRoomRefused('replay')
            const memberGrants = grants.map(grantKey).filter(grant => !grant.keeper)
            if (options.request) {
              const expected = options.request.boxes.map(node => ({ node, grant: vmlsMemberGrantReference(node, options.request!.device), keeper: false }))
              const observedBoxes = [...new Set(actual.map(member => member.homeBox))].sort()
              if (options.kind !== 'device' || actual.length !== 1 || actual[0].device !== options.request.device ||
                  actual[0].identity !== scope.ctx.persona || !room.keeper || options.request.keeper !== room.keeper ||
                  options.request.keeper === scope.ctx.persona || JSON.stringify(options.request.sessions) !== JSON.stringify([id]) ||
                  JSON.stringify(options.request.boxes) !== JSON.stringify(observedBoxes) ||
                  JSON.stringify(grants.map(grantKey)) !== JSON.stringify(expected)) throw new MlsRoomRefused('malformed')
            } else if (memberGrants.length) throw new MlsRoomRefused('malformed')
            removal = options.kind === 'device'
              ? scope.wasm.removalDevice(session, hexToBytes(options.target), grants)
              : scope.wasm.removalPerson(session, hexToBytes(options.target), grants)
            encoded = removal.encode()
            record = { operation: options.operation, session: id, kind: options.kind, target: options.target, compromised: options.compromised,
              createdAt: this.now(), attempts: 0, failure: null, journal: bytesToHex(encoded),
              ...(options.request ? { request: structuredClone(options.request) } : {}) }
          }
          return { snapshot: null, value: removalStatus(record, removal, session) }
        }, this.#edits(scope.ctx, scope, id, async (value, tx) => {
          room = value
          journal = await readMlsMembership(tx)
          record = journal.removals.find(item => item.operation === options.operation)
          if (record && (record.session !== id || record.kind !== options.kind || record.target !== options.target || record.compromised !== options.compromised)) throw new MlsRoomRefused('replay')
          if (!record && journal.removals.length >= MAX_MLS_REMOVALS) throw new MlsRoomRefused('membership-full')
        }, async (_room, _session, _value, tx) => {
          if (record && !journal.removals.some(item => item.operation === record!.operation)) {
            journal.removals.push(record)
            await saveMlsMembership(tx, journal)
          }
        }))
      } finally { removal?.free(); encoded?.fill(0) }
    }).finally(() => { for (const grant of grants) { grant.node.fill(0); grant.grant.fill(0) } })
  }

  membership(context: MlsRoomContext, id: string): Promise<MlsRoomResult<MlsRemovalStatus[]>> {
    return this.#using<MlsRemovalStatus[]>(context, async scope => {
      let room!: MlsRoomRecord, records: MlsRemovalRecord[] = []
      return scope.host.step(scope.hostContext, id, session => {
        const statuses: MlsRemovalStatus[] = []
        for (const record of records) {
          const removal = decodeRemoval(scope.wasm, record, { keeper: room.keeper, persona: scope.ctx.persona })
          try { statuses.push(removalStatus(record, removal, session)) } finally { removal.free() }
        }
        return { snapshot: null, value: statuses }
      }, this.#edits(scope.ctx, scope, id, async (value, tx) => {
        room = value
        records = (await readMlsMembership(tx)).removals.filter(record => record.session === id)
      }))
    })
  }

  /** Current verified group bindings for membership controls. The browser
   * never derives this roster from presence, profiles or saved invitations. */
  members(context: MlsRoomContext, id: string): Promise<MlsRoomResult<MlsMemberStatus[]>> {
    return this.#using<MlsMemberStatus[]>(context, async scope => {
      let room!: MlsRoomRecord
      return scope.host.step(scope.hostContext, id, session => ({ snapshot: null, value: memberStatuses(session) }),
        this.#edits<MlsMemberStatus[]>(scope.ctx, scope, id, value => { room = value }, async (_room, _session, members, tx) => {
          try { await rememberStandaloneRevocations(tx, scope.ctx.persona, room.keeper, id, members, this.now()) }
          catch (error) { if (error instanceof MlsRevocationOutboxFull) throw new MlsRoomRefused('revocation-outbox-full'); throw error }
        }))
    })
  }

  driveRemoval(context: MlsRoomContext, id: string, operation: string): Promise<MlsRoomResult<MlsRemovalEffect>> {
    return this.#using<MlsRemovalEffect>(context, async scope => {
      if (!hex(operation)) throw new MlsRoomRefused('malformed')
      let room!: MlsRoomRecord, journal!: Awaited<ReturnType<typeof readMlsMembership>>, record!: MlsRemovalRecord, removal: VmlsRemoval | undefined
      let driven: HostedMlsResult<MlsRemovalEffect>
      try {
        driven = await scope.host.step<MlsRemovalEffect>(scope.hostContext, id, session => {
          removal = decodeRemoval(scope.wasm, record, { keeper: room.keeper, persona: scope.ctx.persona })
          let step: EngineStep = { snapshot: null, events: [], outbound: [] }
          const next = removal.next(session)
          if (removal.mls() === 'Failed') {
            if (next.type !== 'Done') return removalEffect(session, step, removalStatus(record, removal, session))
            removal.setMls('Pending'); record.failure = null
          }
          if (next.type === 'Propose') {
            if (record.attempts >= 1000) {
              removal.setMls('Failed'); record.failure = 'AttemptLimit'
            } else {
              record.attempts++
              try { step = session.remove(BigInt(this.now()), next.leafIds) }
              catch (error) {
                const failure = typeof (error as any)?.code === 'string' ? (error as any).code : 'RemoveFailed'
                if (DEFERRED_REMOVAL.has(failure)) record.attempts--
                else { removal.setMls('Failed'); record.failure = failure }
              }
            }
          }
          record.journal = bytesToHex(removal.encode())
          return removalEffect(session, step, removalStatus(record, removal, session))
        }, this.#edits(scope.ctx, scope, id, async (value, tx) => {
          room = value
          journal = await readMlsMembership(tx)
          const found = journal.removals.find(item => item.operation === operation && item.session === id)
          if (!found) throw new MlsRoomRefused('unknown-removal')
          record = found
        }, async (_room, _session, _value, tx) => { await saveMlsMembership(tx, journal) }))
      } finally { removal?.free(); removal = undefined }
      if (driven.state !== 'active' || driven.value.membership.mls !== 'Pending' || driven.value.membership.next.type !== 'Done') return driven
      return scope.host.witnessed<MlsRemovalEffect>(scope.hostContext, id, async (session, witness, tx) => {
        const room = await readMlsRoom(tx, id), stored = await readMlsMembership(tx), found = stored.removals.find(item => item.operation === operation && item.session === id)
        if (!found) throw new MlsRoomRefused('unknown-removal')
        const committed = decodeRemoval(scope.wasm, found, { keeper: room.keeper, persona: scope.ctx.persona })
        try {
          witness.mlsCommitted(committed, session)
          found.failure = null; found.journal = bytesToHex(committed.encode())
          await saveMlsMembership(tx, stored)
          return removalEffectValue(session, committed, found)
        } finally { committed.free() }
      })
    })
  }

  retryRemoval(context: MlsRoomContext, id: string, operation: string): Promise<MlsRoomResult<MlsRemovalStatus>> {
    return this.#changeRemoval(context, id, operation, removal => removal.setMls('Pending'))
  }

  setRemovalCredential(context: MlsRoomContext, id: string, operation: string, state: VmlsCredentialState): Promise<MlsRoomResult<MlsRemovalStatus>> {
    return this.#changeRemoval(context, id, operation, removal => {
      if (!['Unchanged', 'Revoked', 'Pending', 'Failed'].includes(state)) throw new MlsRoomRefused('malformed')
      removal.setCredential(state)
    })
  }

  setRemovalGrant(context: MlsRoomContext, id: string, operation: string, grant: string, state: VmlsGrantState): Promise<MlsRoomResult<MlsRemovalStatus>> {
    return this.#changeRemoval(context, id, operation, removal => {
      if (!hex(grant) || !validGrantState(state)) throw new MlsRoomRefused('malformed')
      removal.setGrant(hexToBytes(grant), state)
    })
  }

  setRemovalGrants(context: MlsRoomContext, id: string, operation: string,
    grants: readonly { grant: string; state: VmlsGrantState }[]): Promise<MlsRoomResult<MlsRemovalStatus>> {
    const copy = structuredClone(grants)
    if (!copy.length || copy.length > 64 || copy.some(item => !item || typeof item !== 'object' || !exactKeys(item, 'grant,state') ||
        !hex(item.grant) || !validGrantState(item.state)) || new Set(copy.map(item => item.grant)).size !== copy.length) {
      return Promise.resolve({ state: 'refused', reason: 'malformed' })
    }
    return this.#changeRemoval(context, id, operation, removal => {
      for (const item of copy) removal.setGrant(hexToBytes(item.grant), item.state)
    })
  }

  roomRevocationAuthority(context: MlsRoomContext, id: string): Promise<MlsRoomResult<{ name: string; keeper?: string }>> {
    return this.#using(context, async scope => {
      let room: MlsRoomRecord
      return scope.host.step(scope.hostContext, id, () => ({ snapshot: null, value: { name: room.name, ...(room.keeper ? { keeper: room.keeper } : {}) } }),
        this.#edits(scope.ctx, scope, id, value => { room = value }))
    })
  }

  #changeRemoval(context: MlsRoomContext, id: string, operation: string, change: (removal: VmlsRemoval) => void): Promise<MlsRoomResult<MlsRemovalStatus>> {
    return this.#using<MlsRemovalStatus>(context, async scope => {
      if (!hex(operation)) throw new MlsRoomRefused('malformed')
      let room!: MlsRoomRecord, journal!: Awaited<ReturnType<typeof readMlsMembership>>, record!: MlsRemovalRecord, removal: VmlsRemoval | undefined
      try {
        return await scope.host.step(scope.hostContext, id, session => {
          removal = decodeRemoval(scope.wasm, record, { keeper: room.keeper, persona: scope.ctx.persona }); change(removal)
          record.failure = null; record.journal = bytesToHex(removal.encode())
          return { snapshot: null, value: removalStatus(record, removal, session) }
        }, this.#edits(scope.ctx, scope, id, async (value, tx) => {
          room = value
          journal = await readMlsMembership(tx)
          const found = journal.removals.find(item => item.operation === operation && item.session === id)
          if (!found) throw new MlsRoomRefused('unknown-removal')
          record = found
        }, async (_room, _session, _value, tx) => { await saveMlsMembership(tx, journal) }))
      } finally { removal?.free() }
    })
  }

  update(context: MlsRoomContext, id: string, expiresAt: number, consent: ConsentPrompt): Promise<MlsRoomResult<MlsRoomEffect>> {
    return this.#using<MlsRoomEffect>(context, async scope => {
      if (!Number.isSafeInteger(expiresAt)) throw new MlsRoomRefused('malformed')
      let room: MlsRoomRecord, typed: SignLeafBindingRequest, signed: SignLeafBindingReply, signatureReturned = false
      return scope.host.signedStep({ ...scope.hostContext, current: () => scope.current() && this.now() < expiresAt }, id,
        s => { if (room.binding.installation === null) throw new MlsRoomRefused('not-joined'); return s.prepareUpdate(BigInt(this.now()), { ...scope.binding, homeBox: hexToBytes(room.binding.homeBox), expiresAt: BigInt(expiresAt) }) as VmlsSignRequest },
        async ask => { typed = request(ask); signed = checked(await this.vault.signLeafBindingV1(scope.ctx, typed, consent)); signatureReturned = true; return signed },
        (s, ask) => {
          const reply = checked(this.vault.acceptSignReply(typed, signed))
          if (reply.device !== scope.device || this.now() >= expiresAt) throw new StaleMlsOperation()
          return effect(s, s.completeUpdate(BigInt(this.now()), ask.operation, hexToBytes(reply.signature)))
        }, this.#edits(scope.ctx, scope, id, r => { room = r }, undefined, () => signatureReturned), this.now)
    }, expiresAt)
  }

  read(context: MlsRoomContext, id: string) {
    return this.#using(context, async scope => {
      let room: MlsRoomRecord
      return scope.host.step(scope.hostContext, id, s => ({ snapshot: null, value: { name: room.name, session: id, generation: String(s.generation()), phase: s.phase(), updateRequired: s.updateRequired(), join: room.join, history: mlsHistory(room), outbox: s.outbox(), watch: s.watchList() } }),
        this.#edits(scope.ctx, scope, id, r => { room = r }))
    })
  }

  /** Minimal witnessed state for one driver round. No chat plaintext. */
  driverState(context: MlsRoomContext, id: string): Promise<MlsRoomResult<MlsDriverState>> {
    return this.#using<MlsDriverState>(context, async scope => {
      let room: MlsRoomRecord
      return scope.host.step(scope.hostContext, id, s => ({ snapshot: null, value: {
        generation: String(s.generation()), phase: s.phase(), epoch: s.epoch() as bigint | null,
        binding: room.binding, join: room.join, packages: room.packages ?? [], ordering: room.ordering ?? [], outbox: s.outbox() as MlsOutbound[], watch: s.watchList() as MlsWatch[],
      } }), this.#edits(scope.ctx, scope, id, r => { room = r }))
    })
  }

  /** Fresh, exact-room confirmation for unjournalled box authentication.
   * Normal session cleanup invalidates its short-lived confirmation; this
   * separate transaction owns no engine handle and closes before signing. */
  async confirmTransport(context: MlsRoomContext, id: string, expected: { generation: string; homeBox: string }): Promise<MlsRoomResult<void>> {
    const ctx = Object.freeze({ ...context.vault }), rz = context.rendezvousKey, epoch = this.#epoch, valid = context.current.bind(context)
    expected = { ...expected }
    const current = () => epoch === this.#epoch && valid() && this.vault.current(ctx)
    try {
      return await this.coordinator.transact(ctx.persona, async tx => {
        const room = await readMlsRoom(tx, id), b = room.binding
        if (room.generation !== expected.generation) throw new StaleMlsOperation()
        if (b.homeBox !== expected.homeBox || b.rendezvousKey !== rz) throw new MlsRoomRefused('wrong-box')
        checked(await this.vault.checkRoomDevice(tx, ctx, b.device, b.credentialId))
      }, current)
    } catch (error) {
      if (error instanceof StaleMlsOperation) return { state: 'pending', reason: 'stale', refused: false }
      if (error instanceof MlsRoomRefused) return { state: 'refused', reason: error.reason }
      throw error
    }
  }

  /** Every network answer is conditional on the predecessor that authorised
   * its request. Reconcile and check inside the persona lock, never retarget a
   * delayed answer to a newer session. No box I/O in this transaction. */
  drive(context: MlsRoomContext, id: string, guard: MlsDriverGuard, command: MlsDriverCommand): Promise<MlsRoomResult<MlsRoomEffect>> {
    guard = { ...guard }; command = structuredClone(command)
    return this.#using<MlsRoomEffect>(context, async scope => {
      let room: MlsRoomRecord, deliveredPackages: string[] = [], expiredPackages = new Set<string>()
      return scope.host.step(scope.hostContext, id, s => {
        if (guard.generation !== String(s.generation())) throw new StaleMlsOperation()
        if (guard.homeBox !== room.binding.homeBox || !hex(guard.installation)) throw new MlsRoomRefused('wrong-box')
        if (command.type !== 'installation' && room.binding.installation !== null && guard.installation !== room.binding.installation) throw new MlsRoomRefused('wrong-installation')
        try {
          const at = this.now(), now = BigInt(at)
          switch (command.type) {
            case 'installation': return effect(s, ['Active', 'NeedsRecovery'].includes(s.phase().type) ? s.observeInstallation(now, hexToBytes(guard.installation)) : { snapshot: null, events: [], outbound: [] })
            case 'tick': return effect(s, s.tick(now))
            case 'prune-packages': {
              const outbox = s.outbox() as MlsOutbound[], pendingLeaves = new Set(memberStatuses(s).filter(member => member.pending).map(member => member.leafId))
              const records: Uint8Array[] = []
              for (const route of room.packages ?? []) {
                if (route.expiresAt >= at - MLS_PACKAGE_EXPIRY_SKEW_SECONDS || route.homeBox !== room.binding.homeBox || !pendingLeaves.has(route.leafId)) continue
                const welcomes = outbox.filter(outbound => outbound.destination.type === 'Welcome' &&
                  bytesToHex((outbound.destination as Extract<MlsDestination, { type: 'Welcome' }>).packageId) === route.packageId)
                if (welcomes.length !== 1 || bytesToHex(welcomes[0].mailbox) !== route.welcomeMailbox) continue
                expiredPackages.add(route.packageId); records.push(welcomes[0].recordId)
              }
              if (!records.length) return effect(s, { snapshot: null, events: [], outbound: [] })
              return effect(s, s.outboundDelivered(records))
            }
            case 'delivered':
              if (!command.records.length || command.records.some(id => !s.outbox().some((r: MlsOutbound) => bytesToHex(r.recordId) === bytesToHex(id)))) throw new StaleMlsOperation()
              deliveredPackages = s.outbox().filter((outbound: MlsOutbound) => command.records.some(record => bytesToHex(record) === bytesToHex(outbound.recordId)) && outbound.destination.type === 'Welcome')
                .map((outbound: MlsOutbound) => bytesToHex((outbound.destination as Extract<MlsDestination, { type: 'Welcome' }>).packageId))
              return effect(s, s.outboundDelivered(command.records))
            case 'deposit': return effect(s, s.depositResult(now, command.attempt, command.receipt))
            case 'confirm': return effect(s, s.confirmMember(command.packageId))
            case 'slot': return effect(s, s.slotStatus(now, command.attempt, command.status, command.receipt))
            case 'receipt':
              if (command.receipt.length !== 197 || bytesToHex(command.receipt.subarray(65, 97)) !== command.slot) throw new MlsRoomRefused('wrong-slot')
              if (!room.ordering?.some(q => q.slot === command.slot && q.attempt === command.attempt)) throw new StaleMlsOperation()
              // A failed signature/association leaves the durable query pending.
              return effect(s, s.observeReceipt(now, command.receipt))
            case 'drained': return effect(s, s.mailboxDrained(command.mailbox))
          }
        } catch (error) {
          if ((error as any)?.kind === 'engine') throw new MlsRoomRefused('engine:' + (error as any).code)
          throw error
        }
      }, this.#edits<MlsRoomEffect>(scope.ctx, scope, id, r => { room = r }, (r, s) => {
        if (command.type === 'receipt') r.ordering = r.ordering?.filter(q => q.slot !== command.slot || q.attempt !== command.attempt)
        if (deliveredPackages.length) r.packages = r.packages?.filter(route => !deliveredPackages.includes(route.packageId))
        if (command.type === 'prune-packages') r.packages = r.packages?.filter(route => !expiredPackages.has(route.packageId))
      }))
    }).finally(() => wipe(command))
  }

  rename(context: MlsRoomContext, id: string, name: string): Promise<MlsRoomResult<void>> {
    return this.#using(context, async scope => {
      if (typeof name !== 'string' || name.length < 1 || name.length > 120) throw new MlsRoomRefused('malformed')
      return scope.host.step(scope.hostContext, id, () => ({ snapshot: null, value: undefined }), this.#edits(scope.ctx, scope, id, () => undefined, r => { r.name = name }))
    })
  }

  /** A stable caller operation id makes an uncertain local send idempotent.
   * Reusing it for different bytes refuses; ids are never silently evicted. */
  send(context: MlsRoomContext, id: string, operation: string, body: Uint8Array): Promise<MlsRoomResult<MlsRoomEffect>> {
    body = body.slice()
    return this.#using<MlsRoomEffect>(context, async scope => {
      if (!hex(operation)) throw new MlsRoomRefused('malformed')
      let room: MlsRoomRecord, message: { leaf: string; epoch: string } | undefined
      return scope.host.step(scope.hostContext, id, s => {
        if (room.binding.installation === null) throw new MlsRoomRefused('not-joined')
        if (s.updateRequired()) throw new MlsRoomRefused('update-required')
        const previous = room.history.find(m => m.id === 'sent:' + operation)
        if (previous) {
          if (previous.body !== bytesToHex(body)) throw new MlsRoomRefused('replay')
          return { snapshot: null, value: { session: id, generation: String(s.generation()), events: [], outbound: [], outcome: { type: 'Duplicate' } } }
        }
        message = { leaf: bytesToHex(s.ownLeafId()), epoch: String(s.epoch()) }
        return effect(s, s.send(body))
      }, this.#edits(scope.ctx, scope, id, async (r, tx, s) => {
        room = r
        await assertMembershipMutationAllowed(tx, scope.wasm, id, room, scope.ctx.persona, s)
      }, r => {
        if (message) appendMlsHistory(r, { id: 'sent:' + operation, direction: 'sent', ...message, body })
      }))
    }).finally(() => body.fill(0))
  }

  /** The driver must verify the box reply, requested mailbox and receipt
   * framing before this call. Only an active result may acknowledge the box. */
  process(context: MlsRoomContext, id: string, input: { mailbox: Uint8Array; envelope: Uint8Array; receipt?: Uint8Array; homeBox: string; installation: string; generation?: string }): Promise<MlsRoomResult<MlsRoomEffect>> {
    input = { ...input, mailbox: input.mailbox.slice(), envelope: input.envelope.slice(), receipt: input.receipt?.slice() }
    return this.#using<MlsRoomEffect>(context, async scope => {
      let room: MlsRoomRecord
      return scope.host.step(scope.hostContext, id, s => {
        if (input.generation !== undefined && input.generation !== String(s.generation())) throw new StaleMlsOperation()
        if (input.homeBox !== room.binding.homeBox || !hex(input.installation)) throw new MlsRoomRefused('wrong-box')
        if (room.binding.installation !== null && input.installation !== room.binding.installation) return effect(s, s.observeInstallation(BigInt(this.now()), hexToBytes(input.installation)), { ack: { type: 'Keep' } })
        const processed = s.process(BigInt(this.now()), input.mailbox, input.envelope, input.receipt,
          room.binding.installation === null ? { homeBox: hexToBytes(input.homeBox), installation: hexToBytes(input.installation) } : undefined)
        if (s.installation() !== null && bytesToHex(s.homeBox()) !== room.binding.homeBox) throw new MlsRoomRefused('wrong-box')
        if (processed.step.events.some((e: any) => e.type === 'Message') && (!processed.step.snapshot || processed.outcome.type !== 'Accepted')) throw new Error('Unwitnessed MLS message')
        return effect(s, processed.step, { ack: processed.ack, outcome: processed.outcome })
      }, this.#edits<MlsRoomEffect>(scope.ctx, scope, id, r => { room = r }, (r, s, value) => {
        if (r.binding.installation === null && s.installation() !== null) {
          if (!value.events.some(e => e.type === 'Joined') || value.outcome?.type !== 'Accepted') throw new InvalidPersonaRecord('Unwitnessed Welcome binding')
          r.binding.installation = bytesToHex(s.installation())
        }
        for (const event of value.events) if (event.type === 'Message') appendMlsHistory(r, {
          id: 'received:' + bytesToHex(sha256(input.envelope)), direction: 'received', leaf: bytesToHex(event.sender.leafId), epoch: String(event.epoch), body: event.body,
        })
      }))
    }).finally(() => { input.mailbox.fill(0); input.envelope.fill(0); input.receipt?.fill(0) })
  }
}

function wipe(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) wipe(v)
}

export interface MlsDriverGuard { generation: string; homeBox: string; installation: string }
export type MlsDriverCommand =
  | { type: 'installation' | 'tick' | 'prune-packages' }
  | { type: 'delivered'; records: Uint8Array[] }
  | { type: 'deposit'; attempt: number; receipt: Uint8Array }
  | { type: 'confirm'; packageId: Uint8Array }
  | { type: 'slot'; attempt: number; status: 'Expired' | 'Void'; receipt: Uint8Array }
  | { type: 'receipt'; slot: string; attempt: number; receipt: Uint8Array }
  | { type: 'drained'; mailbox: Uint8Array }
export type MlsDestination =
  | { type: 'Leaf'; leafId: Uint8Array; homeBox: Uint8Array }
  | { type: 'CommitSlot'; homeBox: Uint8Array; epoch: bigint; attempt: number }
  | { type: 'ForkEvidence'; homeBox: Uint8Array; expiresAt: bigint }
  | { type: 'Introduction'; peerRz: Uint8Array }
  | { type: 'Welcome'; packageId: Uint8Array }
export interface MlsOutbound { recordId: Uint8Array; mailbox: Uint8Array; envelope: Uint8Array; destination: MlsDestination }
export interface MlsWatch { mailbox: Uint8Array; homeBox: Uint8Array | null; kind: { type: 'OwnLeaf' | 'RetainedLeaf' | 'ForkEvidence' | 'Welcome' } | { type: 'CommitSlot'; epoch: bigint; attempt: number } }
export interface MlsDriverState { generation: string; phase: { type: string; reason?: string }; epoch: bigint | null; binding: MlsRoomRecord['binding']; join?: MlsRoomRecord['join']; packages: MlsPackageRoute[]; ordering: { slot: string; attempt: number }[]; outbox: MlsOutbound[]; watch: MlsWatch[] }
