import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import type { Coordinator, Staged } from '../public/vmls-wasm/vmls_wasm.js'
import { loadMlsEngine } from './mls-engine.js'
import { BrowserMlsPersonaStore, PersonaStorageError, personaManifest,
  type LockedPersonaStore, type PersonaSnapshot, type PersonaObjects, type PersonaWitnessRoute } from './mls-persona-store.js'
import type { WitnessChannel, WitnessAnswer } from './mls-witness-link.js'

export type CoordinationHold = { state: 'pending'; reason: 'not-enrolled' | 'witness-unavailable' | 'stale'; refused: boolean }
export type CoordinationFence = { state: 'fenced'; reason: string; subject: string | null; retiring: boolean }
export type CoordinationResult<T> = CoordinationHold | CoordinationFence | { state: 'active'; value: T; marks: ReadonlyMap<string, bigint> }
/** The provider must use the persona's dedicated writer, never the account's
 * ordinary Link engine. Copy the seed into the engine before returning: this
 * temporary copy is wiped. A missing route or unavailable mode yields null.
 * One channel lives for the operation and is closed under the persona lock. */
export type PersonaWitnessChannels = (persona: string, seed: Uint8Array, route: PersonaWitnessRoute | null, current: () => boolean) => Promise<WitnessChannel | null>
export interface PersonaTransaction {
  readVault(id: string): Promise<Uint8Array | undefined>
  putVault(id: string, value: Uint8Array): Promise<void>
  readSession(id: string): Promise<{ generation: bigint; plaintext: Uint8Array } | undefined>
  putSession(id: string, generation: bigint, value: Uint8Array): Promise<void>
  dropVault(id: string): Promise<void>
  dropSession(id: string): Promise<void>
}
type Engine = Awaited<ReturnType<typeof loadMlsEngine>>
type Mark = { session: Uint8Array; generation: bigint }
type Decision = { type: 'active' | 'held' | 'resend' | 'promote' | 'fenced' | 'retireDue' | 'retired'; reason?: string }
const pending = (reason: CoordinationHold['reason'] = 'witness-unavailable', refused = false): CoordinationHold => ({ state: 'pending', reason, refused })
const code = (error: unknown): string | undefined => (error as { code?: string } | null)?.code
const broken = (error: unknown) => error instanceof PersonaStorageError && ['seal-lost', 'missing-record', 'invalid'].includes(error.code)

/** Platform orchestration only: all witness validation and decisions remain
 * in the shared Rust coordinator. Every call reopens actual durable state and
 * fresh-reads the witness under the persona lock. No confirmed-state cache.
 * A failed persistence discards the engine; the next call reconciles from disk.
 */
export class BrowserPersonaCoordinator {
  constructor(private readonly store: BrowserMlsPersonaStore, private readonly channels: PersonaWitnessChannels,
    private readonly engine: () => Promise<Engine> = loadMlsEngine) {}

  status(persona: string, current: () => boolean = () => true): Promise<CoordinationResult<void>> { return this.transact(persona, async () => undefined, current) }

  /** Explicit local replacement. This destroys MLS object keys, not the
   * witness's registration. A known retiring duty keeps only its outer-sealed
   * writer/state/route until a fresh signed retired receipt ends it. */
  async clear(persona: string, current: () => boolean): Promise<CoordinationHold | CoordinationFence> {
    if (!current()) return pending('stale')
    const wasm = await this.engine()
    const outcome = await this.store.withPersona<CoordinationHold | CoordinationFence>(persona, async store => {
      if (!current()) return pending('stale')
      let file: PersonaSnapshot | undefined
      try { file = await store.read(true) } catch (error) {
        if (!broken(error)) throw error
        const marker = await store.fence((error as PersonaStorageError).code)
        // An unreadable outer key has already lost the writer. Preserve the
        // exact subject for explicit keeper recovery; never enrol implicitly.
        // Malformed but readable state may still contain a retiring duty.
        // Keep it for repair; it is not evidence that the writer key is lost.
        if ((error as PersonaStorageError).code !== 'invalid') await store.erase(await store.revision())
        return { state: 'fenced', reason: marker.reason!, subject: marker.subject, retiring: false }
      }
      if (!file) return pending('not-enrolled')
      if (file.data.coordinator === null) {
        await store.fence('cleared')
        await store.supersede(file.revision, null)
        return pending('not-enrolled')
      }
      const platform = makePlatform(wasm)
      let core: Coordinator | undefined
      let run: CoordinationRun | undefined
      try {
        core = openCore(wasm, platform, file)
        run = new CoordinationRun(wasm, core, store, file, this.channels, current)
        return await run.clear()
      } finally { try { await run?.close() } finally { core?.free(); platform.free() } }
    })
    return current() ? outcome : pending('stale')
  }

  /** The keeper's explicit exact-subject assertion, not cryptographic proof.
   * It cannot release a retained retiring duty. A healthy installation must
   * first be cleared/fenced; old subject/installation ids remain tombstoned. */
  async keeperConfirmsRetired(persona: string, subject: string, current: () => boolean): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(subject) || !current()) return false
    const wasm = await this.engine()
    const confirmed = await this.store.withPersona(persona, async store => {
      if (!current()) return false
      const marker = await store.marker()
      if (marker?.state === 'superseded') return marker.retired.some(t => t.subject === subject)
      if (marker?.state !== 'fenced' || marker.subject !== subject) return false
      let file: PersonaSnapshot | undefined
      try { file = await store.read(true) } catch (error) {
        if (!(error instanceof PersonaStorageError) || !['seal-lost', 'missing-record'].includes(error.code)) throw error
      }
      if (file?.data.coordinator) {
        const platform = makePlatform(wasm)
        let core: Coordinator | undefined
        try { core = openCore(wasm, platform, file); if (core.retiring()) return false }
        finally { core?.free(); platform.free() }
      }
      if (!current()) return false
      await store.supersede(await store.revision(), subject)
      return true
    })
    return current() && confirmed
  }

  /** `change` may compute provisional state and effects, but must not publish,
   * acknowledge an engine step or display new plaintext. Only an active result
   * authorises its returned value and exact session marks. All secret buffers
   * opened through the transaction are wiped before returning; copy only the
   * intended result. `current` fences replies from an obsolete account context.
   */
  async transact<T>(persona: string, change: (tx: PersonaTransaction) => Promise<T>, current: () => boolean): Promise<CoordinationResult<T>> {
    if (!current()) return pending('stale')
    const wasm = await this.engine()
    const outcome = await this.store.withPersona<CoordinationResult<T>>(persona, async store => {
      if (!current()) return pending('stale')
      let file: PersonaSnapshot | undefined
      try { file = await store.read(true) } catch (error) {
        if (!broken(error)) throw error
        const marker = await store.fence(error instanceof PersonaStorageError ? error.code : 'invalid')
        return { state: 'fenced', reason: marker.reason!, subject: marker.subject, retiring: false }
      }
      if (!file) return pending('not-enrolled')
      if (file.data.coordinator === null) {
        return file.marker.state === 'fenced' ? { state: 'fenced', reason: file.marker.reason ?? 'invalid', subject: file.marker.subject, retiring: false } : pending('not-enrolled')
      }
      // These placeholder signing/DH ids are never used by the coordinator;
      // this Platform instance supplies only its CSPRNG, not a room identity.
      const platform = makePlatform(wasm)
      let core: Coordinator | undefined
      let run: CoordinationRun | undefined
      try {
        try { core = openCore(wasm, platform, file) }
        catch (error) {
          if (code(error) !== 'CoordinatorMalformed') throw error
          const marker = await store.fence('invalid-coordinator')
          return { state: 'fenced', reason: marker.reason!, subject: marker.subject, retiring: false }
        }
        run = new CoordinationRun(wasm, core, store, file, this.channels, current)
        const ready = await run.reconcile()
        if (ready !== undefined) return ready
        if (!current()) return pending('stale')
        const tx = new Transaction(store, run.file.data.installation, run.file.data.active)
        try {
          const value = await change(tx)
          await tx.finish()
          if (!current()) return pending('stale')
          const held = await run.commit(tx.candidate())
          if (held !== undefined) return held
          if (!current()) return pending('stale')
          return { state: 'active', value, marks: run.marks() }
        } catch (error) {
          if (!(error instanceof PersonaStorageError) || !['seal-lost', 'missing-record'].includes(error.code)) throw error
          return await run.fence((error as PersonaStorageError).code)
        } finally { await tx.dispose() }
      } finally { try { await run?.close() } finally { core?.free(); platform.free() } }
    })
    // Disposal and lock release both await. Recheck after those awaits too,
    // before resolving a successful reply into the app's account context.
    return !current() ? pending('stale') : outcome
  }
}

class CoordinationRun {
  #channel: WitnessChannel | null | undefined
  constructor(private readonly wasm: Engine, private readonly core: Coordinator, private readonly store: LockedPersonaStore,
    public file: PersonaSnapshot, private readonly channels: PersonaWitnessChannels, private readonly current: () => boolean) {}
  async close(): Promise<void> { await this.#channel?.close?.() }
  async #persist(state: Uint8Array = this.core.state(), active = this.file.data.active, staged = this.file.data.staged, cleared = this.file.data.cleared): Promise<void> {
    const coordinator = bytesToHex(state)
    if (coordinator === this.file.data.coordinator && active === this.file.data.active && staged === this.file.data.staged && cleared === this.file.data.cleared) return
    this.file = await this.store.write(this.file.revision, { ...this.file.data, coordinator, active, staged, cleared }, this.file.marker)
  }
  async #exchange(method: 'read' | 'advance', request: Uint8Array): Promise<WitnessAnswer> {
    if (!this.current()) return { type: 'unavailable' }
    try {
      if (this.#channel === undefined) {
        const seed = hexToBytes(this.file.data.writerSeed)
        // A failed start is not retried in this operation. A late start must
        // resolve and be shut down before this writer lock can be released.
        this.#channel = null
        try { this.#channel = await this.channels(this.file.data.persona, seed, structuredClone(this.file.data.witnessRoute), this.current) }
        finally { seed.fill(0) }
      }
      return this.#channel && this.current() ? await this.#channel[method](request) : { type: 'unavailable' }
    } catch { return { type: 'unavailable' } }
  }
  async reconcile(): Promise<CoordinationHold | CoordinationFence | undefined> {
    // A crash between the durable clear intent and key destruction cannot
    // leave a healthy-looking old file usable after reopen.
    if (this.file.marker.reason === 'cleared' && !this.file.data.cleared) return this.clear()
    // open() can itself fence altered durable objects. If a missing key also
    // prevents sealing that state, its independently retained marker fences.
    try { await this.#persist() } catch (error) { if (!broken(error)) throw error; return this.fence((error as PersonaStorageError).code) }
    if (this.file.marker.state === 'fenced' || this.core.fenced() || this.file.data.cleared) {
      if (this.file.data.cleared && !this.core.fenced()) { this.core.installationReplaced(); await this.#persist() }
      await this.#retiring()
      if (this.file.data.cleared && !this.core.retiring()) {
        await this.store.supersede(this.file.revision, this.file.marker.subject)
        return pending('not-enrolled')
      }
      return this.fence(this.file.marker.reason ?? this.core.fenced() ?? 'installation-replaced')
    }
    // Key presence alone cannot detect a substituted CryptoKey. Open every
    // named object and discard its plaintext before authorising new mutations.
    try { if (!await this.store.hasInnerKey()) throw new PersonaStorageError('seal-lost'); await this.#checkSeals(this.file.data.active); if (this.file.data.staged) await this.#checkSeals(this.file.data.staged) }
    catch (error) { if (!broken(error)) throw error; return this.fence((error as PersonaStorageError).code) }
    const decision: Decision = this.core.onRead(await this.#exchange('read', this.core.read()))
    await this.#persist()
    return this.#act(decision)
  }
  async clear(): Promise<CoordinationHold | CoordinationFence> {
    this.file.marker = await this.store.fence('cleared')
    this.core.installationReplaced()
    if (!this.core.retiring()) {
      await this.store.erase(this.file.revision)
      return { state: 'fenced', reason: this.file.marker.reason!, subject: this.file.marker.subject, retiring: false }
    }
    await this.#persist(this.core.state(), { vault: [], sessions: [] }, null, true)
    await this.#retiring()
    if (!this.core.retiring()) {
      await this.store.supersede(this.file.revision, this.file.marker.subject)
      return pending('not-enrolled')
    }
    return this.fence(this.file.marker.reason ?? 'cleared')
  }
  async #checkSeals(objects: PersonaObjects): Promise<void> {
    for (const record of objects.vault) (await this.store.openObject(this.file.data.installation, record.id, record.sealed)).fill(0)
    for (const session of objects.sessions) (await this.store.openSession(this.file.data.installation, session.id, session.generation, session.sealed)).fill(0)
  }
  async #act(decision: Decision): Promise<CoordinationHold | CoordinationFence | undefined> {
    switch (decision.type) {
      case 'active':
        if (this.file.data.staged !== null) return this.fence('unexpected-stage')
        this.marks()
        return undefined
      case 'resend': {
        const reply: Decision = this.core.onAdvance(await this.#exchange('advance', this.core.resend()))
        await this.#persist()
        // A verified conflict can ask for a retry; leave it held for the next
        // foreground pass instead of recursively spinning on the network.
        return reply.type === 'resend' ? pending() : this.#act(reply)
      }
      case 'promote': {
        const candidate = this.file.data.staged
        if (!candidate) return this.fence('stage-corrupt')
        const promotion = this.core.promote()
        try {
          await this.#persist(promotion.state(), candidate, null)
          const marks: Mark[] = this.core.promoted(promotion)
          this.#checkMarks(marks)
        } finally { promotion.free() }
        return undefined
      }
      case 'fenced':
        await this.#retiring()
        return this.fence(decision.reason ?? this.core.fenced() ?? 'invalid')
      default: return pending('witness-unavailable', this.core.refused())
    }
  }
  async commit(objects: PersonaObjects): Promise<CoordinationHold | CoordinationFence | undefined> {
    // A read-only check must not attempt a new stage (in particular at the
    // sequence limit). Record ordering is not part of the canonical manifest.
    if (sameObjects(objects, this.file.data.active)) return undefined
    let stage: Staged
    try { stage = this.core.stage(personaManifest(objects, this.wasm.coordinatorObjectHash)) }
    catch (error) {
      if (code(error) === 'Unchanged') return undefined
      if (code(error) === 'SequenceExhausted') { await this.#persist(); return this.fence(this.core.fenced() ?? 'sequence-exhausted') }
      throw error
    }
    let request: Uint8Array
    try {
      await this.#persist(stage.state(), this.file.data.active, objects)
      request = this.core.staged(stage)
    } finally { stage.free() }
    const decision: Decision = this.core.onAdvance(await this.#exchange('advance', request))
    await this.#persist()
    return this.#act(decision)
  }
  marks(): ReadonlyMap<string, bigint> {
    const marks: Mark[] = this.core.sessionMarks()
    this.#checkMarks(marks)
    return new Map(marks.map(m => [bytesToHex(m.session), m.generation]))
  }
  #checkMarks(marks: Mark[]): void {
    const stored = new Map(this.file.data.active.sessions.map(s => [s.id, BigInt(s.generation)]))
    if (marks.length !== stored.size || new Set(marks.map(m => bytesToHex(m.session))).size !== marks.length || marks.some(m => stored.get(bytesToHex(m.session)) !== m.generation)) throw new PersonaStorageError('invalid')
  }
  async #retiring(): Promise<void> {
    if (!this.core.retiring()) return
    const request: Uint8Array | undefined = this.core.retiringRead()
    if (!request) return
    const decision: Decision = this.core.onRetiringRead(await this.#exchange('read', request))
    await this.#persist()
    if (decision.type === 'retireDue') {
      const advance: Uint8Array | undefined = this.core.retiringAdvance()
      if (advance) { this.core.onRetiring(await this.#exchange('advance', advance)); await this.#persist() }
    }
  }
  async fence(reason: string): Promise<CoordinationFence> {
    this.file.marker = await this.store.fence(reason)
    return { state: 'fenced', reason: this.file.marker.reason!, subject: this.file.marker.subject, retiring: this.core.retiring() }
  }
}

/** Provisional edits, scoped to one witnessed predecessor. A helper can open
 * plaintext here, but only BrowserPersonaCoordinator may stage or promote it. */
class Transaction implements PersonaTransaction {
  #objects: PersonaObjects
  #open = true
  #pending: Promise<unknown>[] = []
  #tail: Promise<unknown> = Promise.resolve()
  #plaintext = new Set<Uint8Array>()
  constructor(private readonly store: LockedPersonaStore, private readonly installation: string, active: PersonaObjects) { this.#objects = structuredClone(active) }
  #work<T>(work: () => Promise<T>): Promise<T> {
    if (!this.#open) return Promise.reject(new PersonaStorageError('closed'))
    // Preserve call order even if the caller issues two seals before awaiting.
    // Otherwise generation 2's slower encryption could overwrite generation 3.
    const task = this.#tail.then(work)
    this.#tail = task; this.#pending.push(task); void task.catch(() => undefined); return task
  }
  readVault(id: string): Promise<Uint8Array | undefined> {
    return this.#work(async () => { const entry = this.#objects.vault.find(x => x.id === id); if (!entry) return undefined; return this.#keep(await this.store.openObject(this.installation, id, entry.sealed)) })
  }
  putVault(id: string, value: Uint8Array): Promise<void> {
    const copy = value.slice()
    return this.#work(async () => {
      try {
        const old = this.#objects.vault.find(x => x.id === id)
        if (old) { const plain = await this.store.openObject(this.installation, id, old.sealed); try { if (same(plain, copy)) return } finally { plain.fill(0) } }
        const sealed = await this.store.sealObject(this.installation, id, copy)
        this.#objects.vault = [...this.#objects.vault.filter(x => x.id !== id), { id, sealed }]
      } finally { copy.fill(0) }
    }).finally(() => copy.fill(0))
  }
  readSession(id: string): Promise<{ generation: bigint; plaintext: Uint8Array } | undefined> {
    return this.#work(async () => { const entry = this.#objects.sessions.find(x => x.id === id); if (!entry) return undefined; return { generation: BigInt(entry.generation), plaintext: this.#keep(await this.store.openSession(this.installation, id, entry.generation, entry.sealed)) } })
  }
  putSession(id: string, generation: bigint, value: Uint8Array): Promise<void> {
    const copy = value.slice()
    return this.#work(async () => {
      try {
        const previous = this.#objects.sessions.find(x => x.id === id)
        if (generation <= 0n || generation > 0x7fffffffffffffffn || (previous && generation <= BigInt(previous.generation))) throw new PersonaStorageError('invalid')
        const sealed = await this.store.sealSession(this.installation, id, String(generation), copy)
        this.#objects.sessions = [...this.#objects.sessions.filter(x => x.id !== id), { id, generation: String(generation), sealed }]
      } finally { copy.fill(0) }
    }).finally(() => copy.fill(0))
  }
  dropVault(id: string): Promise<void> { return this.#work(async () => { this.#objects.vault = this.#objects.vault.filter(x => x.id !== id) }) }
  dropSession(id: string): Promise<void> { return this.#work(async () => { this.#objects.sessions = this.#objects.sessions.filter(x => x.id !== id) }) }
  #keep(plain: Uint8Array): Uint8Array { this.#plaintext.add(plain); return plain }
  async finish(): Promise<void> { this.#open = false; await Promise.all(this.#pending) }
  candidate(): PersonaObjects { if (this.#open) throw new PersonaStorageError('invalid'); return structuredClone(this.#objects) }
  async dispose(): Promise<void> { this.#open = false; await Promise.allSettled(this.#pending); for (const plain of this.#plaintext) plain.fill(0); this.#plaintext.clear() }
}
function same(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((v, i) => v === b[i]) }
function makePlatform(wasm: Engine) { return new wasm.Platform(new Uint8Array(32), new Uint8Array(32), { fill: n => crypto.getRandomValues(new Uint8Array(n)) }) }
function openCore(wasm: Engine, platform: ReturnType<typeof makePlatform>, file: PersonaSnapshot): Coordinator {
  return wasm.openCoordinator(platform, hexToBytes(file.data.coordinator!), personaManifest(file.data.active, wasm.coordinatorObjectHash), file.data.staged === null ? undefined : personaManifest(file.data.staged, wasm.coordinatorObjectHash))
}
function sameObjects(a: PersonaObjects, b: PersonaObjects): boolean {
  const vault = new Map(b.vault.map(v => [v.id, v.sealed]))
  const sessions = new Map(b.sessions.map(s => [s.id, s]))
  return a.vault.length === b.vault.length && a.sessions.length === b.sessions.length &&
    a.vault.every(v => vault.get(v.id) === v.sealed) &&
    a.sessions.every(s => { const old = sessions.get(s.id); return old?.generation === s.generation && old.sealed === s.sealed })
}
