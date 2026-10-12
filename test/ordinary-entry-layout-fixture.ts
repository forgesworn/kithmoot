/// <reference lib="dom.iterable" />
import { setNotifySettings, NOTIFY_TEXT_STORAGE_KEY } from '../app/src/notify.js'
import { saveChatPanel, saveChatDividerFraction } from '../app/src/call-focus-model.js'
import { savePref, VIEW_KEY, CORNER_KEY, HIDE_SELF_KEY, HIDE_NO_VIDEO_KEY } from '../app/src/call-layout.js'
import { saveDrawerOpen } from '../app/src/desktop-chat-drawer.js'
import { saveRailOpen, saveRailWidth, clampRailWidth } from '../app/src/desktop-projects-rail.js'
import { chatDividerFraction } from '../app/src/desktop-panes.js'
import { scrubStore } from '../app/src/storage-scrub.js'
import { capturedMainWriter } from './ordinary-main-writer-fixture.js'
import { capturedStorageExpression, primaryModuleProvenance, type WriterProvenance } from './ordinary-ui-writer-fixture.js'
import { ENTRY_ROOM, type EntryMode } from './ordinary-entry-layout-fixture-cases.js'
export * from './ordinary-entry-layout-fixture-cases.js'

/** Exact primary functions/captured main cuts with synthetic globals. No
 * app controls, real identity, invitation, notification or layout effects. */
export function entryLayoutFixture(mode:EntryMode='browser-all') {
  const records=new Map<string,string>(),provenance:WriterProvenance[]=[]
  const storage={getItem:(k:string)=>records.get(k)??null,setItem:(k:string,v:string)=>{records.set(k,v)},removeItem:(k:string)=>{records.delete(k)}}
  const deviceStore={get:storage.getItem,set:storage.setItem,remove:storage.removeItem,keys:()=>[...records.keys()]}
  const primary=(file:string,substitution='Actual exported writer with synthetic parameters/memory Storage; no controls')=>provenance.push(primaryModuleProvenance(file,substitution))
  const main=(name:string,constants:string[],globals:Record<string,unknown>)=>{
    const f=capturedMainWriter(name,constants,globals);provenance.push({file:'app/src/main.ts',...f.provenance,substitution:'Exact function with explicitly injected globals; no surrounding app'});return f.write
  }
  const all=mode==='browser-all',kind:'browser'|'tab'=mode.startsWith('tab-')?'tab':'browser'
  if(kind==='tab') {
    const key=main('conversationStorageKey',[],{nostrSession:mode==='tab-account'?{pubkey:ENTRY_ROOM}:undefined,
      currentRoomId:()=>mode==='tab-unbound'?undefined:ENTRY_ROOM})
    const f=capturedStorageExpression({within:'selectChannel',receiver:'sessionStorage',key:'conversationStorageKey()',
      globals:{sessionStorage:storage,conversationStorageKey:key,name:mode==='tab-empty'?undefined:'agents'}})
    provenance.push(f.provenance);f.write();return {kind,records,provenance}
  }
  if(all||mode.startsWith('notification-')) {
    primary('app/src/notify.ts')
    if(mode==='notification-first-cut') {
      try {setNotifySettings({...deviceStore,set:(k,v)=>{if(k===NOTIFY_TEXT_STORAGE_KEY)throw Error('Synthetic second-write interruption');deviceStore.set(k,v)}},{enabled:true,showText:true})} catch { /* Exact first writer cut remains. */ }
    } else setNotifySettings(deviceStore,{enabled:mode!=='notification-off',showText:mode!=='notification-off'})
  }
  if(all||mode==='knock-off') main('setKnock',['KNOCK_KEY_PREFIX'],{deviceStore})(ENTRY_ROOM,mode!=='knock-off')
  if(all||mode.startsWith('invited-')) {
    if(mode==='invited-opaque') records.set('kithmoot.invited.v1.'+ENTRY_ROOM,'["opaque",""]')
    const invitedTo=main('invitedTo',['INVITED_KEY_PREFIX'],{deviceStore})
    const write=main('noteInvited',['INVITED_KEY_PREFIX'],{deviceStore,invitedTo})
    write(ENTRY_ROOM,'b'.repeat(64))
    if(mode==='invited-cap') for(let i=0;i<201;i++)write(ENTRY_ROOM,i.toString(16).padStart(64,'0'))
    if(mode==='invited-scrub-empty') {primary('app/src/storage-scrub.ts','Actual generic sweep with synthetic identifier; no remote deletion or app forget');scrubStore(deviceStore,['b'.repeat(64)])}
  }
  if(all||mode.startsWith('layout-')) {
    for(const file of ['call-focus-model','call-layout','desktop-chat-drawer','desktop-projects-rail','desktop-panes'])primary('app/src/'+file+'.ts')
    const open=mode!=='layout-closed'
    saveChatPanel(storage,open);saveDrawerOpen(storage,open);saveRailOpen(storage,open)
    savePref(storage,VIEW_KEY,open?'speaker':'gallery');savePref(storage,CORNER_KEY,mode==='layout-corners'?'top-left':'bottom-right')
    savePref(storage,HIDE_SELF_KEY,open);savePref(storage,HIDE_NO_VIDEO_KEY,open)
    const fraction=mode==='layout-reader-ignored'?-1:mode==='layout-nonfinite'?Number.NaN:mode==='layout-clamped-callers'?chatDividerFraction(200,1000):0.4
    const width=mode==='layout-reader-ignored'?-176:mode==='layout-nonfinite'?Number.POSITIVE_INFINITY:mode==='layout-clamped-callers'?clampRailWidth(10000,1200):287.6
    saveChatDividerFraction(storage,fraction);saveRailWidth(storage,width)
  }
  return {kind,records,provenance}
}
