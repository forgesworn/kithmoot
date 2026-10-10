import { sendVmlsRevocationRequest, VMLS_REVOCATION_REQUEST_SECONDS,
  type VmlsRevocationIdentity, type VmlsRevocationTransport } from '../../src/vmls-revocation-request.js'
import { InvalidPersonaRecord, type CoordinationResult, type BrowserPersonaCoordinator, type PersonaTransaction } from './mls-persona-coordinator.js'
import { MAX_MLS_STANDALONE_REVOCATIONS, mlsStandaloneRevocationOperation, readMlsMembership, saveMlsMembership,
  type MlsStandaloneRevocationRecord } from './mls-membership-store.js'
import type { VaultContext } from './mls-vault.js'

const hex32 = /^[0-9a-f]{64}$/
const validTime = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

export class MlsRevocationOutboxFull extends Error {}

interface ObservedMember { identity: string; device: string; homeBox: string; own: boolean; pending: boolean }

/** Retain only same-person, non-local, committed roster devices. This runs in
 * the same witnessed transaction as the genuine engine roster read. */
export async function rememberStandaloneRevocations(tx: PersonaTransaction, sender: string, keeper: string | undefined,
  session: string, members: readonly ObservedMember[], createdAt: number): Promise<void> {
  if (!hex32.test(sender) || !hex32.test(session) || !validTime(createdAt)) throw new Error('Invalid standalone revocation observation.')
  if (!keeper || !hex32.test(keeper) || keeper === sender) return
  const journal = await readMlsMembership(tx)
  let changed = false
  const devices = new Map<string, Set<string>>()
  for (const member of members) if (member.identity === sender && !member.own && !member.pending) {
    if (!hex32.test(member.device) || !hex32.test(member.homeBox)) throw new InvalidPersonaRecord('Invalid standalone revocation roster evidence')
    const boxes = devices.get(member.device) ?? new Set<string>(); boxes.add(member.homeBox); devices.set(member.device, boxes)
  }
  for (const [device, observedBoxes] of [...devices].sort(([a], [b]) => a.localeCompare(b))) {
    const operation = mlsStandaloneRevocationOperation(sender, keeper, device), saved = journal.requests.find(item => item.operation === operation)
    if (saved && (saved.sender !== sender || saved.keeper !== keeper || saved.device !== device)) throw new InvalidPersonaRecord('Standalone revocation record binding differs')
    const sessions = [...new Set([...(saved?.sessions ?? []), session])].sort()
    const boxes = [...new Set([...(saved?.boxes ?? []), ...observedBoxes])].sort()
    if (sessions.length > 64 || boxes.length > 64) throw new MlsRevocationOutboxFull('The standalone revocation record is full.')
    if (saved) {
      if (JSON.stringify(saved.sessions) !== JSON.stringify(sessions) || JSON.stringify(saved.boxes) !== JSON.stringify(boxes)) {
        saved.sessions = sessions; saved.boxes = boxes; saved.sentAt = null; changed = true
      }
    } else {
      if (journal.requests.length >= MAX_MLS_STANDALONE_REVOCATIONS) throw new MlsRevocationOutboxFull('The standalone revocation outbox is full.')
      journal.requests.push({ operation, sender, keeper, device, sessions, boxes, createdAt, sentAt: null }); changed = true
    }
  }
  if (changed) {
    journal.requests.sort((a, b) => a.operation.localeCompare(b.operation))
    await saveMlsMembership(tx, journal)
  }
}

export interface MlsRevocationOutboxContext { vault: VaultContext; current(): boolean }
type Coordinator = Pick<BrowserPersonaCoordinator, 'transact'>

/** Sends retained roster evidence without reopening an MLS session. The
 * persona witness still covers both the source record and the sent marker. */
export class BrowserMlsRevocationOutbox {
  readonly #sending = new Map<string, Promise<CoordinationResult<MlsStandaloneRevocationRecord>>>()
  constructor(private coordinator: Coordinator, private context: () => MlsRevocationOutboxContext | undefined,
    private now: () => number = () => Math.floor(Date.now() / 1000)) {}

  async records(): Promise<CoordinationResult<MlsStandaloneRevocationRecord[]>> {
    const scope = this.#scope()
    return this.coordinator.transact(scope.vault.persona, async tx => {
      const records = (await readMlsMembership(tx)).requests
      for (const record of records) this.#assertRecord(record, record.operation, scope.vault.persona)
      return structuredClone(records)
    }, () => this.#current(scope))
  }

  send(operation: string, options: { identity: VmlsRevocationIdentity; transport: VmlsRevocationTransport; random?: () => number }): Promise<CoordinationResult<MlsStandaloneRevocationRecord>> {
    const existing = this.#sending.get(operation)
    if (existing) return existing
    const pending = this.#send(operation, options)
    this.#sending.set(operation, pending)
    void pending.then(() => { if (this.#sending.get(operation) === pending) this.#sending.delete(operation) },
      () => { if (this.#sending.get(operation) === pending) this.#sending.delete(operation) })
    return pending
  }

  async #send(operation: string, options: { identity: VmlsRevocationIdentity; transport: VmlsRevocationTransport; random?: () => number }): Promise<CoordinationResult<MlsStandaloneRevocationRecord>> {
    if (!hex32.test(operation)) throw new Error('Invalid standalone revocation operation.')
    const scope = this.#scope(), current = () => this.#current(scope)
    if (options.identity.pubkey !== scope.vault.persona) throw new Error('Sign in as the requesting member.')
    const before = await this.coordinator.transact(scope.vault.persona, async tx => {
      const record = (await readMlsMembership(tx)).requests.find(item => item.operation === operation)
      if (!record) throw new Error('That standalone revocation request is no longer retained.')
      this.#assertRecord(record, operation, scope.vault.persona)
      return structuredClone(record)
    }, current)
    if (before.state !== 'active' || before.value.sentAt !== null) return before
    const createdAt = this.now()
    if (!validTime(createdAt) || createdAt < before.value.createdAt) throw new Error('A trusted request time is unavailable.')
    const directoryEvents = await options.transport.directory(before.value.keeper)
    if (!current()) throw new Error('The requesting account changed.')
    await sendVmlsRevocationRequest({ identity: options.identity, request: { sender: before.value.sender, keeper: before.value.keeper,
      device: before.value.device, sessions: before.value.sessions, boxes: before.value.boxes, createdAt,
      expiration: createdAt + VMLS_REVOCATION_REQUEST_SECONDS }, directoryEvents,
    publish: publication => options.transport.publish(publication), current, random: options.random })
    if (!current()) throw new Error('The requesting account changed.')
    return this.coordinator.transact(scope.vault.persona, async tx => {
      const journal = await readMlsMembership(tx), record = journal.requests.find(item => item.operation === operation)
      if (!record) throw new Error('That standalone revocation request is no longer retained.')
      this.#assertRecord(record, operation, scope.vault.persona)
      if (record.sentAt !== null) return structuredClone(record)
      if (JSON.stringify(record) !== JSON.stringify(before.value)) throw new Error('The standalone revocation request changed after it was sent. Retry the current record.')
      record.sentAt = createdAt
      await saveMlsMembership(tx, journal)
      return structuredClone(record)
    }, current)
  }

  #scope(): MlsRevocationOutboxContext {
    const scope = this.context()
    if (!scope || !scope.current() || !hex32.test(scope.vault.persona)) throw new Error('Open the requesting persona before using its revocation outbox.')
    return scope
  }
  #assertRecord(record: MlsStandaloneRevocationRecord, operation: string, sender: string): void {
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
