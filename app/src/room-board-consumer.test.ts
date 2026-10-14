import {afterEach,describe,it,expect,vi} from 'vitest'
import {RoomBoards} from './room-boards.js'
import type {RoomBoardCatalogueCustody} from './room-board-custody.js'
import {closeFailedRoomWithCatalogues} from './room-board-lifecycle.js'
import type {RoomSession} from '../../src/session.js'
import {encodeRoomBoard,type RoomBoard} from '../../src/room-boards.js'
const board={boardId:'one',name:'Board',invitation:'https://girnel.test/#'+'a'.repeat(100)}
const second={...board,boardId:'two'}
function gate(){let release=()=>{};const promise=new Promise<void>(resolve=>release=resolve);return{promise,release}}
function fixture(initial:RoomBoard[]=[]) {
 const f={live:true,persisted:initial.map(v=>({...v})),saves:[] as RoomBoard[][],loadError:undefined as Error|undefined,saveError:undefined as Error|undefined,
  loadGate:undefined as ReturnType<typeof gate>|undefined,saveGate:undefined as ReturnType<typeof gate>|undefined,sendGate:undefined as ReturnType<typeof gate>|undefined,
  channelError:undefined as Error|undefined,chatError:undefined as Error|undefined,changedHook:()=>{},currentHook:()=>{},listenerHook:()=>{},messagesHook:()=>{},requestHook:()=>{},closed:0,revoked:0,stopped:0,
  owned:new Set<Promise<unknown>>(),messages:[] as {id:string;text:string;sentAt:number}[],sent:[] as string[],chat:[] as string[]}
 let listener:(()=>void)|undefined
 const changed=vi.fn(()=>f.changedHook()),channel=vi.fn(()=>({send:async(text:string)=>{f.sent.push(text);if(text===encodeRoomBoard())f.requestHook();await f.sendGate?.promise;if(f.channelError)throw f.channelError},
  messages:()=>{f.messagesHook();return f.messages},onChange:(fn:()=>void)=>{listener=fn;f.listenerHook();return()=>{listener=undefined;f.stopped++}}}))
 const session={roomId:'room',participant:'a'.repeat(64),channel,chat:{send:async(text:string)=>{f.chat.push(text);if(f.chatError)throw f.chatError}}} as unknown as RoomSession
 const custody:RoomBoardCatalogueCustody={account:session.participant,roomId:session.roomId,check:async()=>{if(!f.live)throw Error('held')},
  load:async()=>{await f.loadGate?.promise;if(f.loadError)throw f.loadError;return f.persisted.map(v=>({...v}))},
  save:async values=>{const captured=values.map(v=>({...v}));f.saves.push(captured);await f.saveGate?.promise;if(f.saveError)throw f.saveError;f.persisted=captured},
  joinLifetime:<T>(p:Promise<T>)=>{f.owned.add(p);void p.finally(()=>f.owned.delete(p)).catch(()=>{});return p},revoke:()=>{f.revoked++;f.live=false},
  close:async()=>{while(f.owned.size)await Promise.allSettled([...f.owned]);f.closed++}}
 const catalog=new RoomBoards(session,{custody,current:()=>{f.currentHook();return f.live},changed,report:vi.fn()})
 return Object.assign(f,{catalog,custody,channel,changed,receive:(text:string)=>{const value={id:String(f.messages.length),text,sentAt:Date.now()/1000};f.messages.push(value);listener?.();return value}})
}
afterEach(()=>vi.useRealTimers())
describe('awaited room-board consumer',()=>{
 it('scans delivered history without a change callback or request echo',async()=>{
  const f=fixture();f.messages.push({id:'preloaded',text:encodeRoomBoard(board),sentAt:Date.now()/1000});await f.catalog.open()
  expect(f.persisted).toEqual([board]);expect(f.catalog.boards).toEqual([board]);await f.catalog.close()
 })
 it('initial history save remains inside pending open, without ready grants or a request',async()=>{
  const f=fixture();f.messages.push({id:'old',text:encodeRoomBoard(board),sentAt:Date.now()/1000});f.saveGate=gate();let ready=false
  const opened=f.catalog.open().then(()=>ready=true);await vi.waitFor(()=>expect(f.saves).toHaveLength(1));expect(ready).toBe(false);expect(f.catalog.boards).toEqual([]);expect(f.sent).toEqual([]);expect(f.changed).not.toHaveBeenCalled()
  f.saveGate.release();await opened;expect(f.persisted).toEqual([board]);expect(f.catalog.boards).toEqual([board]);await f.catalog.close()
 })
 it('initial history save refusal rejects open and removes the listener with source intact',async()=>{
  const f=fixture();f.messages.push({id:'old',text:encodeRoomBoard(board),sentAt:Date.now()/1000});f.saveError=Error('retention hold')
  await expect(f.catalog.open()).rejects.toThrow('retention hold');expect(f.persisted).toEqual([]);expect(f.catalog.boards).toEqual([]);expect(f.sent).toEqual([]);expect(f.stopped).toBe(1);expect(f.changed).not.toHaveBeenCalled();await f.catalog.close()
 })
 it('drains an onChange microtask queued immediately before the opening handoff',async()=>{
  const f=fixture();f.saveGate=gate();let reads=0,echoed=false,ready=false
  f.requestHook=()=>{if(!echoed){echoed=true;f.receive(encodeRoomBoard())}}
  f.messagesHook=()=>{if(++reads===2)queueMicrotask(()=>f.receive(encodeRoomBoard(board)))}
  const opened=f.catalog.open().then(()=>ready=true);await vi.waitFor(()=>expect(f.saves).toHaveLength(1))
  expect(ready).toBe(false);expect(f.catalog.boards).toEqual([]);expect(f.changed).not.toHaveBeenCalled()
  f.saveGate.release();await opened;expect(f.persisted).toEqual([board]);expect(f.catalog.boards).toEqual([board]);await f.catalog.close()
 })
 it('propagates load refusal without a listener, request, visible grant or fallback',async()=>{
  const f=fixture([board]);f.loadError=Error('native hold');await expect(f.catalog.open()).rejects.toThrow('native hold')
  expect(f.catalog.boards).toEqual([]);expect(f.channel).not.toHaveBeenCalled();expect(f.changed).not.toHaveBeenCalled();expect(f.sent).toEqual([]);await f.catalog.close();expect(f.closed).toBe(1)
 })
 it('joins close during load and suppresses a late catalogue',async()=>{
  const f=fixture([board]);f.loadGate=gate();const opened=f.catalog.open();await vi.waitFor(()=>expect(f.owned.size).toBe(1));let closed=false
  const closing=f.catalog.close().then(()=>closed=true);await Promise.resolve();expect(closed).toBe(false);f.loadGate.release()
  await expect(opened).rejects.toThrow();await closing;expect(f.catalog.boards).toEqual([]);expect(f.sent).toEqual([])
 })
 it('save refusal preserves the source and cannot emit or show the candidate',async()=>{
  const f=fixture();await f.catalog.open();f.sent=[];f.saveError=Error('native refusal');await expect(f.catalog.share(board)).rejects.toThrow('native refusal')
  expect(f.persisted).toEqual([]);expect(f.catalog.boards).toEqual([]);expect(f.sent).toEqual([]);expect(f.chat).toEqual([]);await f.catalog.close()
 })
 it.each(['channel','chat'] as const)('ACK then %s failure keeps durable retry state',async stage=>{
  const f=fixture();await f.catalog.open();if(stage==='channel')f.channelError=Error('delivery refused');else f.chatError=Error('delivery refused')
  await expect(f.catalog.share(board)).rejects.toThrow('delivery refused');expect(f.persisted).toEqual([board]);expect(f.catalog.boards).toEqual([board]);expect(f.live).toBe(true)
  f.channelError=undefined;f.chatError=undefined;await f.catalog.share(board);expect(f.chat.at(-1)).toContain(board.name);await f.catalog.close()
 })
 it('joins a blocked save on close and never emits its late ACK',async()=>{
  const f=fixture();await f.catalog.open();f.sent=[];f.saveGate=gate();const shared=f.catalog.share(board);await vi.waitFor(()=>expect(f.saves).toHaveLength(1));let closed=false
  const closing=f.catalog.close().then(()=>closed=true);await Promise.resolve();expect(closed).toBe(false);expect(f.catalog.boards).toEqual([]);f.saveGate.release()
  await expect(shared).rejects.toThrow();await closing;expect(f.sent).toEqual([]);expect(f.chat).toEqual([])
 })
 it('joins an already started unabortable send and prevents the chat announcement',async()=>{
  const f=fixture();await f.catalog.open();f.sent=[];f.sendGate=gate();const shared=f.catalog.share(board);await vi.waitFor(()=>expect(f.sent).toHaveLength(1));let closed=false
  const closing=f.catalog.close().then(()=>closed=true);await Promise.resolve();expect(closed).toBe(false);f.sendGate.release();await expect(shared).rejects.toThrow();await closing;expect(f.chat).toEqual([])
 })
 it('serialises a share and incoming save without losing either board',async()=>{
  const f=fixture();await f.catalog.open();f.saveGate=gate();const shared=f.catalog.share(board);await vi.waitFor(()=>expect(f.saves).toHaveLength(1))
  f.receive(encodeRoomBoard(second));expect(f.catalog.boards).toEqual([]);f.saveGate.release();await shared;await vi.waitFor(()=>expect(f.persisted).toHaveLength(2))
  expect(new Set(f.catalog.boards.map(v=>v.boardId))).toEqual(new Set(['one','two']));await f.catalog.close()
 })
 it('does not expose or mark incoming grants seen before retention, and detaches message aliases',async()=>{
  const f=fixture();await f.catalog.open();f.saveGate=gate();const message=f.receive(encodeRoomBoard(board));await vi.waitFor(()=>expect(f.saves).toHaveLength(1));expect(f.catalog.boards).toEqual([])
  message.text=encodeRoomBoard({...board,name:'Changed'});f.receive(encodeRoomBoard(second));f.saveGate.release();await vi.waitFor(()=>expect(f.persisted).toHaveLength(2))
  expect(f.persisted.find(v=>v.boardId==='one')?.name).toBe('Board');await f.catalog.close()
 })
 it('captures explicit share before a current callback can mutate the caller',async()=>{
  const f=fixture();await f.catalog.open();const input={...board};f.currentHook=()=>{input.name='Changed';input.invitation=second.invitation+'b'}
  await f.catalog.share(input);expect(f.persisted).toEqual([board]);await f.catalog.close()
 })
 it.each(['current','changed'] as const)('reentrant %s refuses further work',async callback=>{
  const f=fixture();await f.catalog.open();f.sent=[];let nested:Promise<void>|undefined,nestedError:string|undefined,once=false
  const hook=()=>{if(!once){once=true;nested=f.catalog.share(second).catch(e=>{nestedError=e.message})}};if(callback==='current')f.currentHook=hook;else f.changedHook=hook
  await expect(f.catalog.share(board)).rejects.toThrow();await nested;expect(nestedError).toBeTruthy();expect(f.sent).toEqual([]);expect(f.chat).toEqual([]);await f.catalog.close()
 })
 it('owns a listener returned after reentrant close during setup',async()=>{
  const f=fixture();let closing:Promise<void>|undefined;f.listenerHook=()=>{closing=f.catalog.close()}
  await expect(f.catalog.open()).rejects.toThrow();await closing;expect(f.stopped).toBe(1);expect(f.sent).toEqual([]);expect(f.catalog.boards).toEqual([])
 })
 it('cancels reply pacing on close, and pacing does not block a new save',async()=>{
  vi.useFakeTimers();const f=fixture([board,second]);await f.catalog.open();f.sent=[];f.receive(encodeRoomBoard())
  await vi.waitFor(()=>expect(f.sent).toHaveLength(1));await f.catalog.share({...board,name:'New'});expect(f.persisted[0]?.name).toBe('New')
  const before=f.sent.length;await f.catalog.close();await vi.advanceTimersByTimeAsync(5000);expect(f.sent).toHaveLength(before)
 })
 it('rejects accessor-backed history without calling its getter or saving partial state',async()=>{
  const f=fixture();await f.catalog.open();let calls=0;const message=f.receive(encodeRoomBoard(board));Object.defineProperty(message,'text',{get(){calls++;return encodeRoomBoard(board)}})
  await vi.waitFor(()=>expect(f.live).toBe(false));expect(calls).toBe(0);expect(f.saves).toEqual([]);await f.catalog.close()
 })
 it.each(['load','send'] as const)('failed room entry joins blocked %s before captured transport teardown',async stage=>{
  const f=fixture(),leave=vi.fn(async()=>{}),close=vi.fn();let active:Promise<void>
  if(stage==='load'){f.loadGate=gate();active=f.catalog.open();await vi.waitFor(()=>expect(f.owned.size).toBe(1))}
  else{await f.catalog.open();f.sent=[];f.sendGate=gate();active=f.catalog.share(board);await vi.waitFor(()=>expect(f.sent).toHaveLength(1))}
  const handled=active.catch(()=>{});let cleared=false
  const closing=closeFailedRoomWithCatalogues({leave},{close},()=>f.catalog.close(),()=>{cleared=true;f.live=false})
  expect(cleared).toBe(true);expect(leave).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();f.loadGate?.release();f.sendGate?.release()
  await handled;await closing;expect(leave).toHaveBeenCalledTimes(1);expect(close).toHaveBeenCalledTimes(1);expect(f.chat).toEqual([]);expect(f.catalog.boards).toEqual([])
 })
})
