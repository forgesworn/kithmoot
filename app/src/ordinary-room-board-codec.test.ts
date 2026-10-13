import { describe,it,expect } from 'vitest'
import { localSelfCrypt } from '../../src/read-position.js'
import { encodeOrdinaryRoomBoardChunks as encode,decodeOrdinaryRoomBoardChunks as decode,captureOrdinaryRoomBoards as capture } from './ordinary-room-board-codec.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
const account='a'.repeat(64),room='b'.repeat(64)
const board={boardId:'opaque-board',name:' Board ',invitation:'https://girnel.test/app/#'+'c'.repeat(100)}
const large=Array.from({length:50},(_,i)=>({...board,boardId:String(i).padStart(2,'0'),invitation:'https://girnel.test/app/#'+'c'.repeat(1700)}))
describe('authenticated native room-board chunk-set binding',()=>{
 it.each([[],[board],large].map(input=>({input})))('round-trips canonical empty, single and multi-chunk catalogues through real NIP44',async ({input})=>{
  const plaintexts=encode(input,account,room),crypt=localSelfCrypt(new Uint8Array(32).fill(1)),opened=[]
  for(const value of plaintexts)opened.push(await crypt.decrypt(await crypt.encrypt(value)))
  const result=decode(opened,account,room);expect(result).toEqual(capture(input));expect(Object.isFrozen(result)).toBe(true)
  for(const value of result)expect(Object.isFrozen(value)).toBe(true)
  if(input.length===50)expect(plaintexts.length).toBeGreaterThan(1)
 })
 it.each(['account','room','index','count','digest','extra','legacy','row-extra','duplicate','noncanonical','reversed','missing','mixed','oversized'] as const)('refuses %s without returning partial grants',fault=>{
  const source=[...encode(large,account,room)],first=JSON.parse(source[0]!)
  if(fault==='account')first.account='d'.repeat(64);if(fault==='room')first.roomId='d'.repeat(64);if(fault==='index')first.index=1;if(fault==='count')first.count++
  if(fault==='digest')first.catalogue='f'.repeat(64);if(fault==='extra')first.extra=true;if(fault==='row-extra')first.boards[0].secret='extra'
  if(fault==='duplicate')first.boards.push(first.boards[0]);source[0]=fault==='legacy'?JSON.stringify(first.boards):JSON.stringify(first)
  if(fault==='noncanonical')source[0]=JSON.stringify(first,null,2);if(fault==='reversed')source.reverse();if(fault==='missing')source.pop()
  if(fault==='mixed')source[1]=encode(large.map(value=>({...value,name:'Another catalogue'})),account,room)[1]!
  if(fault==='oversized')source[0]=' '.repeat(20001)
  expect(()=>decode(source,account,room)).toThrow(OrdinaryStateHold)
 })
 it('captures descriptors without running accessor fields or accepting unknown data',()=>{
  let calls=0;const value={...board};Object.defineProperty(value,'name',{get(){calls++;return'getter'}})
  expect(()=>capture([value])).toThrow(OrdinaryStateHold);expect(calls).toBe(0)
  expect(()=>capture([{...board,extra:true} as typeof board])).toThrow(OrdinaryStateHold)
  const input=[board];Object.defineProperty(input,'0',{get(){calls++;return board}});expect(()=>capture(input)).toThrow(OrdinaryStateHold);expect(calls).toBe(0)
 })
 it('refuses an unauthenticated ciphertext from a different account before chunk decoding',async()=>{
  const crypt=localSelfCrypt(new Uint8Array(32).fill(1)),other=localSelfCrypt(new Uint8Array(32).fill(2)),source=encode([board],account,room)
  await expect(other.decrypt(await crypt.encrypt(source[0]!))).rejects.toThrow()
 })
 it('refuses URL canonicalisation that expands a bounded caller field beyond the retained limit',()=>{
  const invitation='https://girnel.test/'+String.fromCodePoint(0x1f334).repeat(400)+'/#'+'c'.repeat(100)
  expect(invitation.length).toBeLessThan(2000)
  expect(()=>encode([{...board,invitation}],account,room)).toThrow(OrdinaryStateHold)
 })
})
