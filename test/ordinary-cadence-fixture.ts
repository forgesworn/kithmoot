import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { deriveRoom } from '../src/room.js'
import { deriveEpoch } from '../src/epoch.js'
import { localIdentity } from '../src/identity.js'
import { createDeviceCredential } from '../src/credential.js'
import { buildCadenceLease, deriveCadenceDropPublicKeys, type CadenceReceipt } from '../src/box-cadence.js'
import { memoryDeviceStore } from '../app/src/device-store.js'
import { prepareCadenceLease, acceptCadenceReceipt } from '../app/src/cadence-store.js'
import type { OrdinaryCadenceChecks } from '../app/src/ordinary-cadence-snapshot.js'

export type CadenceFixtureMode = 'client-excluded' | 'staged' | 'active' | 'cover' | 'ended' | 'person' | 'slot-one' | 'expired' | 'history'
export const CADENCE_FIXTURE_NOW = 1_800_000_000
export const CADENCE_FIXTURE_NODE = 'a'.repeat(52)
export const CADENCE_FAULTS = ['row-json','row-extra','row-version','row-time','physical-room','physical-device','physical-lease','physical-generation',
  'body-extra','body-json','body-version','server','mirror-request','mirror-start','window','hour-overflow','profile','slot','counter',
  'credential-signature','credential-room','credential-device','credential-duplicate','credential-seal','credential-expiry','credential-created','credential-post-window',
  'drop-count','drop-order','drop-counter','drop-duplicate','drop-curve','drop-derived','traffic-room','grant',
  'relay-count','relay-duplicate','relay-canonical','relay-auth','box-local','dest-overlap','ownership','receipt-missing','receipt-state',
  'receipt-code','receipt-scope','receipt-queue','receipt-history','receipt-staged-state','receipt-staged-ended','receipt-staged-queue','receipt-staged-sent','receipt-staged-failed','overlap','legacy-scoped','nested-scoped','namespace','duplicate-json'] as const
/** Real builder, signed credential, derived drop keys and custody writer;
 * receipts are local fixtures shaped like Bothy's real producer, not live
 * authenticated Link responses or current ownership/termination evidence. */
export async function cadenceFixture(mode: CadenceFixtureMode = 'client-excluded', seed = 5) {
  const personaKey = new Uint8Array(32), deviceKey = new Uint8Array(32), secret = new Uint8Array(32).fill(seed)
  personaKey[31] = 4; deviceKey[31] = seed + 10
  const persona = getPublicKey(personaKey), device = getPublicKey(deviceKey), room = deriveRoom(secret)
  const epochSecret = new Uint8Array(32).fill(seed + 30), epoch = deriveEpoch({ epoch: 1, secret: epochSecret })
  const grant = '3'.repeat(32), slot = mode === 'slot-one' ? 1 : 0
  try {
    const credential = await createDeviceCredential({ identity: localIdentity(personaKey), devicePubkey: device,
      ...(mode === 'person' ? { scope: 'person' as const } : { roomId: room.roomId }),
      expiresAt: CADENCE_FIXTURE_NOW + 14_400, now: () => CADENCE_FIXTURE_NOW })
    const request = buildCadenceLease({ nodeId: CADENCE_FIXTURE_NODE, room: room.roomId, trafficRoom: epoch.id, roomGeneration: 2,
      persona, device, credential, grantId: grant, requestId: '2'.repeat(32), leaseId: '1'.repeat(32), generation: 1,
      deviceSlot: slot, currentEpoch: 500000, startEpoch: 500002, endEpoch: 500004, roomKey: epoch.key,
      publicRelays: ['wss://relay-a.example', 'wss://relay-b.example'], circleBoxes: ['local'], now: CADENCE_FIXTURE_NOW })
    const store = memoryDeviceStore(), excluded = prepareCadenceLease(store, CADENCE_FIXTURE_NODE, request, CADENCE_FIXTURE_NOW)
    if (mode !== 'client-excluded') {
      const state = ['staged','active','cover','ended'].includes(mode) ? mode : 'active'
      const receipt: CadenceReceipt = { v: 1, code: mode === 'staged' ? 'staged' : 'status', lease_id: request.lease_id, generation: request.generation,
        state, server_time: CADENCE_FIXTURE_NOW, start_epoch: request.start_epoch, end_epoch: request.end_epoch,
        queue_count: mode === 'history' ? 2 : 0, sent_item_ids: mode === 'history' ? ['a'.repeat(64), 'b'.repeat(64)] : [],
        failed_item_ids: mode === 'history' ? ['a'.repeat(64), 'c'.repeat(64)] : [] }
      acceptCadenceReceipt(store, excluded, receipt, CADENCE_FIXTURE_NOW + (mode === 'expired' ? 1_000_000 : 1))
    }
    const name = store.keys()[0]!, records = new Map(store.keys().map(name => [name, store.get(name)!]))
    const checks: OrdinaryCadenceChecks = { kind: 'browser', acceptsLease: (retained, scope) => {
      if (scope.nodeId !== CADENCE_FIXTURE_NODE || scope.roomId !== room.roomId || scope.device !== device ||
          scope.account !== undefined && scope.account !== persona || retained.persona !== persona || retained.device !== device ||
          retained.traffic_room !== epoch.id || retained.room_generation !== 2 || retained.grant_id !== grant || retained.device_slot !== slot) return false
      const recoveredSecret = new Uint8Array(32).fill(seed + 30), recovered = deriveEpoch({ epoch: 1, secret: recoveredSecret })
      try {
        return JSON.stringify(retained.drop_keys) === JSON.stringify(deriveCadenceDropPublicKeys(recovered.key, persona, retained.start_epoch, retained.end_epoch, slot))
      } finally { recoveredSecret.fill(0); recovered.key.fill(0) }
    } }
    return { records, name, roomId: room.roomId, persona, device, request, checks,
      signCredential: (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, personaKey) }
  } finally { secret.fill(0); room.roomKey.fill(0); epochSecret.fill(0); epoch.key.fill(0); deviceKey.fill(0) }
}

/** Test-only corruption of exact saved bytes; never part of production. */
export function damageCadenceFixture(f: Awaited<ReturnType<typeof cadenceFixture>>, records: Map<string,string>, fault: string): void {
  const saved = JSON.parse(records.get(f.name)!), request = JSON.parse(saved.requestBody)
  if (fault === 'row-extra') saved.extra = true
  if (fault === 'row-version') saved.v = 2
  if (fault === 'row-time') saved.updatedAt = -1
  if (fault === 'body-extra') request.extra = true
  if (fault === 'body-version') request.v = 2
  if (fault === 'server') request.server = 'ws://' + 'b'.repeat(52) + '/events'
  if (fault === 'mirror-request') saved.requestId = '4'.repeat(32)
  if (fault === 'mirror-start') saved.startEpoch++
  if (fault === 'window') { request.end_epoch = request.start_epoch + 169; saved.endEpoch = request.end_epoch }
  if (fault === 'hour-overflow') { request.start_epoch = Number.MAX_SAFE_INTEGER - 2; request.end_epoch = Number.MAX_SAFE_INTEGER; saved.startEpoch = request.start_epoch; saved.endEpoch = request.end_epoch }
  if (fault === 'profile') request.slot_seconds = 30
  if (fault === 'slot') request.device_slot = 2
  if (fault === 'counter') { request.counter_hi = 16; saved.counterHi = 16 }
  if (fault === 'credential-signature') request.credential.sig = '0'.repeat(128)
  if (fault === 'credential-room') request.credential.tags[0][1] = 'a'.repeat(64)
  if (fault === 'credential-device') request.credential.tags[1][1] = 'a'.repeat(64)
  if (fault === 'credential-duplicate') request.credential.tags.push(request.credential.tags[0])
  if (fault === 'credential-seal') request.credential.tags.push(['seal', f.device])
  if (fault === 'credential-expiry') request.credential.tags[2][1] = String(CADENCE_FIXTURE_NOW + 1)
  if (fault === 'credential-created') request.credential.created_at = CADENCE_FIXTURE_NOW + 20_000
  if (fault === 'credential-post-window') {
    request.credential.created_at = request.end_epoch * 3600 + 1
    request.credential.tags[2][1] = String(request.credential.created_at + 3600)
  }
  if (fault.startsWith('credential-') && fault !== 'credential-signature') request.credential = f.signCredential(request.credential)
  if (fault === 'drop-count') request.drop_keys.pop()
  if (fault === 'drop-order') request.drop_keys.reverse()
  if (fault === 'drop-counter') request.drop_keys[0].counter = 8
  if (fault === 'drop-duplicate') request.drop_keys[1].pubkey = request.drop_keys[0].pubkey
  if (fault === 'drop-curve') request.drop_keys[0].pubkey = 'f'.repeat(64)
  if (fault === 'drop-derived') request.drop_keys[0].pubkey = f.device
  if (fault === 'traffic-room') request.traffic_room = 'a'.repeat(64)
  if (fault === 'grant') request.grant_id = '4'.repeat(32)
  if (fault === 'relay-count') request.public_relays.pop()
  if (fault === 'relay-duplicate') request.public_relays[1] = request.public_relays[0]
  if (fault === 'relay-canonical') request.public_relays[0] += '/'
  if (fault === 'relay-auth') request.public_relays[0] = 'wss://name:secret@relay.example'
  if (fault === 'box-local') request.circle_boxes = ['wss://box.example']
  if (fault === 'dest-overlap') request.circle_boxes.push(request.public_relays[0])
  if (fault === 'ownership') saved.ownership = 'ended'
  if (fault === 'receipt-missing') delete saved.receipt
  if (fault === 'receipt-state') saved.receipt.state = 'ended'
  if (fault === 'receipt-code') saved.receipt.code = 'future-success'
  if (fault === 'receipt-scope') saved.receipt.generation++
  if (fault === 'receipt-queue') saved.receipt.queue_count = 257
  if (fault === 'receipt-history') saved.receipt.sent_item_ids = ['a'.repeat(64), 'a'.repeat(64)]
  if (fault.startsWith('receipt-staged-')) {
    saved.receipt.code = 'staged'; saved.receipt.state = 'staged'
    if (fault === 'receipt-staged-state') saved.receipt.state = 'active'
    if (fault === 'receipt-staged-ended') { saved.receipt.state = 'ended'; saved.ownership = 'ended' }
    if (fault === 'receipt-staged-queue') saved.receipt.queue_count = 1
    if (fault === 'receipt-staged-sent') saved.receipt.sent_item_ids = ['a'.repeat(64)]
    if (fault === 'receipt-staged-failed') saved.receipt.failed_item_ids = ['a'.repeat(64)]
  }
  saved.requestBody = fault === 'body-json' ? '{' : JSON.stringify(request)
  records.set(f.name, fault === 'row-json' ? '{' : JSON.stringify(saved))
  if (fault === 'duplicate-json') records.set(f.name, records.get(f.name)!.replace('{', '{"ownership":"ended",'))
  if (fault.startsWith('physical-') || fault === 'namespace' || fault === 'nested-scoped') {
    let name = f.name
    if (fault === 'physical-room') name = name.replace(f.roomId, 'a'.repeat(64))
    if (fault === 'physical-device') name = name.replace(f.device, 'a'.repeat(64))
    if (fault === 'physical-lease') name = name.replace('.' + f.request.lease_id + '.', '.' + '4'.repeat(32) + '.')
    if (fault === 'physical-generation') name = name.replace(/\.1$/, '.01')
    if (fault === 'namespace') name = name.replace('.v1.', '.v2.')
    if (fault === 'nested-scoped') name = 'kithmoot.account.' + f.persona + '.kithmoot.account.' + f.persona + '.' + name
    records.set(name, records.get(f.name)!); records.delete(f.name)
  }
  if (fault === 'legacy-scoped') records.set('kithmoot.account.' + f.persona + '.' + f.name, records.get(f.name)!)
  if (fault === 'overlap') {
    const copy = JSON.parse(JSON.stringify(saved)), body = JSON.parse(copy.requestBody)
    copy.leaseId = body.lease_id = '4'.repeat(32); copy.requestId = body.request_id = '5'.repeat(32)
    if (copy.receipt) copy.receipt.lease_id = copy.leaseId
    copy.requestBody = JSON.stringify(body); records.set(f.name.replace(f.request.lease_id, copy.leaseId), JSON.stringify(copy))
  }
}
