/// <reference lib="dom.iterable" />
// The primary browser class uses iterable NodeList; match its app TS lib here.
import { RelayConnections } from '../app/src/relay-settings.js'
import { canonicalRoomRelays, signRoomRelays } from '../src/room-relays.js'
import { capturedMainWriter } from './ordinary-main-writer-fixture.js'
import { ROUTING_ROOM, type RoutingMode } from './ordinary-routing-fixture-cases.js'
export * from './ordinary-routing-fixture-cases.js'

/** Actual RelayConnections writers without opening a pool. The main record
 * saver is exact captured source with injected memory Storage; signatures use
 * a synthetic key. No controls, relay, permission or current authority proof. */
export function routingFixture(mode: RoutingMode = 'all') {
  const records = new Map<string, string>()
  const storage = { getItem: (k: string) => records.get(k) ?? null, setItem: (k: string, v: string) => { records.set(k, v) } }
  const relays = [{ url: 'wss://route.invalid/', read: true, write: true }]
  if (mode === 'saved-carried-sixteen' || mode === 'saved-carried-readonly' || mode === 'saved-carried-circle') {
    const entries = mode === 'saved-carried-sixteen' ? Array.from({length:16}, (_,i) => ({url:`wss://r${i}.invalid/`,read:true,write:true}))
      : mode === 'saved-carried-readonly' ? [{...relays[0]!,write:false}] : [{...relays[0]!,circle:true}]
    // Explicit synthetic older-format seed accepted by the actual constructor.
    records.set('kithmoot.relays.v1', JSON.stringify({ ['room:' + ROUTING_ROOM]: entries }))
  }
  if (mode === 'marks-opaque-carried') records.set('kithmoot.circle.v1', '["old opaque mark",""]')
  const connections = new RelayConnections(storage, ['wss://route.invalid/'])
  if (mode === 'all' || mode.startsWith('saved-')) {
    const scope = mode === 'saved-room' || mode === 'saved-empty' ? 'room:' + ROUTING_ROOM : 'default'
    connections.save(scope, relays)
    if (mode === 'saved-inherited') connections.inheritDefaults('room:' + ROUTING_ROOM)
    if (mode === 'saved-empty') connections.forgetRoom(ROUTING_ROOM)
  }
  if (mode === 'all' || mode.startsWith('fixed-')) {
    connections.setRoomRelays(ROUTING_ROOM, { fixed: ['wss://z.invalid/', 'wss://a.invalid/'], signed: mode !== 'fixed-unsigned' })
    if (mode === 'fixed-empty') connections.forgetRoom(ROUTING_ROOM)
  }
  if (mode === 'all' || mode.startsWith('marks-')) {
    connections.markCircle('wss://marked.invalid', true)
    if (mode === 'marks-empty') connections.markCircle('wss://marked.invalid', false)
  }
  const captured = capturedMainWriter('storeRoomRelayRecord', ['ROOM_RELAYS_PREFIX'], { localStorage: storage })
  if (mode === 'all' || mode.startsWith('room-record')) {
    const urls = canonicalRoomRelays(['wss://z.invalid', 'wss://a.invalid']), version = mode === 'room-record-zero' ? 0 : 1700000000
    const authoritySk = new Uint8Array(32).fill(7)
    let sig: string
    try { sig = signRoomRelays({ roomId: ROUTING_ROOM, version, relays: urls, authoritySk }) } finally { authoritySk.fill(0) }
    // A format-valid altered signature is deliberately inert custody. The
    // helper cannot verify it without the omitted authority; composite owes it.
    if (mode === 'room-record-inert-signature') sig = (sig[0] === '0' ? '1' : '0') + sig.slice(1)
    captured.write(ROUTING_ROOM, { relays: urls, version, sig })
  }
  return { records, provenance: captured.provenance }
}
