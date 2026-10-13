import { afterEach, describe, it, expect, vi } from 'vitest'
import { localSelfCrypt } from '../../src/read-position.js'
import { encodeRoomBoard } from '../../src/room-boards.js'
import type { RoomSession } from '../../src/session.js'
import type { ChatMessage } from '../../src/chat.js'
import { RoomBoards } from './room-boards.js'
import { memoryDeviceStore } from './device-store.js'
import { validateOrdinaryRoomBoardSnapshot as validate } from './ordinary-room-board-snapshot.js'
import { classifyOrdinaryPhysicalName as classify } from './ordinary-physical-snapshot.js'
import { captureOrdinarySnapshotContext, validateOrdinarySnapshot } from './ordinary-snapshot.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
afterEach(()=>vi.unstubAllGlobals())
const account='a'.repeat(64),room='b'.repeat(64),name=`kithmoot.room-boards.v1.${account}.${room}`
const board={boardId:'real-board',name:'Private catalogue',invitation:'https://girnel.test/app/#'+'c'.repeat(100)}
async function fixture() {
 const store=memoryDeviceStore(),messages:ChatMessage[]=[]
 let changed=()=>{}
 const session={roomId:room,participant:account,chat:{send:async()=>{}},channel:()=>({send:async()=>{},messages:()=>messages,onChange:(fn:()=>void)=>{changed=fn;return()=>{}}})} as unknown as RoomSession
 const catalogue=new RoomBoards(session,{account,store,crypt:localSelfCrypt(new Uint8Array(32).fill(1)),current:()=>true,changed:()=>{},report:err=>{throw err}})
 await catalogue.open();messages.push({id:'1',text:encodeRoomBoard(board),sentAt:1,participant:account} as ChatMessage);changed()
 await vi.waitFor(()=>expect(store.get(name)).not.toBeNull());catalogue.close()
 return store.get(name)!
}
describe('opaque room-board catalogue custody',()=>{
 it('accepts the actual encrypted writer without exposing an invitation or claiming recipient/room authentication',async()=>{
  const raw=await fixture(),records=new Map([[name,raw]])
  expect(raw).not.toContain(board.invitation);expect(raw).not.toContain(board.name)
  expect(classify(name,'browser')).toEqual({family:'roomBoards',custody:'protected'})
  for(const migrated of [false,true])expect(validate(records,migrated,{kind:'browser'})).toEqual({catalogues:1,chunks:1})
  vi.stubGlobal('location',{href:'https://ordinary-room-boards.kithmoot.test/j/'})
  const tab=new Map<string,string>();expect(validateOrdinarySnapshot(records,tab,{browser:true,tab:true},captureOrdinarySnapshotContext(records,tab)).families.roomBoards).toBe(1)
  expect(()=>classify(name,'tab')).toThrow(OrdinaryStateHold)
 })
 it.each(['unknown-version','wrapped','uppercase','tab','extension','empty','too-many','plaintext','noncanonical','bad-base64','bad-version','oversized'] as const)('holds %s intact',async fault=>{
  let key=name,raw=await fixture(),kind:'browser'|'tab'='browser';const value=JSON.parse(raw)
  if(fault==='unknown-version')key=key.replace('.v1.','.v2.');if(fault==='wrapped')key=`kithmoot.account.${account}.`+key;if(fault==='uppercase')key=key.replace(account,account.toUpperCase());if(fault==='tab')kind='tab'
  if(fault==='extension')value.invitation=board.invitation;if(fault==='empty')value.chunks=[];if(fault==='too-many')value.chunks=Array(11).fill(value.chunks[0]);if(fault==='plaintext')value.chunks=[JSON.stringify([board])]
  if(fault==='bad-base64')value.chunks=[value.chunks[0]+'!'];if(fault==='bad-version')value.chunks=['B'+value.chunks[0].slice(1)];if(fault==='oversized')value.chunks=['A'.repeat(250000)]
  raw=fault==='noncanonical'?JSON.stringify(value,null,2):JSON.stringify(value);const records=new Map([[key,raw]]),before=[...records]
  for(const migrated of [false,true])expect(()=>validate(records,migrated,{kind})).toThrow(OrdinaryStateHold)
  expect([...records]).toEqual(before)
 })
 it('preserves changed opaque ciphertext framing while deferring cryptographic authentication',async()=>{
  const raw=await fixture(),value=JSON.parse(raw);value.chunks[0]=value.chunks[0].slice(0,20)+(value.chunks[0][20]==='A'?'B':'A')+value.chunks[0].slice(21)
  const retained=JSON.stringify(value);expect(validate(new Map([[name,retained]]),true,{kind:'browser'})).toEqual({catalogues:1,chunks:1})
  await expect(localSelfCrypt(new Uint8Array(32).fill(1)).decrypt(value.chunks[0])).rejects.toThrow()
 })
})
