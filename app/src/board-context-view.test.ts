import { expect, it, vi } from 'vitest'
import { BoardContextView } from './board-context-view.js'
import { legacyBoardContextCustody, type BoardContextCustody } from './board-context-custody.js'
import { memoryDeviceStore } from './device-store.js'
const context = {boardId:'opaque-board',boardName:'Board'}
it('refuses reentrant revocation inside the current callback before legacy access', async () => {
  const store=memoryDeviceStore();let revoke=false
  const access=legacyBoardContextCustody(store,'a'.repeat(64),()=>{if(revoke)access.revoke();return true})
  const pending=access.save(context);revoke=true
  await expect(pending).rejects.toThrow('no longer current');expect(store.keys()).toEqual([])
  await access.close()
})
const gate = <T>() => {let release!: (value:T) => void; const promise = new Promise<T>(r=>{release=r}); return {promise,release}}
function custody(): BoardContextCustody {
  return {read:vi.fn(async()=>undefined),save:vi.fn(async()=>{}),revoke:vi.fn(),close:vi.fn(async()=>{})}
}
it('serialises writes and joins work during close, while refusing late results', async () => {
  const storage = custody(), blocked = gate<void>(), started = gate<void>()
  const view = new BoardContextView(()=>true,async()=>storage)
  const first = view.run(async s=>{started.release();await blocked.promise;await s.save(context);return context})
  const refused = expect(first).rejects.toThrow('no longer current')
  await started.promise
  const second = view.run(async s=>{await s.save(context)})
  const secondRefused = expect(second).rejects.toThrow('no longer current')
  let ended = false; const closing = view.close().then(()=>{ended=true})
  await Promise.resolve();expect(ended).toBe(false);expect(storage.revoke).toHaveBeenCalled()
  blocked.release();await refused;await secondRefused;await closing
  expect(storage.save).toHaveBeenCalledOnce();expect(storage.close).toHaveBeenCalledOnce();expect(view.pending).toBe(false)
})
it('joins custody returned by a late factory and never starts its queued operation', async () => {
  const storage = custody(), opened = gate<BoardContextCustody>(), started = gate<void>()
  const view = new BoardContextView(()=>true,()=>{started.release();return opened.promise})
  const effect = vi.fn(async()=>{}), pending = view.run(effect)
  const refused = expect(pending).rejects.toThrow('closed before its context opened')
  await started.promise;let ended=false;const closing=view.close().then(()=>{ended=true})
  await Promise.resolve();expect(ended).toBe(false);opened.release(storage);await refused;await closing
  expect(effect).not.toHaveBeenCalled();expect(storage.revoke).toHaveBeenCalledOnce();expect(storage.close).toHaveBeenCalledOnce()
})
it('captures legacy writer bytes before yielding and refuses a changed foreground before plaintext access', async () => {
  const store=memoryDeviceStore();let current=true
  const access=legacyBoardContextCustody(store,'a'.repeat(64),()=>current),value={...context}
  const pending=access.save(value);value.boardName='Changed';await pending
  expect((await access.read(context.boardId))?.boardName).toBe('Board')
  const before=store.keys().map(n=>[n,store.get(n)]), refused=access.save(value);current=false
  await expect(refused).rejects.toThrow('no longer current');expect(store.keys().map(n=>[n,store.get(n)])).toEqual(before)
  await access.close()
})
