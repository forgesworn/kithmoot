export const ENTRY_ROOM='a'.repeat(64)
export const ENTRY_MODES=['browser-all','notification-off','notification-first-cut','knock-off','invited-opaque',
  'invited-cap','invited-scrub-empty','layout-closed','layout-corners','layout-reader-ignored',
  'layout-nonfinite','layout-clamped-callers','tab-account','tab-visitor','tab-empty','tab-unbound'] as const
export type EntryMode=typeof ENTRY_MODES[number]
export const ENTRY_FAULTS=['wrapped','version','notification','knock-room','knock-value','invited-type',
  'invited-duplicate','invited-cap','invited-json','layout-variant','panel','view','corner','hide','divider','width','rail'] as const
export type EntryFault=typeof ENTRY_FAULTS[number]
export const ENTRY_TAB_FAULTS=['tab-version','tab-account','tab-room','tab-wrapped'] as const
export type EntryTabFault=typeof ENTRY_TAB_FAULTS[number]
export function damageEntryLayoutFixture(records:Map<string,string>,fault:EntryFault|EntryTabFault):void {
  const invited='kithmoot.invited.v1.'+ENTRY_ROOM,conversation=[...records.keys()].find(k=>k.startsWith('kithmoot.conversation.'))
  switch(fault) {
    case 'wrapped':records.set('kithmoot.account.'+ENTRY_ROOM+'.kithmoot.notify','true');break
    case 'version':records.set('kithmoot.knock.v2.'+ENTRY_ROOM,'true');break
    case 'notification':records.set('kithmoot.notify','1');break
    case 'knock-room':records.set('kithmoot.knock.v1.bad','true');break
    case 'knock-value':records.set('kithmoot.knock.v1.'+ENTRY_ROOM,'yes');break
    case 'invited-type':records.set(invited,'[1]');break
    case 'invited-duplicate':records.set(invited,'["opaque","opaque"]');break
    case 'invited-cap':records.set(invited,JSON.stringify(Array.from({length:201},(_,i)=>String(i))));break
    case 'invited-json':records.set(invited,' '+records.get(invited));break
    case 'layout-variant':records.set('kithmoot.call-view.v2','gallery');break
    case 'panel':records.set('kithmoot.call-chat-panel','true');break
    case 'view':records.set('kithmoot.call-view','share');break
    case 'corner':records.set('kithmoot.call-self-corner','middle');break
    case 'hide':records.set('kithmoot.call-hide-self','1');break
    case 'divider':records.set('kithmoot.call-chat-divider','0.40');break
    case 'width':records.set('kithmoot.desktopProjectsRailWidth','287.5');break
    case 'rail':records.set('kithmoot.desktopProjectsRailOpen','closed');break
    case 'tab-version':records.set('kithmoot.conversation.v2.visitor.'+ENTRY_ROOM,'');break
    case 'tab-account':records.set('kithmoot.conversation.v1.bad.'+ENTRY_ROOM,'agents');break
    case 'tab-room':records.set('kithmoot.conversation.v1.visitor.null','agents');break
    case 'tab-wrapped':records.set('kithmoot.account.'+ENTRY_ROOM+'.'+conversation,records.get(conversation!)!);break
  }
}
