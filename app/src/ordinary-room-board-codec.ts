import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'
import { decodeRoomBoard, encodeRoomBoard, type RoomBoard } from '../../src/room-boards.js'
import { OrdinaryStateHold, ordinaryUtf8Length } from './ordinary-state-codec.js'
const HEX = /^[0-9a-f]{64}$/
export const ORDINARY_ROOM_BOARD_PLAINTEXT_BYTES = 20_000
function hold(): never {throw new OrdinaryStateHold()}
function data(input: unknown, fields: readonly string[]): Record<string,unknown> {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== fields.length) hold()
  const values: Record<string,unknown> = {}
  for (const name of fields) {
    const field = Object.getOwnPropertyDescriptor(input,name)
    if (!field || !Object.hasOwn(field,'value')) hold()
    values[name] = field.value
  }
  return values
}
/** Bounded descriptor capture before any provider start. Canonicalisation is
 * identical to the room protocol, while unknown/accessor fields are refused. */
export function captureOrdinaryRoomBoards(input: readonly RoomBoard[]): RoomBoard[] {
  if (!Array.isArray(input) || input.length > 50 || Reflect.ownKeys(input).length !== input.length+1) hold()
  const result: RoomBoard[] = [], ids = new Set<string>()
  for (let i=0;i<input.length;i++) {
    const field = Object.getOwnPropertyDescriptor(input,String(i))
    if (!field || !Object.hasOwn(field,'value')) hold()
    const row = data(field.value,['boardId','name','invitation'])
    if (Object.values(row).some(value=>typeof value!=='string' || value.length>2000)) hold()
    const decoded = decodeRoomBoard(encodeRoomBoard(row as unknown as RoomBoard))
    if (decoded?.op !== 'share' || Object.values(decoded.board).some(value=>value.length>2000) || ids.has(decoded.board.boardId)) hold()
    ids.add(decoded.board.boardId); result.push(decoded.board)
  }
  return result.sort((a,b)=>a.boardId<b.boardId?-1:a.boardId>b.boardId?1:0)
}
function digest(boards: readonly RoomBoard[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(boards))
  try {return bytesToHex(sha256(bytes))} finally {bytes.fill(0)}
}
function scoped(account: string, roomId: string): void {if (typeof account!=='string'||typeof roomId!=='string'||!HEX.test(account)||!HEX.test(roomId))hold()}
function body(account: string, roomId: string, catalogue: string, index: number, count: number, boards: readonly RoomBoard[]): string {
  return JSON.stringify({version:2,account,roomId,catalogue,index,count,boards})
}
/** Scope and whole-set digest live INSIDE authenticated NIP-44 plaintext.
 * The outer native carrier stays opaque; these strings alone prove no MAC. */
export function encodeOrdinaryRoomBoardChunks(input: readonly RoomBoard[], account: string, roomId: string): readonly string[] {
  scoped(account,roomId);const boards=captureOrdinaryRoomBoards(input), catalogue=digest(boards),groups:RoomBoard[][]=[[]]
  for (const board of boards) {
    let group=groups[groups.length-1]!
    // Reserve the longest supported ordinal/count before encryption. No
    // generated ciphertext, nonce or signature is used as sizing evidence.
    const proposal=body(account,roomId,catalogue,9,10,[...group,board])
    if (ordinaryUtf8Length(proposal,Number.MAX_SAFE_INTEGER)>ORDINARY_ROOM_BOARD_PLAINTEXT_BYTES) {group=[];groups.push(group)}
    group.push(board)
  }
  if(groups.length>10)hold()
  return Object.freeze(groups.map((group,index)=>{
    const value=body(account,roomId,catalogue,index,groups.length,group)
    ordinaryUtf8Length(value,ORDINARY_ROOM_BOARD_PLAINTEXT_BYTES);return value
  }))
}
/** Called only AFTER the selected foreground signer authenticates each cipher.
 * Legacy bare arrays, cross-room/account chunks, reordered/mixed/partial sets,
 * extensions and malformed board fields HOLD; no omitted row becomes absence. */
function decodeChunks(chunks: readonly string[], account: string, roomId: string): readonly Readonly<RoomBoard>[] {
  scoped(account,roomId)
  if(!Array.isArray(chunks)||chunks.length<1||chunks.length>10)hold()
  let catalogue: string|undefined;const boards:RoomBoard[]=[]
  for(let index=0;index<chunks.length;index++) {
    const raw=chunks[index]!
    if(typeof raw!=='string')hold();ordinaryUtf8Length(raw,ORDINARY_ROOM_BOARD_PLAINTEXT_BYTES)
    const parsed:unknown=JSON.parse(raw),value=data(parsed,['version','account','roomId','catalogue','index','count','boards'])
    if(JSON.stringify(parsed)!==raw || value.version!==2 || value.account!==account || value.roomId!==roomId || value.index!==index || value.count!==chunks.length ||
      typeof value.catalogue!=='string'||!HEX.test(value.catalogue)||catalogue!==undefined&&catalogue!==value.catalogue)hold()
    catalogue=value.catalogue
    const captured=captureOrdinaryRoomBoards(value.boards as RoomBoard[])
    if(JSON.stringify(captured)!==JSON.stringify(value.boards)||boards.length+captured.length>50)hold()
    boards.push(...captured)
  }
  const canonical=captureOrdinaryRoomBoards(boards)
  if(JSON.stringify(canonical)!==JSON.stringify(boards)||digest(canonical)!==catalogue||
     JSON.stringify(encodeOrdinaryRoomBoardChunks(canonical,account,roomId))!==JSON.stringify(chunks))hold()
  return Object.freeze(canonical.map(board=>Object.freeze(board)))
}

export function decodeOrdinaryRoomBoardChunks(chunks: readonly string[], account: string, roomId: string): readonly Readonly<RoomBoard>[] {
  try {return decodeChunks(chunks,account,roomId)} catch {return hold()}
}
