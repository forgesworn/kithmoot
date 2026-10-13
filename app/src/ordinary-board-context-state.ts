import { saveBoardContext, type BoardContext } from './board-context.js'
import type { BoardContextCustody } from './board-context-custody.js'
import { memoryDeviceStore, type DeviceStore } from './device-store.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { OrdinaryStateOwner, type OrdinaryScope } from './ordinary-state-owner.js'
import { captureOrdinarySnapshotContext, validateOrdinarySnapshot } from './ordinary-snapshot.js'
import { validateOrdinaryMetadataSnapshot } from './ordinary-metadata-snapshot.js'

const HEX = /^[0-9a-f]{64}$/
const ID = /^[A-Za-z0-9_-]{1,160}$/
function hold(): never { throw new OrdinaryStateHold() }
interface Options {
  browser: OrdinaryStateOwner
  tab: OrdinaryStateOwner
  account: string
  generation: number
  currentGeneration(): number
  currentAccount(): string | undefined
  live(): boolean
  checkClients(): Promise<void>
  stop(): void
}
const snapshot = (store: DeviceStore) => new Map(store.keys().map(n => [n, store.get(n)!]))
function data(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) hold()
  const fields = Reflect.ownKeys(value)
  if (required.some(n => !Object.hasOwn(value,n)) || fields.some(n => typeof n !== 'string' || ![...required,...optional].includes(n))) hold()
  const result: Record<string, unknown> = {}
  for (const n of fields as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value,n)!
    if (!Object.hasOwn(descriptor,'value')) hold()
    result[n] = descriptor.value
  }
  return result
}
function capture(value: BoardContext): BoardContext {
  const row = data(value,['boardId','boardName'],['cardId','project','room'])
  if (typeof row.boardId !== 'string' || typeof row.boardName !== 'string' ||
      row.cardId !== undefined && typeof row.cardId !== 'string') hold()
  const scope = (v: unknown) => {
    const fields = data(v,['id','name'])
    if (typeof fields.id !== 'string' || typeof fields.name !== 'string') hold()
    return { id: fields.id, name: fields.name }
  }
  return { boardId: row.boardId, boardName: row.boardName,
    ...(row.project === undefined ? {} : { project: scope(row.project) }),
    ...(row.room === undefined ? {} : { room: scope(row.room) }) }
}

/** Awaited personal-label custody for a captured account/view. Every operation
 * requires both completed native owners and the full same-image composer.
 * Nothing here restores a signer or grants board/room access. */
export class OrdinaryBoardContextState implements BoardContextCustody {
  readonly #options: Options
  readonly #browserScope: OrdinaryScope
  readonly #tabScope: OrdinaryScope
  readonly #expected = new Map<string, string | null>()
  readonly #work = new Set<Promise<unknown>>()
  #closed = false
  #held = false
  #busy = false
  private constructor(options: Options, browserScope: OrdinaryScope, tabScope: OrdinaryScope) {
    this.#options = options; this.#browserScope = browserScope; this.#tabScope = tabScope
  }
  #live = (): boolean => {
    if (this.#closed || this.#held) return false
    const live = this.#options.live(), generation = this.#options.currentGeneration(), account = this.#options.currentAccount()
    return !this.#closed && !this.#held && live && generation === this.#options.generation && account === this.#options.account
  }
  #check(): void { if (!this.#live()) hold() }
  #stop(): void { if (!this.#held) { this.#held = true; try { this.#options.stop() } catch { /* Held still revokes this view. */ } } }
  #name(boardId: string): string {
    if (typeof boardId !== 'string' || !ID.test(boardId)) hold()
    return `kithmoot.board-context.v1.${this.#options.account}.${boardId}`
  }
  #run<T>(captureInput: () => () => Promise<T>): Promise<T> {
    // Latch before caller getters, client fences or current callbacks.
    if (this.#busy || this.#closed || this.#held) { this.#stop(); return Promise.reject(new OrdinaryStateHold()) }
    this.#busy = true
    let operation: () => Promise<T>
    try { operation = captureInput() } catch (error) { this.#busy = false; this.#stop(); return Promise.reject(error) }
    const pending = Promise.resolve().then(async () => {
      try { this.#check(); await this.#options.checkClients(); this.#check(); const result = await operation(); this.#check(); return result }
      catch (error) { this.#stop(); throw error }
      finally { this.#busy = false }
    })
    this.#work.add(pending); void pending.finally(() => this.#work.delete(pending)).catch(() => {})
    return pending
  }
  #pair() {
    return { browser: { owner: this.#options.browser, scope: this.#browserScope },
      tab: { owner: this.#options.tab, scope: this.#tabScope }, live: this.#live }
  }
  static async open(input: Options): Promise<OrdinaryBoardContextState> {
    const options = { ...input }
    if (!HEX.test(options.account) || !Number.isSafeInteger(options.generation) || options.generation < 0 ||
        options.browser.purpose !== 'browser' || !/^tab:[0-9a-f]{64}$/.test(options.tab.purpose)) hold()
    const live = () => options.live() && options.currentAccount() === options.account && options.currentGeneration() === options.generation
    const name = 'board-context:' + options.account
    let state: OrdinaryBoardContextState | undefined
    try {
      if (!live()) hold(); await options.checkClients(); if (!live()) hold()
      const b = await options.browser.capture(name, live), t = await options.tab.capture(name, live)
      state = new OrdinaryBoardContextState(options,b,t)
      const ready = state
      await ready.#run(() => () => OrdinaryStateOwner.readPairMigrated({ ...ready.#pair(), work: (b,t,_bn,_tn,custody) => {
        const bm = snapshot(b), tm = snapshot(t)
        validateOrdinarySnapshot(bm,tm,{browser:true,tab:true},captureOrdinarySnapshotContext(bm,tm,custody))
      } }))
      return state
    } catch (error) { if (state) state.#stop(); else { try { options.stop() } catch { /* No view may proceed. */ } }; throw error }
  }
  read(boardId: string): Promise<BoardContext | undefined> {
    return this.#run(() => {
      const name = this.#name(boardId)
      return async () => {
        const raw = await OrdinaryStateOwner.readPairMigrated({ ...this.#pair(), work: (b,t,_bn,_tn,custody) => {
          const bm = snapshot(b), tm = snapshot(t)
          validateOrdinarySnapshot(bm,tm,{browser:true,tab:true},captureOrdinarySnapshotContext(bm,tm,custody))
          return b.get(name)
        } })
        this.#check(); this.#expected.set(name,raw)
        return raw === null ? undefined : JSON.parse(raw) as BoardContext
      }
    })
  }
  save(input: BoardContext, current: () => boolean = () => true): Promise<void> {
    return this.#run(() => {
      const value = capture(input), name = this.#name(value.boardId), store = memoryDeviceStore()
      saveBoardContext(store,this.#options.account,value)
      const raw = store.get(name)!
      validateOrdinaryMetadataSnapshot(new Map([[name,raw]]),true,{kind:'browser'})
      if (!this.#expected.has(name)) hold()
      const expected = this.#expected.get(name)!
      if (typeof current !== 'function') hold()
      const live = () => { const selected = this.#live() && current(); return selected && this.#live() }
      return async () => {
        await OrdinaryStateOwner.mutatePairMigrated({ ...this.#pair(), live, work: (b,t,_bn,_tn,custody) => {
          const bm = snapshot(b), tm = snapshot(t)
          validateOrdinarySnapshot(bm,tm,{browser:true,tab:true},captureOrdinarySnapshotContext(bm,tm,custody))
          if (b.get(name) !== expected) hold()
          b.set(name,raw)
          const next = snapshot(b)
          validateOrdinarySnapshot(next,tm,{browser:true,tab:true},captureOrdinarySnapshotContext(next,tm,custody))
        } })
        this.#check(); if (!live()) hold(); this.#expected.set(name,raw)
      }
    })
  }
  revoke(): void { this.#closed = true }
  async close(): Promise<void> { this.revoke(); await Promise.allSettled([...this.#work]); this.#expected.clear() }
}
