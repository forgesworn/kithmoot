import type { SignetSession, SignetSigner } from 'signet-login'
import { nip44 } from 'nostr-tools'
import { base64 } from '@scure/base'
import type { RoomBoard } from '../../src/room-boards.js'
import type { DeviceStore } from './device-store.js'
import { OrdinaryStateHold, ordinaryUtf8Length } from './ordinary-state-codec.js'
import { OrdinaryStateOwner, ordinaryPairCustodyFor, ordinaryPairProjectedByteLengths, type OrdinaryScope, type OrdinaryPairCustody } from './ordinary-state-owner.js'
import { captureOrdinarySnapshotContext, validateOrdinarySnapshot } from './ordinary-snapshot.js'
import { OrdinaryForegroundSigner } from './ordinary-foreground-signer.js'
import { ORDINARY_SIGNET_KEYS } from './ordinary-signet-snapshot.js'
import { validateOrdinaryRoomBoardSnapshot } from './ordinary-room-board-snapshot.js'
import { captureOrdinaryRoomBoards, encodeOrdinaryRoomBoardChunks, decodeOrdinaryRoomBoardChunks, ORDINARY_ROOM_BOARD_PLAINTEXT_BYTES } from './ordinary-room-board-codec.js'
import type { RoomBoardCatalogueCustody } from './room-board-custody.js'

interface Options {
  browser: OrdinaryStateOwner
  tab: OrdinaryStateOwner
  session: Readonly<SignetSession>
  roomId: string
  generation: number
  currentGeneration(): number
  current(): {session: Readonly<SignetSession>;roomId: string}|undefined
  live(): boolean
  checkClients(): Promise<void>
  stop(): void
}
const HEX=/^[0-9a-f]{64}$/
const records=(store:DeviceStore)=>new Map(store.keys().map(name=>[name,store.get(name)!]))
function hold():never {throw new OrdinaryStateHold()}
/** Exact NIP-44 v2 short-profile sizing only. Its zero bytes authenticate
 * nothing; the placeholder never reaches retention, restoration or a provider. */
function projectedCipher(text:string):string {
  const bytes=new Uint8Array(67+nip44.v2.utils.calcPaddedLen(ordinaryUtf8Length(text)))
  try {bytes[0]=2;return base64.encode(bytes)} finally {bytes.fill(0)}
}

/** Native encrypted catalogue custody for one selected foreground/room.
 * The selected room is a root control binding, never MLS admission authority.
 * This does not initialise signers, subscribe, publish, or mount production. */
export class OrdinaryRoomBoardStorage implements RoomBoardCatalogueCustody {
  readonly #options:Options
  readonly #browserScope:OrdinaryScope
  readonly #tabScope:OrdinaryScope
  readonly #name:string
  readonly #crypt:NonNullable<SignetSigner['nip44']>
  readonly #work=new Set<Promise<unknown>>()
  #expected:string|null|undefined
  #sdk:readonly (string|null)[]|undefined
  #loaded=false
  #reserved=false
  #projection:string|undefined
  #closed=false
  #held=false
  #busy=false
  #closing:Promise<void>|undefined
  get account():string{return this.#options.session.pubkey}
  get roomId():string{return this.#options.roomId}
  /** Join the owning catalogue's whole queued operation before continuation.
   * This grants no storage, signer, room or transport authority. */
  joinLifetime<T>(operation:Promise<T>):Promise<T>{
    OrdinaryStateOwner.joinPairLifetime(this.#options.browser,this.#options.tab,operation)
    this.#work.add(operation);void operation.finally(()=>this.#work.delete(operation)).catch(()=>{});return operation
  }
  private constructor(options:Options,browser:OrdinaryScope,tab:OrdinaryScope) {
    this.#options=options;this.#browserScope=browser;this.#tabScope=tab
    this.#name=`kithmoot.room-boards.v1.${options.session.pubkey}.${options.roomId}`
    this.#crypt=(options.session.signer as OrdinaryForegroundSigner).borrowNip44({live:this.#live,
      validate:(b,t,c)=>this.#preflight(b,t,c,true)})
  }
  #live=():boolean=>{
    if(this.#closed||this.#held)return false
    try {
      const current=this.#options.current(),now=Date.now(),session=this.#options.session
      const valid=this.#options.live()===true&&this.#options.currentGeneration()===this.#options.generation&&current?.session===session&&
        current.roomId===this.#options.roomId&&Number.isSafeInteger(now)&&now>=0&&now<this.#options.tab.expiresAt&&
        (session.expiresAt===undefined||now<session.expiresAt)
      return valid&&!this.#closed&&!this.#held
    } catch {return false}
  }
  #check():void {if(!this.#live())hold()}
  #stop():void {if(!this.#held){this.#held=true;try{this.#options.stop()}catch{/* Held cannot be waived. */}}}
  #track<T>(work:()=>Promise<T>):Promise<T> {
    const pending=Promise.resolve().then(work)
    OrdinaryStateOwner.joinPairLifetime(this.#options.browser,this.#options.tab,pending)
    this.#work.add(pending);void pending.finally(()=>this.#work.delete(pending)).catch(()=>{});return pending
  }
  #run<T>(capture:()=>()=>Promise<T>):Promise<T> {
    if(this.#busy||this.#closed||this.#held){this.#stop();return Promise.reject(new OrdinaryStateHold())}
    this.#busy=true;let operation:()=>Promise<T>
    // Detach caller data before selection/live callbacks can mutate it. The
    // latch already prevents those callbacks from re-entering a provider.
    try{operation=capture();this.#check()}catch(error){this.#busy=false;this.#stop();return Promise.reject(error)}
    return this.#track(async()=>{try{await this.#clients();const result=await operation();this.#check();return result}
      catch(error){this.#stop();throw error}finally{this.#busy=false;this.#projection=undefined}})
  }
  async #clients():Promise<void>{this.#check();await this.#options.checkClients();this.#check()}
  #preflight(browser:DeviceStore,tab:DeviceStore,custody:OrdinaryPairCustody,provider=false):void {
    const b=records(browser),t=records(tab)
    try {
      const headers=ordinaryPairCustodyFor(custody,b,t)
      for(const [header,scope] of [[headers.browser,this.#browserScope],[headers.tab,this.#tabScope]] as const)
        if(header.generation!==scope.generation||(header.fences.get(scope.name)??0)!==scope.fence||provider&&this.#projection!==undefined&&!header.fences.has(scope.name))hold()
      validateOrdinarySnapshot(b,t,{browser:true,tab:true},captureOrdinarySnapshotContext(b,t,custody))
      const sdk=Object.values(ORDINARY_SIGNET_KEYS).map(key=>browser.get(key)),session=this.#options.session
      if(browser.get(ORDINARY_SIGNET_KEYS.pubkey)!==session.pubkey||browser.get(ORDINARY_SIGNET_KEYS.method)!==session.method||
        browser.get(ORDINARY_SIGNET_KEYS.authEvent)!==JSON.stringify(session.authEvent))hold()
      if(this.#sdk&&sdk.some((value,i)=>value!==this.#sdk![i]))hold()
      this.#sdk??=Object.freeze(sdk)
      const raw=browser.get(this.#name)
      if(this.#expected!==undefined&&raw!==this.#expected)hold()
      this.#expected??=raw
      if(this.#projection!==undefined) {
        const proposed=new Map(b);proposed.set(this.#name,this.#projection)
        // Own scopes are acknowledged before a narrowed signer can start. Its
        // token belongs to the SDK scopes, so reserve no unrelated scope here.
        try{ordinaryPairProjectedByteLengths(custody,b,t,{browser:proposed,tab:t},!provider&&!this.#reserved)}finally{proposed.clear()}
      }
    } finally{b.clear();t.clear()}
  }
  #pair<T>(work:(b:DeviceStore,t:DeviceStore,c:OrdinaryPairCustody)=>T,retain=false):Promise<T> {
    const method=retain?OrdinaryStateOwner.retainPairScopesMigrated:OrdinaryStateOwner.readPairMigrated
    return method.call(OrdinaryStateOwner,{browser:{owner:this.#options.browser,scope:this.#browserScope},
      tab:{owner:this.#options.tab,scope:this.#tabScope},live:this.#live,work:(b:DeviceStore,t:DeviceStore,_b:readonly string[],_t:readonly string[],c:OrdinaryPairCustody)=>{
        this.#preflight(b,t,c);this.#check();const value=work(b,t,c);this.#check()
        if(retain){const bm=records(b),tm=records(t);try{validateOrdinarySnapshot(bm,tm,{browser:true,tab:true},captureOrdinarySnapshotContext(bm,tm,c))}finally{bm.clear();tm.clear()}}
        return value
      }}) as Promise<T>
  }
  static async open(input:Options):Promise<OrdinaryRoomBoardStorage> {
    const options={...input};let state:OrdinaryRoomBoardStorage|undefined
    try {
      const session=options.session
      if(!(options.browser instanceof OrdinaryStateOwner)||!(options.tab instanceof OrdinaryStateOwner)||
        !(session.signer instanceof OrdinaryForegroundSigner)||session!==session.signer.session||!session.signer.nip44||
        !HEX.test(session.pubkey)||!HEX.test(options.roomId)||!Number.isSafeInteger(options.generation)||options.generation<0||
        options.browser.purpose!=='browser'||!/^tab:[0-9a-f]{64}$/.test(options.tab.purpose))hold()
      const live=()=>{const current=options.current();return options.live()===true&&current?.session===session&&current.roomId===options.roomId&&options.currentGeneration()===options.generation}
      if(!live())hold();await options.checkClients();if(!live())hold()
      const name='room:'+options.roomId,b=await options.browser.capture(name,live),t=await options.tab.capture(name,live)
      state=new OrdinaryRoomBoardStorage(options,b,t);await state.#run(()=>()=>state!.#pair(()=>{}));return state
    } catch(error){if(state){state.#stop();await state.close()}else{try{options.stop()}catch{}};throw error}
  }
  load():Promise<readonly Readonly<RoomBoard>[]> {
    return this.#run(()=>async()=>{
      await this.#pair(()=>{});const raw=this.#expected!
      if(raw===null){await this.#clients();await this.#pair(()=>{});this.#loaded=true;return Object.freeze([])}
      const chunks=(JSON.parse(raw) as {chunks:string[]}).chunks,opened:string[]=[]
      try {
        for(const chunk of chunks) {
          const plaintext=await this.#crypt.decrypt(this.#options.session.pubkey,chunk)
          ordinaryUtf8Length(plaintext,ORDINARY_ROOM_BOARD_PLAINTEXT_BYTES);opened.push(plaintext)
        }
        const boards=decodeOrdinaryRoomBoardChunks(opened,this.#options.session.pubkey,this.#options.roomId)
        await this.#clients();await this.#pair(()=>{});this.#loaded=true;return boards
      }finally{opened.length=0}
    })
  }
  check():Promise<void>{return this.#run(()=>()=>this.#pair(()=>{}))}
  save(input:readonly RoomBoard[]):Promise<void> {
    return this.#run(()=>{
      if(!this.#loaded)hold()
      const boards=captureOrdinaryRoomBoards(input),plaintexts=encodeOrdinaryRoomBoardChunks(boards,this.#options.session.pubkey,this.#options.roomId)
      return async()=>{
        this.#projection=JSON.stringify({chunks:plaintexts.map(projectedCipher)})
        validateOrdinaryRoomBoardSnapshot(new Map([[this.#name,this.#projection]]),true,{kind:'browser'})
        await this.#pair(()=>{})
        // Native control reservations acknowledge both room fences before any
        // wallet entropy. The original catalogue row is still byte-for-byte.
        if(!this.#reserved){await this.#clients();await this.#pair(()=>{},true);this.#reserved=true}
        const chunks:string[]=[]
        for(const plaintext of plaintexts) {
          const cipher=await this.#crypt.encrypt(this.#options.session.pubkey,plaintext)
          if(cipher.length!==projectedCipher(plaintext).length)hold()
          chunks.push(cipher)
        }
        const raw=JSON.stringify({chunks});validateOrdinaryRoomBoardSnapshot(new Map([[this.#name,raw]]),true,{kind:'browser'});this.#projection=raw
        // Prove the selected provider round-trip and exact chunk-set binding
        // before native retention. This assumes the selected wallet's NIP-44
        // implementation; it is not an independent off-device MAC attestation.
        const opened:string[]=[]
        try {
          for(let i=0;i<chunks.length;i++) {
            const plaintext=await this.#crypt.decrypt(this.#options.session.pubkey,chunks[i]!)
            ordinaryUtf8Length(plaintext,ORDINARY_ROOM_BOARD_PLAINTEXT_BYTES)
            if(plaintext!==plaintexts[i])hold();opened.push(plaintext)
          }
          decodeOrdinaryRoomBoardChunks(opened,this.#options.session.pubkey,this.#options.roomId)
        }finally{opened.length=0}
        this.#projection=raw;await this.#clients();await this.#pair(b=>b.set(this.#name,raw),true)
        this.#expected=raw
        await this.#clients();await this.#pair(()=>{})
      }
    })
  }
  revoke():void {this.#closed=true;this.#stop()}
  close():Promise<void>{
    if(this.#closing)return this.#closing;this.revoke()
    this.#closing=(async()=>{while(this.#work.size)await Promise.allSettled([...this.#work]);this.#expected=undefined;this.#sdk=undefined;this.#projection=undefined})()
    return this.#closing
  }
}
