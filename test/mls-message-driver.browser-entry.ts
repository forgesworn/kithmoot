export * from './mls-room-operations.browser-entry.js'
import { messageDriverFixture, restart, restartJoin, update, read, send, readJoin } from './mls-room-operations.browser-entry.js'
import { BrowserMlsMessageDriver } from '../app/src/mls-message-driver.js'
import { BrowserMlsBoxClient } from '../app/src/mls-box-client.js'
import { readMlsRoom, saveMlsRoom } from '../app/src/mls-room-store.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { verifyEvent } from 'nostr-tools/pure'
import { base32 } from '@scure/base'
import { base64Encode } from '../app/src/mls-vault.js'
import type { PersonaWitnessRoute } from '../app/src/mls-persona-store.js'
import type { LinkRequest } from '../app/src/browser-link-types.js'

let release!: () => void, entered = false, pending: Promise<any>, driver: BrowserMlsMessageDriver
export const driverReady = () => !!driver
export const driverWaiting = () => entered
export function releaseDriver() { release?.() }
export async function finishDriver() { return pending }
export async function stopDriver() { await driver.close() }
export function startDriver(route: PersonaWitnessRoute, mode: string) { entered = false; pending = driverScenario(route, mode) }

export async function driverScenario(route: PersonaWitnessRoute, mode: string) {
  const joining = mode.startsWith('join'), f = messageDriverFixture(joining)
  if (mode === 'update' || mode === 'lost-deposit' || mode === 'restart-replay' || mode === 'bad-slot') await update()
  if (mode === 'join-expired') f.advance(86401)
  const before = await f.rooms.driverState(f.context, f.roomId)
  if (before.state !== 'active') return { result: before }
  const outgoing = before.value.outbox, slots = new Map<string, any>(), mail = new Map<string, any>()
  if (f.incoming) mail.set(bytesToHex(f.incoming.mailbox), f.incoming)
  const calls: { path: string; body: string; event: string }[] = []
  const eventIds = new Set<string>()
  let lost = false, acked = 0, closed = 0, stale = false, lostWitness = false
  const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
  const response = (status: number, body: any) => ({ status, body: encode(body), witnessRefused: false, path: { status: 'up', relay: null, direct: null, cause: '' } })
  const reply = (code: string, extra = {}) => ({ v: 1, code, server_time: f.now(), ...extra })
  const transport = { request: async (req: LinkRequest) => {
    const event = JSON.parse(atob(req.authorization.slice(6)))
    if (!verifyEvent(event) || event.kind !== 27235 || JSON.stringify(event.tags) !== JSON.stringify([
      ['u', `http://${base32.encode(hexToBytes(f.boxId)).replace(/=+$/, '').toLowerCase()}${req.path}`],
      ['method', req.method], ['payload', bytesToHex(sha256(req.body))],
    ])) throw new Error('Invalid authenticated fixture request')
    const identity = await f.vault.credential(f.context.vault)
    if (!identity.ok || event.pubkey !== identity.value.device.device) throw new Error('Wrong fixture MLS signing device')
    calls.push({ path: req.path, body: bytesToHex(req.body), event: event.id })
    if (req.path.endsWith('/capabilities')) {
      if (mode === 'wait' && !entered) { entered = true; await new Promise<void>(resolve => { release = resolve }) }
      if (mode === 'offline') throw new Error('fixture offline')
      return response(200, { v: 1, security_contract: 1, slot_receipts: 1, fork_evidence: 1, restore_fence: 1, installation: mode === 'replacement' ? '88'.repeat(32) : f.installation })
    }
    if (req.method === 'PUT') {
      if (eventIds.has(event.id)) return response(401, reply('replay'))
      eventIds.add(event.id)
      const out = outgoing.find((o: any) => bytesToHex(o.mailbox) === req.path.split('/')[4])
      if (!out || bytesToHex(out.envelope) !== bytesToHex(req.body)) throw new Error('Outbox bytes changed')
      if (out.destination.type === 'CommitSlot') slots.set(bytesToHex(out.mailbox), out)
      if ((mode === 'lost-deposit' || mode === 'restart-replay') && !lost) { lost = true; throw new Error('Stored but reply lost') }
      if (out.destination.type === 'CommitSlot') {
        const signed = f.receipt(out); if (mode === 'bad-slot') signed[196] ^= 1
        return response(201, reply('won', { receipt: bytesToHex(sha256(out.envelope)), attempt: out.destination.attempt, signed_receipt: base64Encode(signed) }))
      }
      return response(201, reply('stored', { receipt: bytesToHex(sha256(out.envelope)) }))
    }
    if (req.path.endsWith('/fetch')) {
      const wanted: string[] = JSON.parse(new TextDecoder().decode(req.body)).mailboxes
      const records = wanted.map(id => mail.get(id)).filter(Boolean).map(out => ({ mailbox: bytesToHex(out.mailbox), receipt: bytesToHex(sha256(out.envelope)), envelope: base64Encode(out.envelope) }))
      if (records.length && mode === 'stale-fetch' && !stale) { stale = true; await send('33'.repeat(32), 'competing edit') }
      if (records.length && mode === 'account-fetch') f.stale()
      if (records.length && mode === 'lost-witness' && !lostWitness) { lostWitness = true; await (window as any).loseNextWitnessAdvance() }
      return response(200, reply('ok', { records, next: null }))
    }
    if (req.path.endsWith('/ack')) {
      for (const r of JSON.parse(new TextDecoder().decode(req.body)).records) { mail.delete(r.mailbox); acked++ }
      return response(200, reply('marked', { acked: 1 }))
    }
    if (req.path.endsWith('/status')) {
      const out = slots.get(req.path.split('/')[4])
      if (!out) return response(200, reply('empty'))
      const signed = f.receipt(out); if (mode === 'bad-slot') signed[196] ^= 1
      return response(200, reply('filled', { attempt: out.destination.attempt, receipt: bytesToHex(sha256(out.envelope)), signed_receipt: base64Encode(signed), envelope: base64Encode(out.envelope) }))
    }
    throw new Error('Unexpected driver route')
  } }
  const make = () => {
    const actual = messageDriverFixture(joining)
    const client = new BrowserMlsBoxClient(transport, { routeId: route.routeId, card: hexToBytes(route.card), pairedRouteSecret: hexToBytes(route.pairedRouteSecret), cardSerial: BigInt(route.cardSerial), cardVerifiedAt: BigInt(route.cardVerifiedAt) }, f.boxId,
      actual.vault, actual.context.vault, async () => 'approve', () => true)
    return new BrowserMlsMessageDriver(actual.rooms, client, actual.context, f.roomId, async () => { closed++ }, navigator.locks, f.now)
  }
  driver = make()
  const result = await driver.round(), firstAcked = acked
  let recovered: any
  if (mode === 'lost-deposit' || mode === 'restart-replay' || mode === 'lost-witness') {
    await driver.close(); if (mode === 'lost-deposit') f.advance(1); if (joining) restartJoin(); else restart()
    driver = make(); recovered = await driver.round()
  }
  const after = mode === 'account-fetch' ? undefined : joining ? await readJoin() : await read()
  await driver.close()
  return { result, recovered, firstAcked, acked, after, calls, closed, distinctEvents: new Set(calls.map(c => c.event)).size }
}

/** Guard and encrypted metadata tests use a real engine and coordinator. */
export async function driverGuardScenario(mode: string) {
  const f = messageDriverFixture(), old = await f.rooms.driverState(f.context, f.roomId)
  if (old.state !== 'active') throw new Error('No fixture room')
  const guard = { generation: old.value.generation, homeBox: f.boxId, installation: f.installation }
  if (mode === 'stale') { await send(); return f.rooms.drive(f.context, f.roomId, guard, { type: 'drained', mailbox: new Uint8Array(32) }) }
  if (mode === 'bad-installation') return f.rooms.drive(f.context, f.roomId, { ...guard, installation: '11'.repeat(32) }, { type: 'tick' })
  // Seed a valid outstanding query with a real commit's signed receipt to
  // exercise encrypted persistence and atomic clearing, independent of the
  // engine's separate evidence-generation tests.
  const updated = await update()
  if (updated.state !== 'active') throw new Error('No fixture update')
  const slot = updated.value.outbound.find((o: any) => o.destination.type === 'CommitSlot')
  const query = { slot: bytesToHex(slot.mailbox), attempt: slot.destination.attempt }
  await f.host.transact(f.persona, async tx => { const r = await readMlsRoom(tx, f.roomId); r.ordering = [query]; await saveMlsRoom(tx, r) }, () => true)
  restart()
  const g = messageDriverFixture(), state = await g.rooms.driverState(g.context, g.roomId)
  if (state.state !== 'active') throw new Error('No restored fixture room')
  const receipt = f.receipt(slot); if (mode === 'bad-receipt') receipt[196] ^= 1
  if (mode === 'lost-query-witness') await (window as any).loseNextWitnessAdvance()
  const result = await g.rooms.drive(g.context, g.roomId, { ...guard, generation: state.value.generation }, { type: 'receipt', ...query, receipt })
  restart()
  const h = messageDriverFixture(), after = await h.rooms.driverState(h.context, h.roomId)
  return { result, before: state.value.ordering, after }
}

export async function orderingCapacityScenario() {
  const f = messageDriverFixture(), wasm = await import('../app/src/mls-engine.js').then(m => m.loadMlsEngine())
  const before = await read(), original = wasm.Session.prototype.send
  const query = { type: 'OrderingUnconfirmed', slot: new Uint8Array(32).fill(99), attempt: 1 }
  // Instrument only the effect stream. The real send/snapshot, encrypted
  // transaction and witness exercise atomic overflow rollback.
  wasm.Session.prototype.send = function (body: any) { const step = original.call(this, body); step.events.push(structuredClone(query)); return step }
  try {
    await f.host.transact(f.persona, async tx => { const r = await readMlsRoom(tx, f.roomId); r.ordering = Array.from({ length: 1024 }, (_, i) => ({ slot: i.toString(16).padStart(64, '0'), attempt: 0 })); await saveMlsRoom(tx, r) }, () => true)
    const refused = await send(), unchanged = await read()
    await f.host.transact(f.persona, async tx => { const r = await readMlsRoom(tx, f.roomId); r.ordering!.pop(); await saveMlsRoom(tx, r) }, () => true)
    const retried = await send(), after = await f.rooms.driverState(f.context, f.roomId)
    return { before, refused, unchanged, retried, after }
  } finally { wasm.Session.prototype.send = original }
}
