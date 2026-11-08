import type { Event } from 'nostr-tools/pure'
import type { NodeMigrationEndpoint, NodeMigrationPreparation, NodeMigrationHistory, NodeMigrationCommit } from '@forgesworn/fold-kit/node-migration'
import { nodeMigrationEndpointId, readNodeMigrationPreparation, readNodeMigrationReady, readNodeMigrationCommit,
  signNodeMigrationReady, signNodeMigrationCommit } from '@forgesworn/fold-kit/node-migration'

export interface NodeMigrationContext {
  room: string; authority: string; epoch: number; destruct: boolean; endsAt?: number
  endpoint: NodeMigrationEndpoint; endpoints: NodeMigrationEndpoint[]
}
export interface NodeMigrationJournal {
  v: 1
  phase: 'preparing' | 'ready' | 'committing' | 'committed' | 'cancelled'
  preparation: Event
  ready: Event[]
  commit?: Event
}
export interface NodeMigrationPorts {
  context(): NodeMigrationContext
  /** This journal belongs to this room and session; writes must be atomic and
   * durable. One controller must own it. Reject storage failures. */
  load(): Promise<unknown>
  save(journal: NodeMigrationJournal): Promise<void>
  /** Gate application writes before staging and keep encrypted migration
   * control publications on an explicit, separate permitted path. */
  freezeSourceWrites(frozen: boolean): void
  /** Obtain this exact device's acknowledged node grant, copy all retained
   * history, and verify its readback before returning. */
  prepareDevice(preparation: NodeMigrationPreparation, current: () => boolean): Promise<{ grant: Event; history: NodeMigrationHistory }>
  /** Evidence must be inside authenticated encrypted room control messages. */
  publishSourceEvidence(event: Event): Promise<void>
  /** Idempotently publish encrypted committed evidence to both routes. Reject
   * an incomplete publication/readback; never report only an enqueued write. */
  publishCommitEvidence(commit: NodeMigrationCommit): Promise<void>
  /** Atomically preserve room identity, keys, archive and policy while saving
   * the pinned node route, then reopen using authenticated node transports.
   * Must be idempotent; a failure keeps the source write gate closed. */
  install(commit: NodeMigrationCommit): Promise<void>
  now(): number
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function check(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason) }
const endpointSet = (values: readonly NodeMigrationEndpoint[]): string => values.map(nodeMigrationEndpointId).sort().join(',')

/** Durable per-client transition engine. It is deliberately independent of
 * UI and storage implementations. No failed/uncertain commit rolls back to
 * public writes. It is not enabled by either app until its ports are wired. */
export class NodeMigrationCoordinator {
  #journal?: NodeMigrationJournal
  #tail: Promise<unknown> = Promise.resolve()
  private constructor(private readonly ports: NodeMigrationPorts, private readonly deviceSk: Uint8Array) {}
  static async open(ports: NodeMigrationPorts, deviceSk: Uint8Array): Promise<NodeMigrationCoordinator> {
    const coordinator = new NodeMigrationCoordinator(ports, deviceSk)
    // A failed read could hide a committed decision. Fence before touching
    // storage, and reopen only when absence is known.
    ports.freezeSourceWrites(true)
    const raw = await ports.load()
    if (raw !== undefined && raw !== null) {
      // An unreadable partial transition is never permission for source writes.
      check(typeof raw === 'object' && !Array.isArray(raw), 'Invalid migration journal')
      const state = raw as NodeMigrationJournal
      check(state.v === 1 && ['preparing', 'ready', 'committing', 'committed', 'cancelled'].includes(state.phase)
        && Array.isArray(state.ready) && state.ready.length <= 16, 'Invalid migration journal')
      const context = ports.context()
      if (state.commit) {
        const committed = coordinator.#savedCommit(state.commit)
        check(committed && committed.preparation.event.id === state.preparation?.id, 'Invalid saved migration commit')
        coordinator.#checkRoom(committed.preparation)
        check(['committing', 'committed'].includes(state.phase), 'Invalid saved migration phase')
      } else {
        check(!['committing', 'committed'].includes(state.phase), 'Missing saved migration commit')
        const savedAt = state.phase === 'cancelled' ? Math.min(ports.now(), state.preparation.created_at + 599) : ports.now()
        check(state.phase !== 'cancelled' || state.ready.length === 0, 'Cancelled migration had readiness')
        const preparation = readNodeMigrationPreparation(state.preparation, savedAt, context.authority)
        check(preparation, 'Migration recovery needs a current decision')
        coordinator.#checkRoom(preparation)
        for (const event of state.ready) check(readNodeMigrationReady(event, preparation, ports.now()), 'Invalid saved migration readiness')
      }
      coordinator.#journal = clone(state)
      if (state.phase === 'cancelled') ports.freezeSourceWrites(false)
    } else ports.freezeSourceWrites(false)
    return coordinator
  }
  get state(): NodeMigrationJournal | undefined { return this.#journal && clone(this.#journal) }
  #serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(run); this.#tail = result.catch(() => {}); return result
  }
  async #save(state: NodeMigrationJournal): Promise<void> { await this.ports.save(clone(state)); this.#journal = clone(state) }
  #savedCommit(event: Event): NodeMigrationCommit | null {
    // An already durable decision does not become a public-room fallback
    // when its network replay window ends. Verify the original signed proof
    // at its decision time; room expiry is still checked against today's clock.
    if (!Number.isSafeInteger(event.created_at) || event.created_at > this.ports.now() + 30) return null
    return readNodeMigrationCommit(event, event.created_at, this.ports.context().authority)
  }
  #checkRoom(preparation: NodeMigrationPreparation): void {
    const context = this.ports.context(), node = preparation.node
    check(node.room === context.room && node.authority === context.authority && node.endsAt === context.endsAt
      && node.existing?.destruct === context.destruct && (node.endsAt === undefined || node.endsAt > this.ports.now()), 'Migration changes existing room identity or policy')
  }
  #current(preparation: NodeMigrationPreparation): boolean {
    try {
      this.#checkRoom(preparation)
      const context = this.ports.context()
      return this.#journal?.preparation.id === preparation.event.id && ['preparing', 'ready'].includes(this.#journal.phase)
        && context.epoch === preparation.epoch && endpointSet(context.endpoints) === endpointSet(preparation.endpoints)
        && preparation.endpoints.some(e => nodeMigrationEndpointId(e) === nodeMigrationEndpointId(context.endpoint))
        && !!readNodeMigrationPreparation(preparation.event, this.ports.now(), context.authority)
    } catch { return false }
  }
  prepare(event: Event, announce = false): Promise<Event> {
    return this.#serial(async () => {
      const context = this.ports.context(), preparation = readNodeMigrationPreparation(event, this.ports.now(), context.authority)
      check(preparation, 'Invalid migration preparation'); this.#checkRoom(preparation)
      check(!this.#journal || this.#journal.preparation.id === event.id, 'Another migration already owns this room session')
      check(!this.#journal || ['preparing', 'ready'].includes(this.#journal.phase), 'Migration already decided')
      if (!this.#journal) await this.#save({ v: 1, phase: 'preparing', preparation: event, ready: [] })
      this.ports.freezeSourceWrites(true)
      check(this.#current(preparation), 'Room membership or epoch changed during migration')
      if (announce) await this.ports.publishSourceEvidence(preparation.event)
      const self = nodeMigrationEndpointId(context.endpoint)
      const saved = this.#journal!.ready.find(raw => {
        const ready = readNodeMigrationReady(raw, preparation, this.ports.now())
        return ready && nodeMigrationEndpointId(ready.endpoint) === self
      })
      if (saved) { await this.ports.publishSourceEvidence(saved); return clone(saved) }
      const prepared = await this.ports.prepareDevice(preparation, () => this.#current(preparation))
      check(this.#current(preparation), 'Room membership or epoch changed during migration')
      const ready = signNodeMigrationReady({ preparation, deviceSk: this.deviceSk, sid: context.endpoint.sid,
        grant: prepared.grant, history: prepared.history, now: this.ports.now() })
      check(ready.pubkey === context.endpoint.device, 'Migration belongs to another device')
      await this.#save({ ...this.#journal!, phase: 'ready', ready: [...this.#journal!.ready, ready] })
      await this.ports.publishSourceEvidence(ready)
      return clone(ready)
    })
  }
  recordReady(event: Event): Promise<void> {
    return this.#serial(async () => {
      const state = this.#journal; check(state && !state.commit && state.phase !== 'cancelled', 'No pending migration')
      const preparation = readNodeMigrationPreparation(state.preparation, this.ports.now(), this.ports.context().authority)
      check(preparation && this.#current(preparation), 'Migration preparation changed')
      const ready = readNodeMigrationReady(event, preparation, this.ports.now()); check(ready, 'Invalid client readiness')
      const id = nodeMigrationEndpointId(ready.endpoint)
      const previous = state.ready.find(e => {
        const value = readNodeMigrationReady(e, preparation, this.ports.now())
        return value && nodeMigrationEndpointId(value.endpoint) === id
      })
      check(!previous || previous.id === event.id, 'Client readiness changed')
      if (!previous) await this.#save({ ...state, ready: [...state.ready, event] })
    })
  }
  commit(authoritySk: Uint8Array): Promise<void> {
    return this.#serial(async () => {
      const state = this.#journal; check(state && state.phase === 'ready' && !state.commit, 'Migration is not ready')
      const preparation = readNodeMigrationPreparation(state.preparation, this.ports.now(), this.ports.context().authority)
      check(preparation && this.#current(preparation), 'Room membership or epoch changed during migration')
      const event = signNodeMigrationCommit({ preparation, authoritySk, ready: state.ready, now: this.ports.now() })
      const commit = readNodeMigrationCommit(event, this.ports.now(), preparation.node.authority)!
      // The decision exists durably before any client can see it. Lost ACKs
      // require retrying this same decision, never reopening public writes.
      await this.#save({ ...state, phase: 'committing', commit: event })
      await this.#finish(commit, true)
    })
  }
  receiveCommit(event: Event): Promise<void> {
    return this.#serial(async () => {
      const committed = readNodeMigrationCommit(event, this.ports.now(), this.ports.context().authority)
      check(committed, 'Invalid migration commit'); this.#checkRoom(committed.preparation)
      check(!this.#journal || this.#journal.preparation.id === committed.preparation.event.id, 'Conflicting migration commit')
      await this.#save({ v: 1, phase: 'committing', preparation: committed.preparation.event, ready: committed.ready.map(r => r.event), commit: event })
      this.ports.freezeSourceWrites(true)
      await this.#finish(committed, false)
    })
  }
  resumeCommit(republish: boolean): Promise<void> {
    return this.#serial(async () => {
      check(this.#journal?.commit, 'No saved migration commit')
      const committed = this.#savedCommit(this.#journal.commit)
      check(committed, 'Saved migration commit expired'); this.#checkRoom(committed.preparation)
      this.ports.freezeSourceWrites(true)
      await this.#finish(committed, republish)
    })
  }
  async #finish(commit: NodeMigrationCommit, republish: boolean): Promise<void> {
    if (republish) await this.ports.publishCommitEvidence(commit)
    await this.ports.install(commit)
    await this.#save({ ...this.#journal!, phase: 'committed' })
    // This gate stays closed forever: install owns the new private route.
  }
  cancelBeforeReady(): Promise<void> {
    return this.#serial(async () => {
      check(this.#journal?.phase === 'preparing' && this.#journal.ready.length === 0, 'An acknowledged migration needs a shared decision')
      await this.#save({ ...this.#journal, phase: 'cancelled' })
      this.ports.freezeSourceWrites(false)
    })
  }
}
