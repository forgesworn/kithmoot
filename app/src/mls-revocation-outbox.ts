import { sendVmlsRevocationRequest, VMLS_REVOCATION_REQUEST_SECONDS,
  type VmlsRevocationIdentity, type VmlsRevocationTransport } from '../../src/vmls-revocation-request.js'
import { InvalidPersonaRecord, type CoordinationResult, type BrowserPersonaCoordinator, type PersonaTransaction } from './mls-persona-coordinator.js'
import { mlsStandaloneRevocationOperation, readMlsMembership, saveMlsMembership,
  type MlsStandaloneRevocationRecord } from './mls-membership-store.js'
import { mlsStandaloneState } from './mls-revocation-outbox-state.js'
import { MAX_MLS_STANDALONE_OBSERVATIONS, type MlsStandaloneObservation } from './mls-revocation-outbox-store.js'
import type { VaultContext } from './mls-vault.js'

const hex32 = /^[0-9a-f]{64}$/
const validTime = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

export class MlsRevocationOutboxFull extends Error {}
export interface MlsStandaloneRevocationView extends MlsStandaloneRevocationRecord {
  requestRevision: number
  requestState: 'none' | 'unconfirmed' | 'sent'
  requestExpiration?: number
}
const view = (item: MlsStandaloneObservation): MlsStandaloneRevocationView => ({
  operation: item.operation, sender: item.sender, keeper: item.keeper, device: item.device, sessions: item.sessions.slice(), boxes: item.boxes.slice(),
  createdAt: item.observedAt, sentAt: item.attempt?.confirmed ? item.attempt.createdAt : null, requestRevision: item.requestRevision,
  requestState: item.attempt ? item.attempt.confirmed ? 'sent' : 'unconfirmed' : 'none',
  ...(item.attempt ? { requestExpiration: item.attempt.expiration } : {}),
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

/** Sends retained roster evidence without reopening an MLS session. The
 * persona witness still covers both the source record and the sent marker. */
export class BrowserMlsRevocationOutbox {
  readonly #sending = new Map<string, Promise<CoordinationResult<MlsStandaloneRevocationView>>>()
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

  send(operation: string, options: { identity: VmlsRevocationIdentity; transport: VmlsRevocationTransport; random?: () => number }): Promise<CoordinationResult<MlsStandaloneRevocationView>> {
    return this.#start(operation, options)
  }
  /** A fresh wrap needs an explicit current operator revision. Neither
   * opening the panel nor an ordinary send retries an uncertain attempt. */
  retry(operation: string, revision: number, options: { identity: VmlsRevocationIdentity; transport: VmlsRevocationTransport; random?: () => number }): Promise<CoordinationResult<MlsStandaloneRevocationView>> {
    if (!Number.isSafeInteger(revision) || revision < 1) return Promise.reject(new Error('Check the current request before retrying.'))
    return this.#start(operation, options, revision)
  }
  #start(operation: string, options: { identity: VmlsRevocationIdentity; transport: VmlsRevocationTransport; random?: () => number }, revision?: number): Promise<CoordinationResult<MlsStandaloneRevocationView>> {
    const existing = this.#sending.get(operation)
    if (existing) return existing
    const pending = this.#send(operation, options, revision)
    this.#sending.set(operation, pending)
    void pending.then(() => { if (this.#sending.get(operation) === pending) this.#sending.delete(operation) },
      () => { if (this.#sending.get(operation) === pending) this.#sending.delete(operation) })
    return pending
  }

  async #send(operation: string, options: { identity: VmlsRevocationIdentity; transport: VmlsRevocationTransport; random?: () => number }, revision?: number): Promise<CoordinationResult<MlsStandaloneRevocationView>> {
    if (!hex32.test(operation)) throw new Error('Invalid standalone revocation operation.')
    const scope = this.#scope(), current = () => this.#current(scope)
    if (options.identity.pubkey !== scope.vault.persona) throw new Error('Sign in as the requesting member.')
    const before = await this.coordinator.transact(scope.vault.persona, async tx => {
      const state = await mlsStandaloneState(tx, this.now()), record = state.observations.find(item => item.operation === operation)
      if (!record) throw new Error('That standalone revocation request is no longer retained.')
      this.#assertRecord(record, operation, scope.vault.persona)
      if (revision === undefined && record.attempt) return { record: structuredClone(record), publish: false }
      if (revision !== undefined && revision !== record.requestRevision) throw new Error('The request changed. Check it again before retrying.')
      if (record.requestRevision === Number.MAX_SAFE_INTEGER) throw new Error('The standalone request revision is full.')
      record.requestRevision++
      record.attempt = { revision: record.requestRevision, createdAt: state.checkedAt, expiration: state.checkedAt + VMLS_REVOCATION_REQUEST_SECONDS, confirmed: false }
      const journal = await readMlsMembership(tx); journal.standalone = state; await saveMlsMembership(tx, journal)
      return { record: structuredClone(record), publish: true }
    }, current)
    if (before.state !== 'active') return before
    const frozen = before.value.record
    if (!before.value.publish) return { ...before, value: view(frozen) }
    const attempt = frozen.attempt!, createdAt = attempt.createdAt
    const alive = () => current() && validTime(this.now()) && this.now() >= createdAt && this.now() < attempt.expiration
    const directoryEvents = await options.transport.directory(frozen.keeper)
    if (!current()) throw new Error('The requesting account changed.')
    if (!alive()) throw new Error('The request time changed.')
    await sendVmlsRevocationRequest({ identity: options.identity, request: { sender: frozen.sender, keeper: frozen.keeper,
      device: frozen.device, sessions: frozen.sessions, boxes: frozen.boxes, createdAt, expiration: attempt.expiration }, directoryEvents,
    publish: publication => options.transport.publish(publication), current: alive, random: options.random })
    if (!current()) throw new Error('The requesting account changed.')
    if (!alive()) throw new Error('The request time changed.')
    return this.coordinator.transact(scope.vault.persona, async tx => {
      const state = await mlsStandaloneState(tx, this.now()), record = state.observations.find(item => item.operation === operation)
      if (!record) throw new Error('That standalone revocation request is no longer retained.')
      this.#assertRecord(record, operation, scope.vault.persona)
      if (!record.attempt || record.requestRevision !== attempt.revision || JSON.stringify(record.attempt) !== JSON.stringify(attempt)) throw new Error('The standalone request attempt changed after publication. Check its current state.')
      record.attempt.confirmed = true
      const journal = await readMlsMembership(tx); journal.standalone = state
      await saveMlsMembership(tx, journal)
      return view(record)
    }, current)
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
