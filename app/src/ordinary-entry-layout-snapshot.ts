import { OrdinaryStateHold, ORDINARY_NAME_UNITS, ordinaryUtf8Length } from './ordinary-state-codec.js'

const layouts = ['kithmoot.call-chat-panel','kithmoot.call-chat-divider','kithmoot.call-view','kithmoot.call-self-corner',
  'kithmoot.call-hide-self','kithmoot.call-hide-no-video','kithmoot.desktopChatDrawerOpen',
  'kithmoot.desktopProjectsRailOpen','kithmoot.desktopProjectsRailWidth']
const booleans = ['kithmoot.notify','kithmoot.notify-text']
const families = [...layouts,...booleans,'kithmoot.knock','kithmoot.invited','kithmoot.conversation']
const hex = /^[0-9a-f]{64}$/
function hold(): never { throw new OrdinaryStateHold() }
function numeric(raw: string, rounded: boolean): void {
  const n=Number(raw)
  // Callable setters persist String(number) / String(Math.round(number)),
  // even NaN/Infinity or values outside today's reader range. Inert custody
  // must not silently clamp these into a current layout setting.
  if (String(rounded ? Math.round(n) : n)!==raw) hold()
}
/** Offline count-only custody. No notification, invitation, admission,
 * channel availability, account, layout application or clock authority.
 * The full physical classifier, same-image binding and protected runtime
 * consumers remain mandatory before startup or any effect. */
export function validateOrdinaryEntryLayoutSnapshot(records:ReadonlyMap<string,string>,_migrated:boolean,
  options:{kind:'browser'|'tab'}):Readonly<{notifications:number;knocks:number;invitedLists:number;invitedEntries:number;
    conversations:number;unboundConversations:number;layouts:number;numericLayouts:number}> {
  if (!['browser','tab'].includes(options.kind)) hold()
  const c={notifications:0,knocks:0,invitedLists:0,invitedEntries:0,conversations:0,unboundConversations:0,layouts:0,numericLayouts:0}
  try {
    for(const [name,raw] of records) {
      if(name.startsWith('kithmoot.account.')&&families.some(f=>name.includes('.'+f))) hold()
      if(!families.some(f=>name===f||name.startsWith(f+'.'))) continue
      if(name.length>ORDINARY_NAME_UNITS||typeof raw!=='string') hold()
      ordinaryUtf8Length(raw)
      const tab=name==='kithmoot.conversation'||name.startsWith('kithmoot.conversation.')
      if(tab?options.kind!=='tab':options.kind!=='browser') hold()
      if(booleans.includes(name)) {
        if(raw!=='true'&&raw!=='false') hold();c.notifications++
      } else if(name.startsWith('kithmoot.knock.v1.')&&hex.test(name.slice('kithmoot.knock.v1.'.length))) {
        if(raw!=='true'&&raw!=='false') hold();c.knocks++
      } else if(name.startsWith('kithmoot.invited.v1.')&&hex.test(name.slice('kithmoot.invited.v1.'.length))) {
        const v:unknown=JSON.parse(raw)
        // invitedTo carries arbitrary strings; Set removes duplicates. The
        // generic sweep writer can subsequently leave a real empty list.
        if(JSON.stringify(v)!==raw||!Array.isArray(v)||v.length>200||v.some(p=>typeof p!=='string')||new Set(v).size!==v.length) hold()
        c.invitedLists++;c.invitedEntries+=v.length
      } else if(tab) {
        const m=/^kithmoot\.conversation\.v1\.(visitor|[0-9a-f]{64})\.([0-9a-f]{64}|undefined)$/.exec(name)
        if(!m) hold()
        c.conversations++;if(m[2]==='undefined') c.unboundConversations++
        // The primary key getter can return an undefined room before entry.
        // Keep that exact unbound candidate; never assign it to another room.
      } else if(layouts.includes(name)) {
        if(['kithmoot.call-chat-panel','kithmoot.desktopChatDrawerOpen'].includes(name)) {
          if(!['open','closed'].includes(raw)) hold()
        } else if(name==='kithmoot.desktopProjectsRailOpen') {
          if(!['open','collapsed'].includes(raw)) hold()
        } else if(name==='kithmoot.call-view') {
          if(!['gallery','speaker'].includes(raw)) hold()
        } else if(name==='kithmoot.call-self-corner') {
          if(!['top-left','top-right','bottom-left','bottom-right'].includes(raw)) hold()
        } else if(name==='kithmoot.call-hide-self'||name==='kithmoot.call-hide-no-video') {
          if(!['true','false'].includes(raw)) hold()
        } else {numeric(raw,name==='kithmoot.desktopProjectsRailWidth');c.numericLayouts++}
        c.layouts++
      } else hold()
    }
    return Object.freeze(c)
  } catch {return hold()}
}
