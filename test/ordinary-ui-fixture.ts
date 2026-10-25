/// <reference lib="dom.iterable" />
import { base64urlnopad } from '@scure/base'
import { bytesToHex } from '@noble/hashes/utils'
import { sanitiseDisplayName } from '../src/display-name.js'
import { renameRoomOp } from '../src/room-name.js'
import { LastKnownNames } from '../app/src/profile-name.js'
import { addTombstone, dismissTombstone } from '../app/src/self-destruct.js'
import { scrubStore } from '../app/src/storage-scrub.js'
import { capturedMainWriter } from './ordinary-main-writer-fixture.js'
import { capturedStorageExpression, capturedRecentWriter, primaryModuleProvenance, type WriterProvenance } from './ordinary-ui-writer-fixture.js'
import { UI_ROOM, type UiMode } from './ordinary-ui-fixture-cases.js'
export * from './ordinary-ui-fixture-cases.js'

/** Primary writer cuts with explicitly substituted globals and memory stores.
 * No surrounding bootstrap, controls, identity, catalogue or permission proof. */
export function uiFixture(mode: UiMode = 'browser-all') {
  const records = new Map<string, string>(), provenance: WriterProvenance[] = []
  const storage = { getItem:(k:string)=>records.get(k)??null, setItem:(k:string,v:string)=>{records.set(k,v)}, removeItem:(k:string)=>{records.delete(k)} }
  const deviceStore = { get:storage.getItem,set:storage.setItem,remove:storage.removeItem,keys:()=>[...records.keys()] }
  const main = (name:string,constants:string[],globals:Record<string,unknown>) => {
    const f = capturedMainWriter(name, constants, globals)
    provenance.push({file:'app/src/main.ts',...f.provenance,substitution:'Exact function; synthetic globals/memory Storage, surrounding app and controls omitted'})
    return f.write
  }
  const expression = (opts:Parameters<typeof capturedStorageExpression>[0]) => {
    const f = capturedStorageExpression(opts); provenance.push(f.provenance); f.write()
  }
  const all = mode === 'browser-all', kind: 'browser' | 'tab' = mode.startsWith('tab-') ? 'tab' : 'browser'
  if (kind === 'tab') {
    const encodePayload = main('encodePayload',[],{linkRelays:(r:string[])=>r,roomInvitationCapability:undefined,
      base64urlnopad,roomSecret:new Uint8Array(32).fill(11),roomPolicy:undefined,roomName:'Library',bytesToHex,TextEncoder}) as unknown as (...args:unknown[])=>string
    const encodeRoomUrl = main('encodeRoomUrl',[],{encodePayload})
    main('rememberWayBack',['WAY_BACK_KEY'],{currentRoomId:()=>UI_ROOM,sessionStorage:storage,encodeRoomUrl,
      joinLinkBase:()=> 'https://room.invalid/j/',relays:['wss://route.invalid/'],iceUrls:[],currentRoomLabel:()=> 'Library'})()
    expression({receiver:'sessionStorage',key:'ROOM_SWITCH_KEY',constants:['ROOM_SWITCH_KEY'],globals:{sessionStorage:storage,
      location:{hash:mode==='tab-empty-hash'?'':'#candidate'},nostrSession:mode==='tab-no-account'?undefined:{pubkey:UI_ROOM},
      Date:{now:()=>mode==='tab-stale-switch'?0:1700000000000}}})
    expression({within:'leaveWithNotice',receiver:'sessionStorage',key:'NOTICE_STORAGE_KEY',constants:['NOTICE_STORAGE_KEY'],
      globals:{sessionStorage:storage,message:mode==='tab-empty-notice'?'':'A room ended'}})
    return {kind,records,provenance}
  }
  if (all || mode === 'booleans-off') {
    const on = mode !== 'booleans-off'
    expression({receiver:'deviceStore',key:"'kithmoot.mirror-self'",globals:{deviceStore,mirrorSelf:()=>!on}})
    expression({receiver:'deviceStore',key:"'kithmoot.zen-bell'",globals:{deviceStore,zenBellEnabled:()=>!on}})
    expression({receiver:'localStorage',key:'FISH_STORAGE_KEY',constants:['FISH_STORAGE_KEY'],globals:{localStorage:storage,fishEnabled:on}})
    expression({receiver:'localStorage',key:'FRAMING_STORAGE_KEY',constants:['FRAMING_STORAGE_KEY'],globals:{localStorage:storage,framingEnabled:on}})
    expression({within:'setAgentsMayHear',receiver:'localStorage',key:'AGENTS_HEAR_STORAGE_KEY',constants:['AGENTS_HEAR_STORAGE_KEY'],globals:{localStorage:storage,on}})
    expression({receiver:'localStorage',key:"'kithmoot.profiles.enabled'",globals:{localStorage:storage,enabled:on}})
  }
  if (all) {
    provenance.push(primaryModuleProvenance('src/room-name.ts','Actual renameRoomOp with synthetic name, id and time; no signed control flow'))
    main('storeName',['NAME_STORAGE_KEY'],{localStorage:storage,typedName:'',sanitiseDisplayName})('Library')
    main('rememberAccount',['ACCOUNT_STORAGE_KEY','ACCOUNT_METHOD_STORAGE_KEY'],{localStorage:storage,expectedAccount:undefined,expectedMethod:undefined})({pubkey:UI_ROOM,signer:{method:'nip07'}})
    main('storeRoomNameRecord',['ROOM_NAME_PREFIX'],{localStorage:storage})(UI_ROOM,renameRoomOp('Library',1700000000000,'b'.repeat(32)))
    expression({within:'setNudge',receiver:'localStorage',key:'NUDGE_PREFIX + roomId',constants:['NUDGE_PREFIX'],globals:{localStorage:storage,roomId:UI_ROOM}})
    expression({within:'sendHeadsUps',receiver:'localStorage',key:'key',globals:{localStorage:storage,key:'kithmoot.destruct-heads-up.'+UI_ROOM,now:1700000000}})
  }
  if (all || mode.startsWith('profile-')) {
    provenance.push(primaryModuleProvenance('app/src/profile-name.ts','Actual LastKnownNames with synthetic seed; no verified profile'))
    const seed: [string,string][] = mode==='profile-opaque' ? [['opaque remembered key',''],['__proto__','unverified cached name']]
      : mode==='profile-cap' ? Array.from({length:500},(_,i)=>['old-'+i,'Old']) : []
    const lastKnownProfileNames = new LastKnownNames(500,seed)
    main('rememberProfileName',['LAST_KNOWN_PROFILE_NAME_KEY'],{lastKnownProfileNames,deviceStore})(UI_ROOM,'Library')
  }
  if (all || mode.startsWith('fold-')) {
    const write = main('setSectionFolded',['FOLD_PREFIX'],{localStorage:storage})
    for (const section of mode==='fold-all'?['pinned','unread','recent','older','other','ended']:['older']) write(section,mode!=='fold-open')
  }
  if (all || mode.startsWith('delay-')) expression({receiver:'localStorage',key:'SEND_DELAY_KEY',constants:['SEND_DELAY_KEY'],
    globals:{localStorage:storage,SEND_DELAYS:[0,5,10],delay:{value:mode==='delay-zero'?'0':mode==='delay-ten'?'10':'5'}}})
  if (all || mode.startsWith('tone-')) expression({file:'app/src/emoji-preferences.ts',within:'setPreferredSkinTone',receiver:'localStorage',key:'toneKey',constants:['toneKey'],
    globals:{localStorage:storage,tone:mode==='tone-zero'?0:mode==='tone-five'?5:2}})
  if (all || mode.startsWith('recents-')) {
    if (mode==='recents-duplicate') records.set('kithmoot:emoji:recents','["😀","😀"]')
    if (mode==='recents-cap') records.set('kithmoot:emoji:recents',JSON.stringify(Array.from({length:36},(_,i)=>'synthetic-choice-'+i)))
    const f = capturedRecentWriter(storage,s=>s?{emoji:s}:undefined); provenance.push(f.provenance); f.write('👍')
  }
  if (all || mode.startsWith('tombstone-')) {
    provenance.push(primaryModuleProvenance('app/src/self-destruct.ts','Actual add/dismissTombstone with memory store, synthetic id/time/extension seed; no deletion'))
    if (mode==='tombstone-extension') records.set('kithmoot.destructed.v1',JSON.stringify([{id:'b'.repeat(16),at:-1.5,old:{opaque:true}}]))
    if (mode==='tombstone-extension') dismissTombstone(deviceStore,'c'.repeat(16))
    else {
      addTombstone(deviceStore,mode==='tombstone-expired'?0:1700000000,mode==='tombstone-scrub-empty'?UI_ROOM:'b'.repeat(16))
      if (mode==='tombstone-duplicate') addTombstone(deviceStore,1700000000,'b'.repeat(16))
      if (mode==='tombstone-cap') for(let i=0;i<51;i++) addTombstone(deviceStore,1700000000+i,i.toString(16).padStart(16,'0'))
    }
  }
  if(mode.endsWith('-scrub-empty')) {
    provenance.push(primaryModuleProvenance('app/src/storage-scrub.ts','Actual generic sweep API with synthetic targets; recents target is an emoji, not the main room-only caller; no app forget/deletion acceptance'))
    scrubStore(deviceStore,[mode==='recents-scrub-empty'?'👍':UI_ROOM])
  }
  // Synthetic compatibility reader format; no historical writer was found.
  if (mode==='legacy-desktop-bell') records.set('kithmoot.desktop-bell','false')
  return {kind,records,provenance}
}
