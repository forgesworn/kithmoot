import type { RoomBoard } from '../../src/room-boards.js'
import { decodeRoomBoard, encodeRoomBoard } from '../../src/room-boards.js'
import type { SelfCrypt } from '../../src/read-position.js'
import type { DeviceStore } from './device-store.js'

/** One selected account/room and its owned catalogue lifetime. Checks are
 * awaited storage decisions; they do not authorise deferred transport frames. */
export interface RoomBoardCatalogueCustody {
  readonly account: string
  readonly roomId: string
  check(): Promise<void>
  load(): Promise<readonly Readonly<RoomBoard>[]>
  save(boards: readonly RoomBoard[]): Promise<void>
  /** Resource ownership only; returns the SAME promise before it continues. */
  joinLifetime<T>(operation: Promise<T>): Promise<T>
  revoke(): void
  close(): Promise<void>
}

export function captureRoomBoard(input: RoomBoard): Readonly<RoomBoard> {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) throw new Error('The board invitation cannot be shared in this chat.')
  const row: Record<string, string> = {}
  for (const name of ['boardId', 'name', 'invitation']) {
    const field = Object.getOwnPropertyDescriptor(input, name)
    if (!field || !Object.hasOwn(field, 'value') || typeof field.value !== 'string' || field.value.length > 2000) throw new Error('The board invitation cannot be shared in this chat.')
    row[name] = field.value
  }
  const message = decodeRoomBoard(encodeRoomBoard(row as unknown as RoomBoard))
  if (message?.op !== 'share' || Object.values(message.board).some(value => value.length > 2000)) throw new Error('The board invitation cannot be shared in this chat.')
  return Object.freeze(message.board)
}
export function captureRoomBoardCatalogue(input: readonly RoomBoard[]): readonly Readonly<RoomBoard>[] {
  if (!Array.isArray(input) || input.length > 50 || Reflect.ownKeys(input).length !== input.length + 1) throw new Error('The board catalogue is not supported.')
  const boards: Readonly<RoomBoard>[] = [], ids = new Set<string>()
  for (let i=0;i<input.length;i++) {
    const field = Object.getOwnPropertyDescriptor(input, String(i))
    if (!field || !Object.hasOwn(field,'value')) throw new Error('The board catalogue is not supported.')
    const board = captureRoomBoard(field.value)
    if (ids.has(board.boardId)) throw new Error('The board catalogue contains a duplicate.')
    ids.add(board.boardId);boards.push(board)
  }
  return Object.freeze(boards)
}

/** Explicit current-production compatibility adapter. Never select this as
 * recovery from native refusal. Legacy bare arrays remain a legacy format. */
export function legacyRoomBoardCatalogueCustody(input: {
  account: string; roomId: string; store: DeviceStore; crypt: SelfCrypt; current(): boolean
}): RoomBoardCatalogueCustody {
  const {account,roomId,store,crypt,current}=input, encrypt=crypt.encrypt, decrypt=crypt.decrypt
  const name=`kithmoot.room-boards.v1.${account}.${roomId}`,work=new Set<Promise<unknown>>()
  let closed=false,busy=false,closing:Promise<void>|undefined
  const check=()=>{if(closed)throw new Error('The board catalogue is no longer current.');const valid=current();if(closed||valid!==true)throw new Error('The board catalogue is no longer current.')}
  const join=<T>(operation:Promise<T>):Promise<T>=>{work.add(operation);void operation.finally(()=>work.delete(operation)).catch(()=>{});return operation}
  const run=<T>(capture:()=>()=>Promise<T>):Promise<T>=>{
    if(closed||busy){closed=true;return Promise.reject(new Error('The board catalogue is no longer current.'))}
    busy=true;let action:()=>Promise<T>
    try{action=capture();check()}catch(error){busy=false;closed=true;return Promise.reject(error)}
    return join(Promise.resolve().then(async()=>{try{check();const result=await action();check();return result}catch(error){closed=true;throw error}finally{busy=false}}))
  }
  return Object.freeze({account,roomId,
    check:()=>run(()=>async()=>{}),
    load:()=>run(()=>async()=>{
      const raw=store.get(name);if(raw===null)return Object.freeze([])
      // Preserve source on refusal. Parsing/decryption failure is not absence.
      if(!raw||raw.length>=250000)throw new Error('The saved board catalogue is not supported.')
      const chunks:unknown=JSON.parse(raw).chunks
      if(!Array.isArray(chunks)||chunks.length<1||chunks.length>10||chunks.some(chunk=>typeof chunk!=='string'))throw new Error('The saved board catalogue is not supported.')
      const boards=new Map<string,Readonly<RoomBoard>>()
      for(const chunk of chunks){check();const opened=await decrypt.call(crypt,chunk);check();if(opened.length>20000)throw new Error('The saved board catalogue is not supported.')
        const rows:unknown=JSON.parse(opened);if(!Array.isArray(rows)||rows.length>50)throw new Error('The saved board catalogue is not supported.')
        for(const row of rows){const board=captureRoomBoard(row);if(boards.size>=50&&!boards.has(board.boardId))throw new Error('The saved board catalogue is not supported.');boards.set(board.boardId,board)}}
      return Object.freeze([...boards.values()])
    }),
    save:(input:readonly RoomBoard[])=>run(()=>{
      const boards=captureRoomBoardCatalogue(input),groups:Readonly<RoomBoard>[][]=[[]]
      for(const board of boards){let group=groups[groups.length-1]!;if(JSON.stringify([...group,board]).length>20000){group=[];groups.push(group)};group.push(board)}
      if(groups.length>10)throw new Error('The board catalogue is too large.')
      const texts=groups.map(group=>JSON.stringify(group))
      return async()=>{const chunks:string[]=[];for(const text of texts){check();chunks.push(await encrypt.call(crypt,text));check()}
        const raw=JSON.stringify({chunks});if(raw.length>=250000)throw new Error('The board catalogue is too large.');check();store.set(name,raw);check()}
    }),
    joinLifetime:join,
    revoke:()=>{closed=true},
    close:()=>{closed=true;return closing??=(async()=>{while(work.size)await Promise.allSettled([...work])})()},
  })
}
