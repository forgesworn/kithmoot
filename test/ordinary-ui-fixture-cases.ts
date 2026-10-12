export const UI_ROOM = 'a'.repeat(64)
export const UI_MODES = ['browser-all', 'booleans-off', 'profile-opaque', 'profile-cap', 'fold-open', 'fold-all',
  'delay-zero', 'delay-ten', 'tone-zero', 'tone-five', 'recents-duplicate', 'recents-cap',
  'tombstone-duplicate', 'tombstone-extension', 'tombstone-expired', 'tombstone-cap', 'legacy-desktop-bell',
  'tab-all', 'tab-no-account', 'tab-stale-switch', 'tab-empty-hash', 'tab-empty-notice'] as const
export type UiMode = typeof UI_MODES[number]
export const UI_FAULTS = ['wrapped', 'family-root', 'version', 'boolean', 'name', 'account', 'method',
  'profile-type', 'profile-cap', 'profile-empty', 'room-id', 'room-name', 'room-at', 'room-extra',
  'fold', 'fold-value', 'delay', 'nudge-room', 'nudge-off', 'heads-up', 'tombstone-id', 'tombstone-at',
  'tombstone-empty', 'tombstone-cap', 'tone', 'recents-type', 'recents-empty', 'recents-cap', 'noncanonical-json'] as const
export type UiFault = typeof UI_FAULTS[number]
export const UI_TAB_FAULTS = ['way-back-link', 'way-back-extra', 'switch-hash', 'switch-account', 'switch-at',
  'switch-extra', 'tab-version', 'tab-wrapped'] as const
export type UiTabFault = typeof UI_TAB_FAULTS[number]
export function damageUiFixture(records: Map<string, string>, fault: UiFault | UiTabFault): void {
  const room = 'kithmoot.room-name.v1.' + UI_ROOM, profile = 'kithmoot.profiles.lastKnownName.v1'
  const tomb = 'kithmoot.destructed.v1', recents = 'kithmoot:emoji:recents', sw = 'kithmoot.room-switch.v1'
  const change = (key: string, f: (v: any) => void) => { const v = JSON.parse(records.get(key)!); f(v); records.set(key, JSON.stringify(v)) }
  switch (fault) {
    case 'wrapped': records.set('kithmoot.account.' + UI_ROOM + '.kithmoot.name', 'Library'); break
    case 'family-root': records.set('kithmoot.room-name', '{}'); break
    case 'version': records.set('kithmoot.profiles.lastKnownName.v2', '{}'); break
    case 'boolean': records.set('kithmoot.agents-hear', '1'); break
    case 'name': records.set('kithmoot.name', '\u0000'); break
    case 'account': records.set('kithmoot.last-nostr-account', UI_ROOM.toUpperCase()); break
    case 'method': records.set('kithmoot.last-nostr-method', ''); break
    case 'profile-type': change(profile, v => { v.bad = 3 }); break
    case 'profile-cap': records.set(profile, JSON.stringify(Object.fromEntries(Array.from({length:501}, (_,i) => [String(i), 'Name'])))); break
    case 'profile-empty': records.set(profile, '{}'); break
    case 'room-id': records.set('kithmoot.room-name.v1.bad', records.get(room)!); records.delete(room); break
    case 'room-name': change(room, v => { v.name = '\u0000' }); break
    case 'room-at': change(room, v => { v.at = 0 }); break
    case 'room-extra': change(room, v => { v.authority = true }); break
    case 'fold': records.set('kithmoot.home.fold.unknown', 'open'); break
    case 'fold-value': records.set('kithmoot.home.fold.older', 'true'); break
    case 'delay': records.set('kithmoot.send-delay', '05'); break
    case 'nudge-room': records.set('kithmoot.nudge.bad', 'true'); break
    case 'nudge-off': records.set('kithmoot.nudge.' + UI_ROOM, 'false'); break
    case 'heads-up': records.set('kithmoot.destruct-heads-up.' + UI_ROOM, '1e3'); break
    case 'tombstone-id': change(tomb, v => { v[0].id = 'bad' }); break
    case 'tombstone-at': change(tomb, v => { v[0].at = '1' }); break
    case 'tombstone-empty': records.set(tomb, '[]'); break
    case 'tombstone-cap': change(tomb, v => { while(v.length < 51) v.push(v[0]) }); break
    case 'tone': records.set('kithmoot:emoji:skinTone', '6'); break
    case 'recents-type': records.set(recents, '[1]'); break
    case 'recents-empty': records.set(recents, '[]'); break
    case 'recents-cap': records.set(recents, JSON.stringify(Array(37).fill('😀'))); break
    case 'noncanonical-json': records.set(profile, ' ' + records.get(profile)); break
    case 'way-back-link': change('kithmoot.way-back', v => { v.link = '' }); break
    case 'way-back-extra': change('kithmoot.way-back', v => { v.admitted = true }); break
    case 'switch-hash': change(sw, v => { v.hash = 'room' }); break
    case 'switch-account': change(sw, v => { v.account = 'wrong' }); break
    case 'switch-at': change(sw, v => { v.at = -1 }); break
    case 'switch-extra': change(sw, v => { v.admitted = true }); break
    case 'tab-version': records.set('kithmoot.room-switch.v2', records.get(sw)!); break
    case 'tab-wrapped': records.set('kithmoot.account.' + UI_ROOM + '.' + sw, records.get(sw)!); break
  }
}
