import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { BrowserPersonaCoordinator, InvalidPersonaRecord, type CoordinationFence, type CoordinationHold, type PersonaMlsWitness, type PersonaTransaction } from './mls-persona-coordinator.js'

/** The shared WASM Session implements this surface. The opener must return
 * a fresh handle and must never retain the supplied plaintext. */
export interface HostedMlsSession {
  id(): Uint8Array
  ackedGeneration(): bigint
  generation(): bigint
  commitAck(generation: bigint, highWater: bigint): void
  free(): void
}
export interface MlsStepSnapshot { session: Uint8Array; generation: bigint; plaintext: Uint8Array }
/** Ownership of snapshot and value transfers to the host. Value must be a
 * structured-cloneable data tree, with secret bytes in Uint8Arrays. */
export interface HostedMlsStep<T> { snapshot: MlsStepSnapshot | null; value: T }
export type HostedMlsResult<T> = CoordinationHold | CoordinationFence | { state: 'unknown' } | { state: 'active'; value: T }
/** Local-only edits under the same transaction as the engine snapshot. */
export interface MlsSessionEdits<S, T> {
  validate?(tx: PersonaTransaction): Promise<void>
  before?(tx: PersonaTransaction, session: S): Promise<void>
  persist?(tx: PersonaTransaction, session: S, value: T): Promise<void>
}
export class StaleMlsOperation extends Error {}
export interface MlsSessionContext { persona: string; current(): boolean }
const ADOPTED_IDS = '6d6c732d73657373696f6e2d696473' // mls-session-ids, one covered vault record
const stale = (): CoordinationHold => ({ state: 'pending', reason: 'stale', refused: false })
const checkId = (id: string) => { if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Invalid MLS session id'); return id }

/** The browser's session persistence boundary. No live handles are cached:
 * each operation freshly reconciles the witness, opens at the exact manifest
 * generation, and frees its handle before returning. signedStep owns a bounded private
 * pending handle across consent, then revalidates its exact predecessor in a
 * second transaction. Prepared creation is completed only inside create().
 *
 * Callbacks are trusted synchronous engine code. They must not publish, use
 * the vault recursively, retain the handle or return plaintext elsewhere.
 * Network and display consumers may use only an active result. A held step's
 * durable outbox is recovered by a later step, never by replaying its effects.
 * Production room wiring remains gated separately.
 */
export class BrowserMlsSessionHost<S extends HostedMlsSession> {
  #epoch = 0
  #pending = new Set<() => void>()
  constructor(private readonly coordinator: BrowserPersonaCoordinator,
    private readonly open: (id: Uint8Array, plaintext: Uint8Array, highWater: bigint) => S) {}

  /** Account, room or privacy transitions suppress even an already promoted
   * operation's late result. No idle engine or plaintext survives a call. */
  invalidate(): void { this.#epoch++; this.coordinator.invalidate(); for (const cancel of this.#pending) cancel() }

  step<T>(context: MlsSessionContext, id: string, call: (session: S) => HostedMlsStep<T>, edits: MlsSessionEdits<S, T> = {}): Promise<HostedMlsResult<T>> {
    checkId(id)
    return this.#run(context, async tx => {
      const saved = await tx.readSession(id)
      if (!saved) return undefined
      let session: S | undefined
      try {
        session = this.open(hexToBytes(id), saved.plaintext, saved.generation)
        if (bytesToHex(session.id()) !== id || session.generation() !== saved.generation) throw new Error('MLS session does not match witnessed generation')
        return { session, previous: saved.generation, call: () => call(session!) }
      } catch (error) { session?.free(); throw error }
      finally { saved.plaintext.fill(0) }
    }, edits)
  }

  /** A new engine session is adopted explicitly. A duplicate id never
   * overwrites an existing session, including a reconciled uncertain create. */
  create<T>(context: MlsSessionContext, call: () => { session: S; step: HostedMlsStep<T> }, edits: MlsSessionEdits<S, T> = {}): Promise<HostedMlsResult<T>> {
    return this.#run(context, async tx => {
      const created = call()
      try {
        const id = checkId(bytesToHex(created.session.id()))
        if (created.session.generation() !== 1n || created.session.ackedGeneration() !== 0n) throw new Error('MLS adoption requires a fresh unacknowledged session')
        const saved = await tx.readSession(id)
        if (saved) { saved.plaintext.fill(0); throw new Error('MLS session already exists') }
        const used = await adoptedIds(tx)
        if (used.includes(id)) throw new Error('MLS session id has already been used')
        if (used.length >= 1024) throw new Error('MLS session history is full')
        const encoded = new TextEncoder().encode(JSON.stringify({ version: 1, ids: [...used, id] }))
        try { await tx.putVault(ADOPTED_IDS, encoded) } finally { encoded.fill(0) }
        return { session: created.session, previous: 0n, call: () => created.step }
      } catch (error) {
        try { created.session.free() } finally { created.step.snapshot?.plaintext.fill(0); wipe(created.step.value) }
        throw error
      }
    }, edits)
  }

  /** Own one pending engine operation across a typed signer await. Phase two
   * opens no stale cached authority: it fresh-reads the witness and compares
   * the exact predecessor bytes and generation before using this handle.
   * Request/answer callbacks are trusted; no handle leaves this method. */
  async signedStep<Q extends { expiresAt: bigint }, A, T>(context: MlsSessionContext, id: string,
    prepare: (session: S) => Q, sign: (request: Q) => Promise<A>,
    complete: (session: S, request: Q, answer: A) => HostedMlsStep<T>,
    edits: MlsSessionEdits<S, T>, now: () => number = () => Math.floor(Date.now() / 1000)): Promise<HostedMlsResult<T>> {
    checkId(id)
    const current = this.#current(context)
    let owned: S | undefined, request: Q | undefined, digest = '', generation = 0n, ended = false
    let timer: ReturnType<typeof setTimeout> | undefined, wake!: () => void
    let cleanupFailure: { error: unknown } | undefined
    const cancelled = new Promise<{ cancelled: true }>(resolve => { wake = () => resolve({ cancelled: true }) })
    const cancel = () => {
      ended = true
      const closing = owned; owned = undefined
      try { closing?.free() } catch (error) { cleanupFailure ??= { error } } finally { wake() }
    }
    this.#pending.add(cancel)
    const live = () => !ended && current() && (!request || BigInt(now()) <= request.expiresAt)
    try {
      const initial = await this.coordinator.transact(context.persona, async tx => {
        await edits.validate?.(tx)
        const saved = await tx.readSession(id)
        if (!saved) return false
        try {
          digest = bytesToHex(sha256(saved.plaintext)); generation = saved.generation
          owned = this.open(hexToBytes(id), saved.plaintext, generation)
          if (bytesToHex(owned.id()) !== id || owned.generation() !== generation) throw new Error('MLS pending predecessor mismatch')
          await edits.before?.(tx, owned)
          if (!live()) throw new StaleMlsOperation()
          request = prepare(owned)
          if (owned.generation() !== generation || bytesToHex(owned.id()) !== id) throw new Error('MLS preparation changed durable state')
          const remaining = Number(request.expiresAt) - now()
          if (!Number.isSafeInteger(remaining) || remaining < 0 || remaining > 600) throw new StaleMlsOperation()
          timer = setTimeout(cancel, (remaining + 1) * 1000)
          return true
        } finally { saved.plaintext.fill(0) }
      }, live)
      if (initial.state !== 'active') return initial
      if (!initial.value) return { state: 'unknown' }
      if (!live() || !request) return stale()
      const answer = await Promise.race([sign(request).then(answer => ({ answer })), cancelled])
      if ('cancelled' in answer || !live() || !owned) return stale()
      // From here cancellation only invalidates release. The normal host owns
      // and frees the handle, even while persistence/network awaits.
      const session = owned; owned = undefined
      let transferred = false
      try {
        return await this.#run({ persona: context.persona, current: live }, async tx => {
          const saved = await tx.readSession(id)
          if (!saved) throw new StaleMlsOperation()
          try {
            if (saved.generation !== generation || bytesToHex(sha256(saved.plaintext)) !== digest) throw new StaleMlsOperation()
          } finally { saved.plaintext.fill(0) }
          transferred = true
          return { session, previous: generation, call: () => {
            if (!live()) throw new StaleMlsOperation()
            return complete(session, request!, answer.answer)
          } }
        }, edits)
      } finally {
        // #run frees an adopted handle. If it held before its callback or the
        // predecessor changed, this method still owns it.
        if (!transferred) session.free()
      }
    } catch (error) {
      if (error instanceof StaleMlsOperation) return stale()
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.#pending.delete(cancel)
      cancel()
      wipe(request)
      if (cleanupFailure) throw cleanupFailure.error
    }
  }

  async drop(context: MlsSessionContext, id: string): Promise<HostedMlsResult<void>> {
    checkId(id)
    const current = this.#current(context)
    const result = await this.coordinator.transact(context.persona, async tx => {
      const saved = await tx.readSession(id)
      if (!saved) return false
      saved.plaintext.fill(0)
      await tx.dropSession(id)
      return true
    }, current)
    if (!current()) return stale()
    return result.state !== 'active' ? result : result.value ? { state: 'active', value: undefined } : { state: 'unknown' }
  }

  /** Discovery also fresh-reads the witness; there is no cached mark that
   * can authorise reopening a session after a restore or an offline restart. */
  async sessions(context: MlsSessionContext): Promise<HostedMlsResult<ReadonlyMap<string, bigint>>> {
    const current = this.#current(context)
    const result = await this.coordinator.status(context.persona, current)
    if (!current()) return stale()
    return result.state === 'active' ? { state: 'active', value: result.marks } : result
  }

  /** Read a live session together with the reconciled coordinator and commit
   * local vault edits under the same witness advance. The callback receives
   * no raw Coordinator and its witness capability expires on return. */
  async witnessed<T>(context: MlsSessionContext, id: string,
    call: (session: S, witness: PersonaMlsWitness, tx: PersonaTransaction) => Promise<T> | T): Promise<HostedMlsResult<T>> {
    checkId(id)
    const current = this.#current(context)
    let session: S | undefined, value: T | undefined, released = false
    try {
      const result = await this.coordinator.transact(context.persona, async (tx, witness) => {
        if (!current()) throw new StaleMlsOperation()
        const saved = await tx.readSession(id)
        if (!saved) return false
        try {
          session = this.open(hexToBytes(id), saved.plaintext, saved.generation)
          if (bytesToHex(session.id()) !== id || session.generation() !== saved.generation) throw new Error('MLS session does not match witnessed generation')
          const provisional = await call(session, witness, tx)
          try { value = structuredClone(provisional) } finally { wipe(provisional) }
          if (bytesToHex(session.id()) !== id || session.generation() !== saved.generation) throw new Error('Witnessed MLS read changed durable state')
          return true
        } finally { saved.plaintext.fill(0) }
      }, current)
      const closing = session; session = undefined; closing?.free()
      if (!current()) return stale()
      if (result.state !== 'active') return result
      if (!result.value) return { state: 'unknown' }
      released = true
      return { state: 'active', value: value as T }
    } catch (error) {
      if (error instanceof StaleMlsOperation) return stale()
      throw error
    } finally {
      try { session?.free() } finally { if (!released) wipe(value) }
    }
  }

  #current(context: MlsSessionContext): () => boolean {
    const epoch = this.#epoch, current = context.current
    return () => this.#epoch === epoch && current()
  }

  async #run<T>(context: MlsSessionContext, prepare: (tx: PersonaTransaction) => Promise<{
    session: S; previous: bigint; call(): HostedMlsStep<T>
  } | undefined>, edits: MlsSessionEdits<S, T> = {}): Promise<HostedMlsResult<T>> {
    const current = this.#current(context)
    let session: S | undefined, step: HostedMlsStep<T> | undefined, value: T | undefined
    let id: string | undefined, generation: bigint | undefined, acknowledged = false, released = false
    try {
      const result = await this.coordinator.transact(context.persona, async tx => {
        await edits.validate?.(tx)
        if (!current()) throw new StaleMlsOperation()
        const prepared = await prepare(tx)
        if (!prepared) return false
        session = prepared.session
        id = checkId(bytesToHex(session.id()))
        await edits.before?.(tx, session)
        if (!current()) throw new StaleMlsOperation()
        step = prepared.call()
        const snapshot = step.snapshot
        generation = session.generation()
        if (bytesToHex(session.id()) !== id) throw new Error('MLS session id changed')
        if (snapshot) {
          try {
            if (bytesToHex(snapshot.session) !== id || snapshot.generation !== generation || generation <= prepared.previous) throw new Error('MLS step has no matching next snapshot')
            await tx.putSession(id, generation, snapshot.plaintext)
          } finally { snapshot.plaintext.fill(0) }
        } else if (prepared.previous === 0n || generation !== prepared.previous) throw new Error('MLS session changed without a snapshot')
        // Detach the eventual result from engine buffers and the sealed
        // snapshot. This copy remains private until all cleanup succeeds.
        await edits.persist?.(tx, session, step.value)
        value = structuredClone(step.value)
        return true
      }, current, marks => {
        if (!session) return
        if (id === undefined || generation === undefined || marks.get(id) !== generation) throw new Error('MLS generation was not witnessed')
        session.commitAck(generation, generation)
        acknowledged = true
        return undefined
      })
      // Free before any successful return. A free/cleanup failure withholds
      // the copied value too; the durable predecessor is reopened next time.
      const closing = session; session = undefined; closing?.free()
      if (!current()) return stale()
      if (result.state !== 'active') return result
      if (!result.value) return { state: 'unknown' }
      if (!acknowledged) throw new Error('MLS step was not acknowledged')
      released = true
      return { state: 'active', value: value as T }
    } catch (error) {
      if (error instanceof StaleMlsOperation) return stale()
      throw error
    } finally {
      try { session?.free() } finally {
        step?.snapshot?.plaintext.fill(0)
        wipe(step?.value)
        if (!released) wipe(value)
      }
    }
  }
}

/** Engine result objects contain byte arrays, arrays and plain objects. Do
 * not serialise secret payloads to strings while they are still provisional. */
function wipe(value: unknown, seen = new Set<object>()): void {
  if (value instanceof Uint8Array) { value.fill(0); return }
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (value instanceof Map) for (const [k, v] of value) { wipe(k, seen); wipe(v, seen) }
  else if (value instanceof Set) for (const v of value) wipe(v, seen)
  else for (const v of Object.values(value)) wipe(v, seen)
}

async function adoptedIds(tx: PersonaTransaction): Promise<string[]> {
  const bytes = await tx.readVault(ADOPTED_IDS)
  if (!bytes) return []
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (value?.version !== 1 || Object.keys(value).sort().join(',') !== 'ids,version' ||
        !Array.isArray(value.ids) || value.ids.length > 1024 ||
        value.ids.some((id: unknown) => typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) ||
        new Set(value.ids).size !== value.ids.length) throw new Error('invalid')
    return value.ids
  } catch { throw new InvalidPersonaRecord('Invalid MLS session history') }
  finally { bytes.fill(0) }
}
