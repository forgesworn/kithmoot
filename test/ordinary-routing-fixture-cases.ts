export const ROUTING_MODES = ['all', 'saved-default', 'saved-room', 'saved-inherited', 'saved-empty',
  'saved-carried-sixteen', 'saved-carried-circle', 'saved-carried-readonly', 'fixed-unsigned', 'fixed-signed',
  'fixed-empty', 'marks-normal', 'marks-empty', 'marks-opaque-carried', 'room-record', 'room-record-zero',
  'room-record-inert-signature'] as const
export type RoutingMode = typeof ROUTING_MODES[number]
export const ROUTING_FAULTS = ['wrapped', 'family-root', 'version', 'scope', 'noncanonical-json',
  'saved-empty-array', 'saved-string-entry', 'saved-url', 'saved-duplicate', 'saved-both-off', 'saved-extra',
  'saved-circle-false', 'saved-cap', 'marks-type', 'marks-duplicate', 'fixed-room', 'fixed-signed-type',
  'fixed-empty-relays', 'fixed-duplicate', 'fixed-url', 'fixed-extra', 'record-room', 'record-version',
  'record-signature-format', 'record-order', 'record-duplicate', 'record-extra'] as const
export type RoutingFault = typeof ROUTING_FAULTS[number]
export const ROUTING_ROOM = 'a'.repeat(64)
const saved = 'kithmoot.relays.v1', fixed = 'kithmoot.room-relays-fixed.v1', marks = 'kithmoot.circle.v1'
const record = 'kithmoot.room-relays.v1.' + ROUTING_ROOM
export function damageRoutingFixture(records: Map<string, string>, fault: RoutingFault): void {
  const change = (key: string, f: (row: any) => void) => { const v = JSON.parse(records.get(key)!); f(v); records.set(key, JSON.stringify(v)) }
  switch (fault) {
    case 'wrapped': records.set('kithmoot.account.' + ROUTING_ROOM + '.' + saved, records.get(saved)!); records.delete(saved); break
    case 'family-root': records.set('kithmoot.relays', '{}'); break
    case 'version': records.set('kithmoot.relays.v2', records.get(saved)!); break
    case 'scope': change(saved, v => { v['account:' + ROUTING_ROOM] = v.default }); break
    case 'noncanonical-json': records.set(saved, ' ' + records.get(saved)); break
    case 'saved-empty-array': change(saved, v => { v.default = [] }); break
    case 'saved-string-entry': change(saved, v => { v.default = ['wss://route.invalid/'] }); break
    case 'saved-url': change(saved, v => { v.default[0].url = 'wss://ROUTE.invalid' }); break
    case 'saved-duplicate': change(saved, v => { v.default.push(v.default[0]) }); break
    case 'saved-both-off': change(saved, v => { v.default[0].read = false; v.default[0].write = false }); break
    case 'saved-extra': change(saved, v => { v.default[0].permission = true }); break
    case 'saved-circle-false': change(saved, v => { v.default[0].circle = false }); break
    case 'saved-cap': change(saved, v => { v.default = Array.from({length:17}, (_,i) => ({url:`wss://r${i}.invalid/`,read:true,write:true})) }); break
    case 'marks-type': records.set(marks, '[1]'); break
    case 'marks-duplicate': records.set(marks, '["opaque","opaque"]'); break
    case 'fixed-room': change(fixed, v => { v['bad-room'] = v[ROUTING_ROOM] }); break
    case 'fixed-signed-type': change(fixed, v => { v[ROUTING_ROOM].signed = 'true' }); break
    case 'fixed-empty-relays': change(fixed, v => { v[ROUTING_ROOM].c = [] }); break
    case 'fixed-duplicate': change(fixed, v => { v[ROUTING_ROOM].c.push(v[ROUTING_ROOM].c[0]) }); break
    case 'fixed-url': change(fixed, v => { v[ROUTING_ROOM].c = ['https://route.invalid/'] }); break
    case 'fixed-extra': change(fixed, v => { v[ROUTING_ROOM].authority = ROUTING_ROOM }); break
    case 'record-room': records.set('kithmoot.room-relays.v1.bad-room', records.get(record)!); records.delete(record); break
    case 'record-version': change(record, v => { v.version = -1 }); break
    case 'record-signature-format': change(record, v => { v.sig = 'not-a-signature' }); break
    case 'record-order': change(record, v => { v.relays.reverse() }); break
    case 'record-duplicate': change(record, v => { v.relays.push(v.relays[0]) }); break
    case 'record-extra': change(record, v => { v.authority = ROUTING_ROOM }); break
  }
}
