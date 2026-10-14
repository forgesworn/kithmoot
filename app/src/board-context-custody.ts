import { readBoardContext, saveBoardContext, listBoardContexts, type BoardContext } from './board-context.js'
import type { DeviceStore } from './device-store.js'

/** One account and one view lifetime. Labels never supply membership. */
export interface BoardContextCustody {
  list(): Promise<BoardContext[]>
  read(boardId: string): Promise<BoardContext | undefined>
  save(context: BoardContext, current?: () => boolean): Promise<void>
  revoke(): void
  close(): Promise<void>
}

/** Explicit current-main compatibility path. This remains plaintext and must
 * be replaced at the protected startup mount; it is never a custody fallback. */
export function legacyBoardContextCustody(store: DeviceStore, account: string, current: () => boolean): BoardContextCustody {
  let closed = false
  const work = new Set<Promise<unknown>>()
  const check = () => { if (closed) throw new Error('The board context is no longer current.'); const valid=current(); if (closed || !valid) throw new Error('The board context is no longer current.') }
  const run = <T>(action: () => T): Promise<T> => {
    const pending = Promise.resolve().then(() => { check(); const value = action(); check(); return value })
    work.add(pending); void pending.finally(() => work.delete(pending)).catch(() => {})
    return pending
  }
  return {
    list: () => run(() => listBoardContexts(store,account)),
    read: boardId => run(() => readBoardContext(store, account, boardId)),
    save: (context, selection = () => true) => {
      // Capture the actual writer result before yielding, so later caller
      // edits cannot change which personal labels this operation writes.
      const records = new Map<string, string>()
      try { check(); saveBoardContext({get: n => records.get(n) ?? null, set: (n,v) => {records.set(n,v)}, remove: n => {records.delete(n)}, keys: () => [...records.keys()]}, account, context) }
      catch (error) { return Promise.reject(error) }
      return run(() => { if (!selection()) throw new Error('The board changed before its labels could save.'); check(); for (const [n,v] of records) store.set(n,v) })
    },
    revoke: () => { closed = true },
    close: async () => { closed = true; await Promise.allSettled([...work]) },
  }
}
