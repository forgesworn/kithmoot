import type { RoomSession } from '../../src/session.js'
import type { ChatLog } from '../../src/chat.js'
import { MAX_CHAT_TEXT_LENGTH } from '../../src/chat.js'
import { decodeRoomBoard, encodeRoomBoard, ROOM_BOARDS_CHANNEL, type RoomBoard } from '../../src/room-boards.js'
import { captureRoomBoard, captureRoomBoardCatalogue, type RoomBoardCatalogueCustody } from './room-board-custody.js'

type Log = Pick<ChatLog, 'send'|'messages'|'onChange'>
type SendingLog = Pick<ChatLog,'send'>
class DeliveryError extends Error {
  constructor(error: unknown) {super(error instanceof Error ? error.message : 'The board could not be delivered.', {cause:error})}
}
function captureMessages(input: ReturnType<ChatLog['messages']>): readonly Readonly<{id:string;text:string;sentAt:number}>[] {
  if(!Array.isArray(input)||input.length>2000||Reflect.ownKeys(input).length!==input.length+1)throw new Error('The board history is not supported.')
  const result:{id:string;text:string;sentAt:number}[]=[]
  for(let i=0;i<input.length;i++) {
    const field=Object.getOwnPropertyDescriptor(input,String(i));if(!field||!Object.hasOwn(field,'value')||!field.value||Object.getPrototypeOf(field.value)!==Object.prototype)throw new Error('The board history is not supported.')
    const row=field.value,values=['id','text','sentAt'].map(name=>Object.getOwnPropertyDescriptor(row,name))
    if(values.some(value=>!value||!Object.hasOwn(value,'value')))throw new Error('The board history is not supported.')
    const [id,text,sentAt]=values.map(value=>value!.value)
    if(typeof id!=='string'||id.length<1||id.length>160||typeof text!=='string'||text.length>MAX_CHAT_TEXT_LENGTH||typeof sentAt!=='number'||!Number.isFinite(sentAt)||sentAt<0)throw new Error('The board history is not supported.')
    result.push(Object.freeze({id,text,sentAt}))
  }
  return Object.freeze(result)
}
function captureLog(log:Log):Log {
  const {send,messages,onChange}=log
  if(typeof send!=='function'||typeof messages!=='function'||typeof onChange!=='function')throw new Error('The board channel is unavailable.')
  return Object.freeze({send:(...args:Parameters<Log['send']>)=>send.apply(log,args),messages:()=>messages.call(log),onChange:(...args:Parameters<Log['onChange']>)=>onChange.apply(log,args)})
}
function captureSendingLog(log:SendingLog):SendingLog {
  const send=log.send;if(typeof send!=='function')throw new Error('The board announcement channel is unavailable.')
  return Object.freeze({send:(...args:Parameters<Log['send']>)=>send.apply(log,args)})
}

/** Awaited catalogue custody for one selected account/room. An acknowledged
 * catalogue records selected invitations, not proof of relay/peer delivery.
 * Storage checks here do not replace actual transport-frame authorisation. */
export class RoomBoards {
  readonly #custody:RoomBoardCatalogueCustody
  readonly #options:{current():boolean;changed():void;report(error:unknown):void}
  readonly #account:string
  readonly #roomId:string
  readonly #channel:RoomSession['channel']
  #boards=new Map<string,Readonly<RoomBoard>>()
  #seen=new Set<string>()
  #log?:Log
  #chat?:SendingLog
  #stop?:()=>void
  #closed=false
  #ready=false
  #selecting=false
  #capturing=false
  #notifying=false
  #ingesting=false
  #dirty=false
  #replying=false
  #lastReply=0
  #tail:Promise<unknown>=Promise.resolve()
  #work=new Set<Promise<unknown>>()
  #waiters=new Set<()=>void>()
  #opening:Promise<void>|undefined
  #closing:Promise<void>|undefined
  constructor(readonly session:RoomSession,options:{custody:RoomBoardCatalogueCustody;current():boolean;changed():void;report(error:unknown):void}) {
    const custody=options.custody,{account,roomId,load,save,check,joinLifetime,revoke,close}=custody
    if(account!==session.participant||roomId!==session.roomId||[load,save,check,joinLifetime,revoke,close].some(value=>typeof value!=='function'))throw new Error('The board custody belongs to a different account or room.')
    this.#account=account;this.#roomId=roomId;this.#channel=session.channel
    this.#custody=Object.freeze({account,roomId,load:()=>load.call(custody),save:(boards:readonly RoomBoard[])=>save.call(custody,boards),check:()=>check.call(custody),
      joinLifetime:<T>(work:Promise<T>)=>joinLifetime.call(custody,work) as Promise<T>,revoke:()=>revoke.call(custody),close:()=>close.call(custody)})
    this.#options=Object.freeze({current:options.current,changed:options.changed,report:options.report})
  }
  private current():boolean {
    if(this.#closed)return false
    if(this.#selecting){this.revoke();return false}
    this.#selecting=true
    try{return this.#options.current()===true&&this.session.roomId===this.#roomId&&this.session.participant===this.#account&&!this.#closed}
    catch{return false}finally{this.#selecting=false}
  }
  private check():void {if(!this.current())throw new Error('Join the linked chat before sharing this board.')}
  private async fresh():Promise<void>{this.check();await this.#custody.check();this.check()}
  get boards():RoomBoard[]{return this.#ready&&this.current()?[...this.#boards.values()].map(board=>({...board})).sort((a,b)=>a.name.localeCompare(b.name,'en-GB')):[]}
  private notify():void {
    this.check();this.#notifying=true
    try{const result:unknown=this.#options.changed();if(result&&typeof (result as PromiseLike<unknown>).then==='function'){void Promise.resolve(result).catch(()=>{});throw new Error('The board callback must be synchronous.')}}
    finally{this.#notifying=false}
    this.check()
  }
  private report(error:unknown):void {try{void Promise.resolve(this.#options.report(error)).catch(()=>{})}catch{/* Reporting cannot revive the catalogue. */}}
  private track<T>(operation:Promise<T>):Promise<T> {
    this.#work.add(operation);void operation.finally(()=>this.#work.delete(operation)).catch(()=>{})
    try{if(this.#custody.joinLifetime(operation)!==operation)throw new Error('The board lifetime did not join its operation.')}
    catch(error){this.revoke();return Promise.reject(error)}
    return operation
  }
  private enqueue<T>(action:()=>Promise<T>,deliveryFailure=false):Promise<T> {
    if(this.#closed||this.#selecting||this.#capturing||this.#notifying||this.#work.size>=64){this.revoke();return Promise.reject(new Error('The board catalogue is no longer current.'))}
    const operation=this.#tail.then(async()=>{try{this.check();const result=await action();this.check();return result}
      catch(error){if(!deliveryFailure||!(error instanceof DeliveryError))this.revoke();throw error}})
    this.#tail=operation.catch(()=>{});return this.track(operation)
  }
  private async send(log:SendingLog,text:string):Promise<void> {
    await this.fresh()
    // Actual deferred socket starts still need the native carrier boundary.
    try{await log.send(text)}catch(error){await this.fresh();throw new DeliveryError(error)}
    await this.fresh()
  }
  open():Promise<void> {
    if(this.#opening)return this.#opening
    return this.#opening=this.enqueue(async()=>{
      await this.fresh();const loaded=captureRoomBoardCatalogue(await this.#custody.load());await this.fresh()
      this.#log=captureLog(this.#channel.call(this.session,ROOM_BOARDS_CHANNEL));this.#chat=captureSendingLog(this.session.chat)
      const stop=this.#log.onChange(()=>this.ingest());if(typeof stop!=='function')throw new Error('The board listener could not be owned.')
      this.#stop=stop;if(this.#closed){this.#stop=undefined;stop();this.check()}
      this.#boards=new Map(loaded.map(board=>[board.boardId,board]));this.#dirty=true
      let requested=await this.ingestLoop(false)
      await this.send(this.#log,encodeRoomBoard());this.check()
      // An onChange microtask can run just before an awaited drain hands
      // back. Test dirty again in that continuation; ready then linearises
      // synchronously and later notifications use the normal ingest queue.
      let handoffs=0
      while(this.#dirty){if(++handoffs>16)throw new Error('The board history keeps changing.');requested=(await this.ingestLoop(false))||requested}
      this.#ready=true;this.notify();if(requested)this.reply()
    })
  }
  private ingest():void {
    if(this.#closed)return;this.#dirty=true;if(!this.#ready||this.#ingesting)return
    this.#ingesting=true
    const operation=this.enqueue(async()=>{if(await this.ingestLoop(true))this.reply()})
    void operation.catch(error=>this.report(error)).finally(()=>{this.#ingesting=false;if(this.#dirty&&!this.#closed)this.ingest()})
  }
  private async ingestLoop(notify:boolean):Promise<boolean> {
      let iterations=0,replyRequested=false
      while(this.#dirty&&!this.#closed){if(++iterations>16)throw new Error('The board history keeps changing.');this.#dirty=false;await this.fresh()
        this.#capturing=true;let messages:ReturnType<typeof captureMessages>
        try{messages=captureMessages(this.#log!.messages())}finally{this.#capturing=false}
        this.check();const boards=new Map(this.#boards),seen=new Set(this.#seen);let changed=false,requested=false
        for(const message of messages){if(seen.has(message.id))continue
          const decoded=decodeRoomBoard(message.text)
          if(decoded?.op==='share'){const board=captureRoomBoard(decoded.board)
            if(JSON.stringify(boards.get(board.boardId))!==JSON.stringify(board)){
              if(boards.size>=50&&!boards.has(board.boardId))throw new Error('This chat already has 50 shared boards.')
              boards.set(board.boardId,board);changed=true}}
          else if(decoded?.op==='list'&&message.sentAt>Date.now()/1000-60)requested=true
          seen.add(message.id)
        }
        if(changed){await this.#custody.save(captureRoomBoardCatalogue([...boards.values()]));await this.fresh()}
        this.check();this.#boards=boards;this.#seen=seen.size>2000?new Set(messages.map(message=>message.id)):seen
        if(changed&&notify)this.notify();replyRequested||=requested
      }
    return replyRequested
  }
  private wait():Promise<void> {
    if(this.#closed)return Promise.resolve()
    return new Promise(resolve=>{const cancel=()=>{clearTimeout(timer);this.#waiters.delete(cancel);resolve()},timer=setTimeout(cancel,2500);this.#waiters.add(cancel);if(this.#closed)cancel()})
  }
  private reply():void {
    if(this.#replying||!this.#boards.size||Date.now()-this.#lastReply<=60000)return
    this.#replying=true;this.#lastReply=Date.now();const boards=[...this.#boards.values()]
    // Pacing is outside save serialization. Every send re-enters its queue.
    const operation=Promise.resolve().then(async()=>{let first=true
      for(const board of boards){if(!first)await this.wait();first=false;if(this.#closed)return
        const continued=await this.enqueue(async()=>{
          await this.fresh();if(JSON.stringify(this.#boards.get(board.boardId))!==JSON.stringify(board))return false
          await this.send(this.#log!,encodeRoomBoard(board));return true
        },true);if(!continued)return}
    })
    void this.track(operation).catch(error=>this.report(error)).finally(()=>{this.#replying=false})
  }
  share(input:RoomBoard):Promise<void> {
    if(this.#closed||!this.#ready)return Promise.reject(new Error('Join the linked chat before sharing this board.'))
    if(this.#selecting||this.#capturing||this.#notifying){this.revoke();return Promise.reject(new Error('The board catalogue is no longer current.'))}
    this.#capturing=true;let selected:Readonly<RoomBoard>
    try{selected=captureRoomBoard(input)}catch(error){this.revoke();return Promise.reject(error)}finally{this.#capturing=false}
    return this.enqueue(async()=>{
      await this.fresh();const boards=new Map(this.#boards)
      if(boards.size>=50&&!boards.has(selected.boardId))throw new Error('This chat already has 50 shared boards.')
      boards.set(selected.boardId,selected)
      // A durable selected catalogue precedes any disclosure or UI update.
      // Delivery can fail afterwards; explicit retries use this same grant.
      await this.#custody.save(captureRoomBoardCatalogue([...boards.values()]));await this.fresh();this.#boards=boards;this.notify()
      await this.send(this.#log!,encodeRoomBoard(selected))
      const link=new URL('https://girnel.app/app/');link.hash=new URL(selected.invitation).hash
      await this.send(this.#chat!,`Shared board: ${selected.name}\n${link.href}`)
    },true)
  }
  revoke():void {
    this.#closed=true;this.#ready=false;this.#dirty=false;this.#boards.clear();this.#seen.clear()
    const stop=this.#stop;this.#stop=undefined;try{stop?.()}catch{}
    for(const cancel of [...this.#waiters])cancel()
    try{this.#custody.revoke()}catch{/* Revocation cannot be waived. */}
  }
  close():Promise<void> {
    if(this.#closing)return this.#closing;this.revoke()
    return this.#closing=(async()=>{while(this.#work.size)await Promise.allSettled([...this.#work]);await this.#custody.close();this.#log=undefined;this.#chat=undefined})()
  }
}
