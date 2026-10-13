import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { getPublicKey } from 'nostr-tools/pure'
import { roomInvitation, deriveInvitationId, type RoomInvitation } from '../../src/invitation.js'
import { encodePersistentInvitation } from '../../src/persistent-invitation.js'
import { deriveRoom } from '../../src/room.js'
import { parseRoomLink } from '../../src/link.js'
import type { NetworkProfile } from '../../src/anonymous.js'
import { OrdinaryStateOwner, type OrdinaryScope, type OrdinaryPairCustody } from './ordinary-state-owner.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { storeInvitationOwner, INVITATION_OWNER_PREFIX } from './invitation-store.js'
import { rememberRoom, setKeepRoom, ROOM_PREFIX } from './rooms-store.js'
import { RelayConnections } from './relay-settings.js'
import { captureOrdinarySnapshotContext, validateOrdinarySnapshot } from './ordinary-snapshot.js'
import { classifyOrdinaryPhysicalName } from './ordinary-physical-snapshot.js'
import type { DeviceStore } from './device-store.js'
import { accountPrefix, FIXED_INVITATION_RELAYS, inspectPersistentAdmissionProofs } from './persistent-admission-proof.js'
import { creatorDestinations, makePersistentCreatorProof, inspectPersistentCreatorProofs, creatorProofName, creatorIntentName,
  creatorIntent, readCreatorIntent, creatorIsSelected, MAX_CREATOR_PROOFS_PER_ROOM, MAX_CREATOR_SOURCE_EVENTS,
  type PersistentCreatorProof, type CreatorPublicationIntent, type CreatorSourceKind } from './persistent-creator-proof.js'

export interface CreatorSelection {
  readonly account: string | null; readonly participant: string; readonly invitationId: string; readonly roomId: string;
  readonly link: string; readonly keep: boolean; readonly destinations: readonly string[]; readonly profile: NetworkProfile;
  readonly sourceKind: CreatorSourceKind; readonly endsAt?: number; readonly destruct: boolean
  readonly roomRelays?: readonly string[]
  readonly predecessorOperation?: string
}
interface Options extends Omit<CreatorSelection, 'invitationId'> {
  readonly browser: OrdinaryStateOwner; readonly tab: OrdinaryStateOwner; readonly invitation: RoomInvitation;
  readonly expectedRoomSecret: Uint8Array; readonly inviterSk: Uint8Array;
  live(): boolean; current(): CreatorSelection | undefined
}
export interface RetainedCreatorPublication {
  readonly proof: PersistentCreatorProof
  readonly intent: CreatorPublicationIntent
}
function hold(): never { throw new OrdinaryStateHold() }
const copy = <T>(input: T): T => JSON.parse(JSON.stringify(input)) as T
function mapped(store: DeviceStore, participant: string): DeviceStore {
  const prefix = accountPrefix(participant)
  return { get: n => store.get(prefix+n), set: (n,v) => store.set(prefix+n,v), remove: n => store.remove(prefix+n),
    keys: () => store.keys().filter(n => n.startsWith(prefix)).map(n => n.slice(prefix.length)) }
}
interface Sources { readonly browser: readonly (readonly [string,string])[]; readonly tab: readonly (readonly [string,string])[] }
/** Creator custody producer. Preparing signs exactly once and awaits atomic
 * owner/room/fixed/proof/pending-intent retention. It performs no relay effect;
 * a separately guarded carrier must authenticate the retained operation at
 * every dial and frame enqueue, under current authority supplied by the app. */
export class OrdinaryInvitationCreator {
  readonly #options: Options
  readonly #browserScope: OrdinaryScope
  readonly #tabScope: OrdinaryScope
  readonly #id: string
  readonly #work = new Set<Promise<unknown>>()
  #closed = false
  #preparing?: Promise<RetainedCreatorPublication>
  private constructor(options: Options, browserScope: OrdinaryScope, tabScope: OrdinaryScope) {
    this.#options=options;this.#browserScope=browserScope;this.#tabScope=tabScope;this.#id=deriveInvitationId(options.invitation)
  }
  static async open(input: Options): Promise<OrdinaryInvitationCreator> {
    const bearer=new Uint8Array(input.invitation.bearer),root=new Uint8Array(input.expectedRoomSecret),key=new Uint8Array(input.inviterSk)
    let state:OrdinaryInvitationCreator|undefined
    try {
      const invitation=roomInvitation(bearer,input.invitation.inviter,true)
      const captured:Options={...input,invitation,expectedRoomSecret:root,inviterSk:key,
        destinations:creatorDestinations(input.destinations,input.profile),
        ...(input.roomRelays===undefined?{}:{roomRelays:Object.freeze([...input.roomRelays])})}
      if(input.invitation.persistent!==true||captured.expectedRoomSecret.length!==32||captured.inviterSk.length!==32||
        !/^[0-9a-f]{64}$/.test(captured.participant)||captured.account!==null&&captured.account!==captured.participant||
        getPublicKey(captured.inviterSk)!==captured.invitation.inviter||typeof captured.keep!=='boolean'||typeof captured.destruct!=='boolean'||
        !['new-room','dm','rotation','renewal'].includes(captured.sourceKind)||
        (['rotation','renewal'].includes(captured.sourceKind)?!captured.predecessorOperation||!/^[0-9a-f]{64}$/.test(captured.predecessorOperation):captured.predecessorOperation!==undefined))hold()
      const parsed=parseRoomLink(captured.link)
      try{if(!parsed.invitation?.persistent||parsed.secret||parsed.pairingCode||
        deriveInvitationId(parsed.invitation)!==deriveInvitationId(invitation)||parsed.invitation.inviter!==invitation.inviter||
        bytesToHex(parsed.invitation.bearer)!==bytesToHex(invitation.bearer))hold()}
      finally{parsed.secret?.fill(0);parsed.invitation?.bearer.fill(0);parsed.pairingCode?.fill(0)}
      const room=deriveRoom(captured.expectedRoomSecret)
      try{if(room.roomId!==captured.roomId)hold()}finally{room.roomKey.fill(0)}
      const id=deriveInvitationId(invitation)
      const expected=JSON.stringify({account:captured.account,participant:captured.participant,invitationId:id,roomId:captured.roomId,
        link:captured.link,keep:captured.keep,destinations:captured.destinations,profile:captured.profile,sourceKind:captured.sourceKind,
        endsAt:captured.endsAt,destruct:captured.destruct,roomRelays:captured.roomRelays,predecessorOperation:captured.predecessorOperation})
      const live=()=>{try{const c=captured.current();return captured.live()&&!!c&&JSON.stringify({account:c.account,participant:c.participant,
        invitationId:c.invitationId,roomId:c.roomId,link:c.link,keep:c.keep,destinations:creatorDestinations(c.destinations,c.profile),
        profile:c.profile,sourceKind:c.sourceKind,endsAt:c.endsAt,destruct:c.destruct,roomRelays:c.roomRelays,predecessorOperation:c.predecessorOperation})===expected}catch{return false}}
      // Capture options before either native await; no recapture after refusal.
      const browserScope=await captured.browser.capture('invitation:'+id,live),tabScope=await captured.tab.capture('invitation:'+id,live)
      state=new OrdinaryInvitationCreator({...captured,live},browserScope,tabScope)
      await state.#read((b,t,custody)=>{state!.#sources(b,t,custody);if(!state!.#stored(b)&&!state!.#retained(b))state!.#newAllowed(b,t)})
      return state
    }catch(error){if(state)await state.close();else{bearer.fill(0);root.fill(0);key.fill(0)}throw error}
  }
  #live=():boolean=>!this.#closed&&this.#options.live()&&Date.now()<this.#options.tab.expiresAt
  #track<T>(work:Promise<T>):Promise<T>{this.#work.add(work);void work.finally(()=>this.#work.delete(work)).catch(()=>{});return work}
  #input<T>(work:(browser:DeviceStore,tab:DeviceStore,custody:OrdinaryPairCustody)=>T){return{browser:{owner:this.#options.browser,scope:this.#browserScope},
    tab:{owner:this.#options.tab,scope:this.#tabScope},live:this.#live,work:(b:DeviceStore,t:DeviceStore,_bn:readonly string[],_tn:readonly string[],custody:OrdinaryPairCustody)=>work(b,t,custody)}}
  #read<T>(work:(browser:DeviceStore,tab:DeviceStore,custody:OrdinaryPairCustody)=>T):Promise<T>{return this.#track(OrdinaryStateOwner.readPairMigrated(this.#input(work)))}
  #sources(browser:DeviceStore,tab:DeviceStore,custody:OrdinaryPairCustody):Sources{
    const b=new Map(browser.keys().map(n=>[n,browser.get(n)!])),t=new Map(tab.keys().map(n=>[n,tab.get(n)!]))
    try{
      validateOrdinarySnapshot(b,t,{browser:true,tab:true},captureOrdinarySnapshotContext(b,t,custody))
      if(this.#options.account===null){const raw=browser.get('kithmoot.participant');if(raw===null)hold();const key=hexToBytes(raw)
        try{if(getPublicKey(key)!==this.#options.participant)hold()}finally{key.fill(0)}}
      const selected=(store:DeviceStore,kind:'browser'|'tab')=>store.keys().filter(n=>
        ['access','bookmarks','invitationProofs','routing','navigation'].includes(classifyOrdinaryPhysicalName(n,kind)?.family??'')||n==='kithmoot.participant')
        .sort().map(n=>[n,store.get(n)!] as const)
      return{browser:selected(browser,'browser'),tab:selected(tab,'tab')}
    }finally{b.clear();t.clear()}
  }
  /** Locate owned custody even after another invitation becomes selected. */
  #stored(browser:DeviceStore):RetainedCreatorPublication|undefined{
    const checked=inspectPersistentCreatorProofs(browser)
    try{
      const binding={participant:this.#options.participant,invitationId:this.#id},selected=checked.proofs.get(creatorProofName(binding))
      if(!selected)return undefined
      const p=selected.proof
      if(p.binding.account!==this.#options.account||p.binding.roomId!==this.#options.roomId||JSON.stringify(p.binding.browser)!==JSON.stringify(this.#browserScope)||
        p.capability.bearer!==bytesToHex(this.#options.invitation.bearer)||p.capability.inviter!==this.#options.invitation.inviter||
        p.roomSecret!==bytesToHex(this.#options.expectedRoomSecret))hold()
      return copy({proof:p,intent:readCreatorIntent(browser.get(creatorIntentName(binding))!,p)})
    }finally{checked.close()}
  }
  #retained(browser:DeviceStore):RetainedCreatorPublication|undefined{
    const stored=this.#stored(browser)
    if(!stored)return undefined
    const p=stored.proof
    if(!creatorIsSelected(browser,p))hold()
    // Compare signed claims through the source validator, never by plaintext tags.
    const checked=inspectPersistentCreatorProofs(browser)
    try{
      const admission=checked.proofs.get(creatorProofName(p.binding))!.admission
      const matches=p.link===this.#options.link&&p.keep===this.#options.keep&&
        JSON.stringify(p.destinations)===JSON.stringify(this.#options.destinations)&&p.profile===this.#options.profile&&
        p.sourceKind===this.#options.sourceKind&&p.predecessorOperation===(this.#options.predecessorOperation??null)&&
        admission.endsAt===this.#options.endsAt&&(admission.destruct===true)===this.#options.destruct&&
        JSON.stringify(admission.relays)===JSON.stringify(this.#options.roomRelays)
      if(matches)return stored
      if(this.#options.sourceKind==='renewal'&&this.#options.predecessorOperation===p.binding.operation&&
        stored.intent.state==='acknowledged')return undefined
      hold()
    }finally{checked.close()}
  }
  #newAllowed(browser:DeviceStore,tab:DeviceStore):PersistentCreatorProof|undefined{
    const prefix=accountPrefix(this.#options.participant),kind=this.#options.sourceKind
    const checked=inspectPersistentCreatorProofs(browser)
    try{
      const own=checked.proofs.get(creatorProofName({participant:this.#options.participant,invitationId:this.#id}))
      const roomProofs=[...checked.proofs.values()].filter(v=>v.proof.binding.participant===this.#options.participant&&v.proof.binding.roomId===this.#options.roomId)
      if(kind!=='renewal'&&(own||browser.get(prefix+INVITATION_OWNER_PREFIX+this.#id)!==null||browser.get(INVITATION_OWNER_PREFIX+this.#id)!==null))hold()
      if(kind!=='renewal'&&roomProofs.length>=MAX_CREATOR_PROOFS_PER_ROOM)hold()
      const fixed=JSON.parse(browser.get(FIXED_INVITATION_RELAYS)??'{}') as Record<string,unknown>
      if(kind==='new-room'||kind==='dm'){
        if([...checked.proofs.values()].some(v=>v.proof.binding.roomId===this.#options.roomId)||roomProofs.length||browser.get(prefix+ROOM_PREFIX+this.#options.roomId)!==null||browser.get(ROOM_PREFIX+this.#options.roomId)!==null||
          Object.hasOwn(fixed,this.#options.roomId))hold()
        // Fresh creation cannot relabel any retained owner, member or bare room.
        const members=inspectPersistentAdmissionProofs(browser,tab)
        try{if([...members.proofs.values(),...members.selected.values()].some(v=>v.proof.binding.roomId===this.#options.roomId))hold()}
        finally{members.close()}
        for(const store of [browser,tab])for(const name of store.keys()){
          const family=classifyOrdinaryPhysicalName(name,store===browser?'browser':'tab')?.family
          if(name.endsWith(ROOM_PREFIX+this.#options.roomId)||family==='bookmarks'&&name.endsWith('.'+this.#options.roomId))hold()
          if(family!=='access')continue
          const value=JSON.parse(store.get(name)!) as {roomSecret?:string}
          if(value.roomSecret===bytesToHex(this.#options.expectedRoomSecret))hold()
        }
        return undefined
      }
      const selected=roomProofs.filter(v=>creatorIsSelected(browser,v.proof))
      if(selected.length!==1)hold()
      const previous=selected[0]!,p=previous.proof
      if(p.binding.account!==this.#options.account||p.roomSecret!==bytesToHex(this.#options.expectedRoomSecret)||
        p.binding.operation!==this.#options.predecessorOperation||
        readCreatorIntent(browser.get(creatorIntentName(p.binding))!,p).state!=='acknowledged')hold()
      if(kind==='rotation'&&roomProofs.some(v=>v.proof.capability.bearer===bytesToHex(this.#options.invitation.bearer)||
        v.proof.capability.inviter===this.#options.invitation.inviter))hold()
      if(kind==='rotation'?(p.binding.invitationId===this.#id||p.capability.inviter===this.#options.invitation.inviter||p.capability.bearer===bytesToHex(this.#options.invitation.bearer)):(p.binding.invitationId!==this.#id||!own||p.history.length+1>=MAX_CREATOR_SOURCE_EVENTS))hold()
      if(previous.admission.endsAt!==undefined&&(this.#options.endsAt===undefined||this.#options.endsAt>previous.admission.endsAt)||
        previous.admission.destruct&&!this.#options.destruct||kind==='renewal'&&previous.admission.relays!==undefined&&this.#options.roomRelays===undefined)hold()
      return copy(p)
    }finally{checked.close()}
  }
  load():Promise<RetainedCreatorPublication|undefined>{return this.#read((b,t,custody)=>{this.#sources(b,t,custody);return this.#retained(b)})}
  retryRetention():void{this.#options.browser.retryRetention();this.#options.tab.retryRetention()}
  /** Exact retries/reopens return retained bytes before any encoder call. */
  prepare(now:number):Promise<RetainedCreatorPublication>{
    if(!this.#live())return Promise.reject(new OrdinaryStateHold())
    if(this.#preparing)return this.#preparing
    const work=this.#track(this.#prepare(now));this.#preparing=work
    void work.finally(()=>{if(this.#preparing===work)this.#preparing=undefined}).catch(()=>{});return work
  }
  async #prepare(now:number):Promise<RetainedCreatorPublication>{
    const before=await this.#read((b,t,custody)=>{const sources=this.#sources(b,t,custody),retained=this.#retained(b);const predecessor=retained?undefined:this.#newAllowed(b,t);return{sources,retained,predecessor}})
    if(before.retained)return before.retained
    if(!Number.isSafeInteger(now)||now<0||now>Math.floor(Date.now()/1000)||before.predecessor&&this.#options.sourceKind==='renewal'&&now<=before.predecessor.createdAt)hold()
    const event=encodePersistentInvitation({invitation:this.#options.invitation,inviterSk:this.#options.inviterSk,
      roomSecret:this.#options.expectedRoomSecret,now,endsAt:this.#options.endsAt,destruct:this.#options.destruct,relays:this.#options.roomRelays})
    // The exact signed room-relay list is distinct from publication destinations.
    const verified=makePersistentCreatorProof({event,invitation:this.#options.invitation,expectedRoomSecret:this.#options.expectedRoomSecret,
      account:this.#options.account,participant:this.#options.participant,browser:this.#browserScope,link:this.#options.link,keep:this.#options.keep,
      destinations:this.#options.destinations,profile:this.#options.profile,sourceKind:this.#options.sourceKind,
      predecessorOperation:this.#options.predecessorOperation,history:this.#options.sourceKind==='renewal'?[...before.predecessor!.history,before.predecessor!.event]:[]})
    try{
      const proof=verified.proof,intent=creatorIntent(proof)
      return await this.#track(OrdinaryStateOwner.mutatePairMigrated(this.#input((b,t,custody)=>{
        if(JSON.stringify(this.#sources(b,t,custody))!==JSON.stringify(before.sources)||this.#retained(b))hold()
        if(JSON.stringify(this.#newAllowed(b,t))!==JSON.stringify(before.predecessor))hold()
        const scoped=mapped(b,this.#options.participant)
        storeInvitationOwner(scoped,this.#options.invitation,this.#options.expectedRoomSecret,this.#options.inviterSk,proof.createdAt,verified.admission.endsAt,verified.admission.destruct)
        rememberRoom(scoped,{roomId:this.#options.roomId,link:proof.link,openedAt:proof.createdAt,endsAt:verified.admission.endsAt,destruct:verified.admission.destruct})
        setKeepRoom(scoped,this.#options.roomId,proof.keep)
        b.set(creatorProofName(proof.binding),JSON.stringify(proof));b.set(creatorIntentName(proof.binding),JSON.stringify(intent))
        if(verified.admission.relays===undefined&&this.#options.sourceKind==='rotation'){
          const fixed=JSON.parse(b.get(FIXED_INVITATION_RELAYS)??'{}') as Record<string,unknown>
          if(Object.hasOwn(fixed,this.#options.roomId)){delete fixed[this.#options.roomId];b.set(FIXED_INVITATION_RELAYS,JSON.stringify(fixed))}}
        if(verified.admission.relays!==undefined){const connections=new RelayConnections({getItem:n=>b.get(n),setItem:(n,v)=>b.set(n,v)},[])
          connections.setRoomRelays(this.#options.roomId,{fixed:verified.admission.relays,signed:true})
          const fixed=JSON.parse(b.get(FIXED_INVITATION_RELAYS)??'{}') as Record<string,{c:string[];signed:boolean}>
          if(JSON.stringify(fixed[this.#options.roomId])!==JSON.stringify({c:verified.admission.relays,signed:true}))hold()}
        const retained=this.#retained(b);if(!retained||JSON.stringify(retained)!==JSON.stringify({proof,intent}))hold()
        this.#sources(b,t,custody);return retained
      })))
    }finally{verified.admission.secret.fill(0)}
  }
  /** Forget fences this invitation; newer selected room custody is preserved. */
  async forget():Promise<void>{
    await this.#track(OrdinaryStateOwner.forgetPairMigrated(this.#input((b,t,custody)=>{
      this.#sources(b,t,custody);const retained=this.#stored(b);if(!retained)hold()
      const wasSelected=creatorIsSelected(b,retained.proof)
      const prefix=accountPrefix(this.#options.participant)
      for(const n of [creatorProofName(retained.proof.binding),creatorIntentName(retained.proof.binding),prefix+INVITATION_OWNER_PREFIX+this.#id])b.remove(n)
      const roomName=prefix+ROOM_PREFIX+this.#options.roomId
      if(wasSelected)b.remove(roomName)
      const remaining=inspectPersistentCreatorProofs(b)
      try{
        const fixed=JSON.parse(b.get(FIXED_INVITATION_RELAYS)??'{}') as Record<string,{c:string[];signed:boolean}>
        const row=fixed[this.#options.roomId]
        const otherCreator=[...remaining.proofs.values()].some(value=>value.proof.binding.roomId===this.#options.roomId&&
          creatorIsSelected(b,value.proof)&&JSON.stringify(value.admission.relays)===JSON.stringify(row?.c))
        const members=inspectPersistentAdmissionProofs(b,t)
        try{
          const otherMember=[...members.proofs.values(),...members.selected.values()].some(value=>value.proof.binding.roomId===this.#options.roomId&&
            value.proof.roomSecret===retained.proof.roomSecret&&value.proof.selection.relays!==null&&JSON.stringify(value.proof.selection.relays)===JSON.stringify(row?.c))
          if(row&&!otherCreator&&!otherMember){delete fixed[this.#options.roomId];b.set(FIXED_INVITATION_RELAYS,JSON.stringify(fixed))}
        }finally{members.close()}
      }finally{remaining.close()}
      this.#sources(b,t,custody)
    })))
    await this.close()
  }
  async close():Promise<void>{
    this.#closed=true
    await Promise.allSettled([...this.#work])
    this.#options.invitation.bearer.fill(0);this.#options.expectedRoomSecret.fill(0);this.#options.inviterSk.fill(0)
  }
}
