import { sendVmlsRevocationRequest, wrapVmlsRevocationRequest, VMLS_REVOCATION_REQUEST_SECONDS,
  type VmlsRevocationIdentity, type VmlsRevocationTransport } from '../../src/vmls-revocation-request.js'
import { InvalidPersonaRecord, type CoordinationResult, type BrowserPersonaCoordinator, type PersonaTransaction } from './mls-persona-coordinator.js'
import { mlsStandaloneRevocationOperation, readMlsMembership, saveMlsMembership,
  type MlsStandaloneRevocationRecord } from './mls-membership-store.js'
import { mlsStandaloneState } from './mls-revocation-outbox-state.js'
import { MAX_MLS_STANDALONE_OBSERVATIONS, type MlsStandaloneObservation } from './mls-revocation-outbox-store.js'
import type { Event } from 'nostr-tools/pure'
import { BrowserMlsGrantEndpoint } from './mls-grant-endpoint.js'
import { CoordinatedMlsVault } from './mls-coordinated-vault.js'
import { mlsBoxNode } from './mls-grant-ledger.js'
import { keeperInboxAuthRequest, keeperInboxDestination, keeperInboxPermissionCurrent, keeperInboxPermissionDevice, type KeeperInboxAuthRequest, type KeeperInboxAuthPrompt } from './mls-keeper-inbox-auth.js'
import type { MlsPrivateRevocationDestination } from './mls-revocation-outbox-store.js'
import type { VaultContext } from './mls-vault.js'

const hex32 = /^[0-9a-f]{64}$/
const validTime = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

export class MlsRevocationOutboxFull extends Error {}
export interface MlsStandaloneRevocationView extends MlsStandaloneRevocationRecord {
  requestRevision: number
  requestState: 'none' | 'unconfirmed' | 'sent'
  requestExpiration?: number
  privateDestination?: MlsPrivateRevocationDestination
  publicAttempted?: boolean
}
const view = (item: MlsStandaloneObservation): MlsStandaloneRevocationView => ({
  operation: item.operation, sender: item.sender, keeper: item.keeper, device: item.device, sessions: item.sessions.slice(), boxes: item.boxes.slice(),
  createdAt: item.observedAt, sentAt: item.attempt?.confirmed ? item.attempt.createdAt : null, requestRevision: item.requestRevision,
  requestState: item.attempt ? item.attempt.confirmed ? 'sent' : 'unconfirmed' : 'none',
  ...(item.attempt ? { requestExpiration: item.attempt.expiration } : {}),
  ...(item.attempt?.private ? { privateDestination: { ...item.attempt.private } } : {}),
  ...(item.publicAttempted !== undefined ? { publicAttempted: item.publicAttempted } : {}),
})

interface ObservedMember { identity: string; device: string; homeBox: string; own: boolean; pending: boolean }

/** Retain only same-person, non-local, committed roster devices. This runs in
 * the same witnessed transaction as the genuine engine roster read. */
export async function rememberStandaloneRevocations(tx: PersonaTransaction, sender: string, keeper: string | undefined,
  session: string, members: readonly ObservedMember[], createdAt: number): Promise<void> {
  if (!hex32.test(sender) || !hex32.test(session) || !validTime(createdAt)) throw new Error('Invalid standalone revocation observation.')
  if (!keeper || !hex32.test(keeper) || keeper === sender) return
  const state = await mlsStandaloneState(tx, createdAt)
  let changed = false
  const devices = new Map<string, Set<string>>()
  for (const member of members) if (member.identity === sender && !member.own && !member.pending) {
    if (!hex32.test(member.device) || !hex32.test(member.homeBox)) throw new InvalidPersonaRecord('Invalid standalone revocation roster evidence')
    const boxes = devices.get(member.device) ?? new Set<string>(); boxes.add(member.homeBox); devices.set(member.device, boxes)
  }
  for (const [device, observedBoxes] of [...devices].sort(([a], [b]) => a.localeCompare(b))) {
    const operation = mlsStandaloneRevocationOperation(sender, keeper, device), saved = state.observations.find(item => item.operation === operation)
    if (saved && (saved.sender !== sender || saved.keeper !== keeper || saved.device !== device)) throw new InvalidPersonaRecord('Standalone revocation record binding differs')
    const sessions = [...new Set([...(saved?.sessions ?? []), session])].sort()
    const boxes = [...new Set([...(saved?.boxes ?? []), ...observedBoxes])].sort()
    if (sessions.length > 64 || boxes.length > 64) throw new MlsRevocationOutboxFull('The standalone revocation record is full.')
    if (saved) {
      if (JSON.stringify(saved.sessions) !== JSON.stringify(sessions) || JSON.stringify(saved.boxes) !== JSON.stringify(boxes)) {
        saved.sessions = sessions; saved.boxes = boxes; changed = true
      }
    } else {
      if (state.observations.length >= MAX_MLS_STANDALONE_OBSERVATIONS) throw new MlsRevocationOutboxFull('The standalone revocation observation journal is full.')
      state.observations.push({ operation, sender, keeper, device, sessions, boxes, observedAt: createdAt, requestRevision: 0 }); changed = true
    }
  }
  if (changed) {
    state.observations.sort((a, b) => a.operation.localeCompare(b.operation))
    const journal = await readMlsMembership(tx); journal.standalone = state
    await saveMlsMembership(tx, journal)
  }
}

export interface MlsRevocationOutboxContext { vault: VaultContext; current(): boolean }
type Coordinator = Pick<BrowserPersonaCoordinator, 'transact'>
type PublicOptions = { identity: VmlsRevocationIdentity; transport: VmlsRevocationTransport; random?: () => number }
export interface MlsPrivateRevocationOptions {
  identity: VmlsRevocationIdentity; endpoint: BrowserMlsGrantEndpoint; vault: CoordinatedMlsVault
  routeId: string; permission: Event; consent: KeeperInboxAuthPrompt; current(): boolean; random?: () => number
}
type Delivery = { mode: 'public'; options: PublicOptions } | {
  mode: 'private'; options: MlsPrivateRevocationOptions; guard: () => boolean; permission: KeeperInboxAuthRequest; destination: MlsPrivateRevocationDestination
}
interface Sending {
  key: string; scope: string; identity: VmlsRevocationIdentity; sign: VmlsRevocationIdentity['signEvent']; encrypt: VmlsRevocationIdentity['encrypt']; decrypt: VmlsRevocationIdentity['decrypt']
  owner: object; consent?: KeeperInboxAuthPrompt; current?: () => boolean; vault?: CoordinatedMlsVault
  pending: Promise<CoordinationResult<MlsStandaloneRevocationView>>
}

/** Sends retained roster evidence without reopening an MLS session. The
 * persona witness still covers both the source record and the sent marker. */
export class BrowserMlsRevocationOutbox {
  readonly #sending = new Map<string, Sending>()
  constructor(private coordinator: Coordinator, private context: () => MlsRevocationOutboxContext | undefined,
    private now: () => number = () => Math.floor(Date.now() / 1000)) {}

  async records(): Promise<CoordinationResult<MlsStandaloneRevocationView[]>> {
    const scope = this.#scope()
    return this.coordinator.transact(scope.vault.persona, async tx => {
      const records = (await mlsStandaloneState(tx, this.now())).observations
      for (const record of records) this.#assertRecord(record, record.operation, scope.vault.persona)
      return records.map(view)
    }, () => this.#current(scope))
  }

  send(operation: string, options: PublicOptions): Promise<CoordinationResult<MlsStandaloneRevocationView>> {
    return this.#start(operation, { mode: 'public', options })
  }
  /** A fresh wrap needs an explicit current operator revision. */
  retry(operation: string, revision: number, options: PublicOptions): Promise<CoordinationResult<MlsStandaloneRevocationView>> {
    if (!Number.isSafeInteger(revision) || revision < 1) return Promise.reject(new Error('Check the current request before retrying.'))
    return this.#start(operation, { mode: 'public', options }, revision)
  }
  sendPrivately(operation: string, input: MlsPrivateRevocationOptions, revision?: number): Promise<CoordinationResult<MlsStandaloneRevocationView>> {
    try {
      if (!(input.endpoint instanceof BrowserMlsGrantEndpoint) || !(input.vault instanceof CoordinatedMlsVault) ||
          !input.vault.usesCoordinator(this.coordinator as BrowserPersonaCoordinator) ||
          typeof input.routeId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}(?![\s\S])/.test(input.routeId) ||
          typeof input.current !== 'function' || typeof input.consent !== 'function' ||
          revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error('Select a current saved private route and explicit AUTH consent.')
      const p = input.permission
      if (!p || !Array.isArray(p.tags) || p.tags.length !== 6) throw new Error('Invalid keeper inbox deposit permission.')
      const eventUrl = p.tags.find(tag => Array.isArray(tag) && tag[0] === 'server')?.[1]
      if (typeof eventUrl !== 'string') throw new Error('Invalid keeper inbox deposit permission.')
      const node = mlsBoxNode({ routeId: input.routeId, eventUrl })
      const permission = keeperInboxAuthRequest({ v: 1, box: node, keeper: p.pubkey, permission: p, challenge: '00'.repeat(32), expires_at: this.now() + 120 })
      if (!permission || !keeperInboxPermissionCurrent(permission, this.now())) throw new Error('Invalid or expired keeper inbox deposit permission.')
      const options = { ...input }, destination = Object.freeze({ routeId: input.routeId, eventUrl: keeperInboxDestination(node), node,
        keeper: permission.keeper, permissionId: permission.permission.id, transmittingDevice: keeperInboxPermissionDevice(permission) })
      return this.#start(operation, { mode: 'private', options, guard: input.current.bind(input), permission, destination }, revision)
    } catch (error) { return Promise.reject(error) }
  }
  #start(operation: string, delivery: Delivery, revision?: number): Promise<CoordinationResult<MlsStandaloneRevocationView>> {
    let scope: MlsRevocationOutboxContext
    try { scope = this.#scope() } catch (error) { return Promise.reject(error) }
    const options = delivery.options, identity = options.identity
    const key = JSON.stringify([delivery.mode, delivery.mode === 'private' ? delivery.destination : null, revision ?? null])
    const context = JSON.stringify(scope.vault), owner = delivery.mode === 'private' ? delivery.options.endpoint : delivery.options.transport
    const consent = delivery.mode === 'private' ? delivery.options.consent : undefined
    const current = delivery.mode === 'private' ? delivery.options.current : undefined
    const vault = delivery.mode === 'private' ? delivery.options.vault : undefined
    const existing = this.#sending.get(operation)
    if (existing) {
      if (existing.key !== key || existing.scope !== context || existing.identity !== identity || existing.sign !== identity.signEvent ||
          existing.encrypt !== identity.encrypt || existing.decrypt !== identity.decrypt || existing.owner !== owner ||
          existing.consent !== consent || existing.current !== current || existing.vault !== vault) return Promise.reject(new Error('A different standalone revocation send is already running.'))
      return existing.pending
    }
    if (this.#sending.size >= MAX_MLS_STANDALONE_OBSERVATIONS) return Promise.reject(new MlsRevocationOutboxFull('The standalone send queue is full.'))
    const pending = this.#send(operation, delivery, scope, revision)
    const running: Sending = { key, scope: context, identity, sign: identity.signEvent, encrypt: identity.encrypt, decrypt: identity.decrypt, owner, consent, current, vault, pending }
    this.#sending.set(operation, running)
    void pending.then(() => { if (this.#sending.get(operation) === running) this.#sending.delete(operation) },
      () => { if (this.#sending.get(operation) === running) this.#sending.delete(operation) })
    return pending
  }
  async #send(operation: string, delivery: Delivery, scope: MlsRevocationOutboxContext, revision?: number): Promise<CoordinationResult<MlsStandaloneRevocationView>> {
    if (!hex32.test(operation)) throw new Error('Invalid standalone revocation operation.')
    const identity = delivery.options.identity
    const signer: VmlsRevocationIdentity = { pubkey: identity.pubkey, signEvent: identity.signEvent.bind(identity), encrypt: identity.encrypt.bind(identity), decrypt: identity.decrypt.bind(identity) }
    const current = (observedAt?: number) => {
      try { return (delivery.mode === 'public' || delivery.guard() === true &&
        delivery.options.vault.current(scope.vault) && keeperInboxPermissionCurrent(delivery.permission, observedAt ?? this.now())) && this.#current(scope) }
      catch { return false }
    }
    if (identity.pubkey !== scope.vault.persona) throw new Error('Sign in as the requesting member.')
    if (!current()) throw new Error('The requesting account or private permission changed.')
    if (delivery.mode === 'private') {
      const saved = (await delivery.options.endpoint.pairedBoxes(scope.vault.persona)).find(box => box.routeId === delivery.destination.routeId)
      if (!current() || !saved || saved.eventUrl !== delivery.destination.eventUrl || mlsBoxNode(saved) !== delivery.destination.node) throw new Error('The selected private Bothy route changed.')
    }
    const before = await this.coordinator.transact(scope.vault.persona, async tx => {
      const state = await mlsStandaloneState(tx, this.now()), record = state.observations.find(item => item.operation === operation)
      if (!record) throw new Error('That standalone revocation request is no longer retained.')
      this.#assertRecord(record, operation, scope.vault.persona)
      if (!current()) throw new Error('The requesting account or private permission changed.')
      const destination = delivery.mode === 'private' ? delivery.destination : undefined
      let credentialExpiresAt: number | undefined
      if (delivery.mode === 'private') {
        if (record.keeper !== destination!.keeper) throw new Error('The selected keeper does not match this retained request.')
        const device = await delivery.options.vault.keeperInboxDevice(tx, scope.vault, destination!.transmittingDevice)
        if (!device.ok) throw new Error('The current transmitting device is unavailable: ' + device.refusal)
        credentialExpiresAt = device.value.credentialExpiresAt
      }
      if (revision === undefined && record.attempt) {
        if (JSON.stringify(record.attempt.private) !== JSON.stringify(destination)) throw new Error('The retained attempt used a different delivery destination. Check its revision before retrying.')
        return { record: structuredClone(record), publish: false, credentialExpiresAt }
      }
      if (revision === undefined && record.requestRevision !== 0) throw new Error('Check the current request before choosing a fresh retry.')
      if (revision !== undefined && revision !== record.requestRevision) throw new Error('The request changed. Check it again before retrying.')
      if (record.requestRevision === Number.MAX_SAFE_INTEGER) throw new Error('The standalone request revision is full.')
      record.requestRevision++
      record.publicAttempted = record.publicAttempted === true || delivery.mode === 'public'
      record.attempt = { revision: record.requestRevision, createdAt: state.checkedAt, expiration: state.checkedAt + VMLS_REVOCATION_REQUEST_SECONDS, confirmed: false,
        ...(destination ? { private: { ...destination } } : {}) }
      const journal = await readMlsMembership(tx); journal.standalone = state; await saveMlsMembership(tx, journal)
      return { record: structuredClone(record), publish: true, credentialExpiresAt }
    }, current)
    if (before.state !== 'active') return before
    const frozen = before.value.record
    if (!before.value.publish) return { ...before, value: view(frozen) }
    const attempt = frozen.attempt!, createdAt = attempt.createdAt, credentialExpiresAt = before.value.credentialExpiresAt ?? 0
    let privateFloor = createdAt
    const alive = () => {
      const at = this.now()
      if (!current(at) || !validTime(at) || at < createdAt || at >= attempt.expiration) return false
      if (delivery.mode === 'private') {
        if (at >= credentialExpiresAt || at < privateFloor) return false
        privateFloor = at
      }
      return true
    }
    const request = { sender: frozen.sender, keeper: frozen.keeper, device: frozen.device, sessions: frozen.sessions, boxes: frozen.boxes, createdAt, expiration: attempt.expiration }
    if (delivery.mode === 'public') {
      const directoryEvents = await delivery.options.transport.directory(frozen.keeper)
      if (!current()) throw new Error('The requesting account changed.')
      if (!alive()) throw new Error('The request time changed.')
      await sendVmlsRevocationRequest({ identity: signer, request, directoryEvents,
        publish: publication => delivery.options.transport.publish(publication), current: alive, random: delivery.options.random })
    } else {
      if (!alive()) throw new Error('The requesting account, credential or private permission changed.')
      const selected = (await delivery.options.endpoint.pairedBoxes(scope.vault.persona)).find(box => box.routeId === delivery.destination.routeId)
      if (!alive() || !selected || selected.eventUrl !== delivery.destination.eventUrl || mlsBoxNode(selected) !== delivery.destination.node) throw new Error('The selected private Bothy route changed.')
      const event = await wrapVmlsRevocationRequest(signer, request, delivery.options.random, alive)
      if (!alive()) throw new Error('The requesting account or private permission changed.')
      const saved = await delivery.options.endpoint.resumeKeeperInbox(scope.vault.persona, delivery.destination, alive)
      if (!alive()) throw new Error('The selected private Bothy route changed.')
      await delivery.options.endpoint.depositKeeperInbox(saved, { keeper: frozen.keeper, permission: delivery.permission.permission,
        event, vault: delivery.options.vault, vaultContext: scope.vault, consent: delivery.options.consent, current: alive })
    }
    if (!current()) throw new Error('The requesting account changed.')
    if (!alive()) throw new Error('The request time changed.')
    return this.coordinator.transact(scope.vault.persona, async tx => {
      const state = await mlsStandaloneState(tx, this.now()), record = state.observations.find(item => item.operation === operation)
      if (!record) throw new Error('That standalone revocation request is no longer retained.')
      this.#assertRecord(record, operation, scope.vault.persona)
      if (!record.attempt || record.requestRevision !== attempt.revision || JSON.stringify(record.attempt) !== JSON.stringify(attempt)) throw new Error('The standalone request attempt changed after publication. Check its current state.')
      if (delivery.mode === 'private' && !alive()) throw new Error('The private request or original credential expired before confirmation.')
      record.attempt.confirmed = true
      const journal = await readMlsMembership(tx); journal.standalone = state; await saveMlsMembership(tx, journal)
      return view(record)
    }, delivery.mode === 'private' ? alive : current)
  }

  #scope(): MlsRevocationOutboxContext {
    const scope = this.context()
    if (!scope || !scope.current() || !hex32.test(scope.vault.persona)) throw new Error('Open the requesting persona before using its revocation outbox.')
    return { ...scope, vault: { ...scope.vault } }
  }
  #assertRecord(record: MlsStandaloneObservation, operation: string, sender: string): void {
    if (record.sender !== sender || record.operation !== operation ||
        record.operation !== mlsStandaloneRevocationOperation(record.sender, record.keeper, record.device)) {
      throw new InvalidPersonaRecord('Standalone revocation record binding differs')
    }
  }
  #current(scope: MlsRevocationOutboxContext): boolean {
    const current = this.context()
    return !!current && current.current() && current.vault.principal === scope.vault.principal && current.vault.persona === scope.vault.persona &&
      current.vault.generation === scope.vault.generation && current.vault.revision === scope.vault.revision
  }
}
