// Integration fixture: actual private application owner, browser custody and
// pinned MLS WASM. Only Link's transport engine and remote peers are fixtures.
import { BrowserMlsRoomDevelopmentOwner, type MlsRoomDevelopmentContext } from '../app/src/mls-room-development-owner.js'
import { BrowserMlsPersonaStore } from '../app/src/mls-persona-store.js'
import { BrowserPersonaCoordinator } from '../app/src/mls-persona-coordinator.js'
import { BrowserPersonaLinks } from '../app/src/mls-persona-link.js'
import { CoordinatedMlsVault } from '../app/src/mls-coordinated-vault.js'
import { personaWriter, pairedWitnessIdentity } from '../app/src/mls-writer-identity.js'
import { loadMlsEngine } from '../app/src/mls-engine.js'
import { RendezvousVault, BrowserRendezvousVaultStorage } from '../app/src/rendezvous-vault.js'
import { mlsRoomIds, readMlsRoom, saveMlsRoom } from '../app/src/mls-room-store.js'
import { BrowserMlsRoomOperations } from '../app/src/mls-room-operations.js'
import { base64Encode } from '../app/src/mls-vault.js'
import { MLS_ROOM_LINK_OWNER } from '../app/src/mls-room-link-vault.js'
import type { PersonaWitnessRoute } from '../app/src/mls-persona-store.js'
import type { LinkConfig, LinkEngine, LinkRequest } from '../app/src/browser-link-types.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { base32, base64urlnopad } from '@scure/base'
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'

const master = new Uint8Array(32).fill(42), persona = getPublicKey(master)
const deviceKey = new Uint8Array(32).fill(44), childKey = new Uint8Array(32).fill(43), rz = getPublicKey(childKey)
const identity = { pubkey: persona, signEvent: async (event: any) => finalizeEvent(event, master) }
let context: MlsRoomDevelopmentContext = { persona, identity, mode: 'normal', generation: '0',
  authority: { owner: identity, signEvent: identity.signEvent, rendezvous: { owner: identity, deviceKey, provisionOwner: identity, provision: async () => '' } } }
const owner = new BrowserMlsRoomDevelopmentOwner(() => context)
const links = new BrowserPersonaLinks(() => true)
const store = new BrowserMlsPersonaStore()
const host = new BrowserPersonaCoordinator(store, links.channels)
const vault = new CoordinatedMlsVault(host)
let roomRoute = '', box = '', device = '', installation = '79'.repeat(32), mode = '', phase = '', calls = 0, confirmations = 0, starts = 0, stops = 0
let released: (() => void) | undefined, task: Promise<unknown> | undefined, result: unknown
let lastRequest = '', transportError = '', deposits = 0
let ceremonyStartedAt: number | undefined
const heldPhases = new Set<string>(), slotRecords = new Map<string, { envelope: Uint8Array; attempt: number; receipt: Uint8Array }>()
const path = { status: 'up', relay: null, direct: null, cause: '' }
async function hold(at: string) { phase = at; if (!heldPhases.has(at) && (mode === 'hold-' + at || mode === 'manual-hold-' + at)) { heldPhases.add(at); await new Promise<void>(resolve => { released = resolve }) } }
export function configure(next = '') { mode = next; calls = 0; confirmations = 0; phase = ''; result = undefined; transportError = ''; lastRequest = ''; deposits = 0; heldPhases.clear(); slotRecords.clear() }
export function release() { released?.(); released = undefined }
export function status() { return { mode, phase, calls, starts, stops, settled: result !== undefined, lastRequest, transportError, deposits } }
export function advanceClock(seconds: number) { const before = Date.now(); Date.now = () => before + seconds * 1000 }

// Installed by an esbuild test-only module seam; never supplied to the owner.
export async function startFixtureLink(config: LinkConfig): Promise<LinkEngine> {
  starts++
  const witness = config.routes.some(route => route.routeId === 'witness')
  return {
    pairRoute: async bundle => ({ routeId: bundle.routeId, card: bundle.serverCard.slice(), pairedRouteSecret: new Uint8Array(32).fill(3), cardSerial: 1n, cardVerifiedAt: BigInt(Math.floor(Date.now() / 1000)) }),
    request: async (request: LinkRequest) => {
      try {
      if (witness) {
        if (request.routeId !== 'witness' || request.authorization !== '' || request.method !== 'POST') throw new Error('Invalid witness transport')
        const answer = await (window as any).witnessExchange(request.path.endsWith('/read') ? 'read' : 'advance', Array.from(request.body))
        return { status: answer.status, body: new Uint8Array(answer.bytes), witnessRefused: false, path }
      }
      const event = JSON.parse(atob(request.authorization.slice(6)))
      lastRequest = request.method + ' ' + request.path
      if (request.routeId !== roomRoute || !request.path.startsWith('/vmls/v1/') ||
          !verifyEvent(event) || event.pubkey !== device || event.kind !== 27235 || JSON.stringify(event.tags) !== JSON.stringify([
            ['u', `http://${base32.encode(hexToBytes(box)).replace(/=+$/, '').toLowerCase()}${request.path}`],
            ['method', request.method], ['payload', bytesToHex(sha256(request.body))],
          ])) throw new Error('Invalid actual device authentication')
      if (mode.startsWith('manual')) {
        calls++
        const reply = (code: string, extra = {}) => ({ v: 1, code, server_time: Math.floor(Date.now() / 1000), ...extra })
        let body: unknown
        if (request.path === '/vmls/v1/capabilities' && request.method === 'GET') {
          await hold('pre')
          body = { v: 1, security_contract: 1, slot_receipts: 1, fork_evidence: 1, restore_fence: 1,
            installation: mode === 'manual-changed' ? '88'.repeat(32) : installation }
        } else if (request.path.endsWith('/fetch') && request.method === 'POST') {
          await hold('fetch'); body = reply('ok', { records: [], next: null })
        } else if (request.path.endsWith('/status') && request.method === 'POST') {
          await hold('status')
          const record = slotRecords.get(request.path.split('/')[4])
          body = record ? reply('filled', { attempt: record.attempt, receipt: bytesToHex(sha256(record.envelope)), signed_receipt: base64Encode(record.receipt), envelope: base64Encode(record.envelope) }) : reply('empty')
        } else if (request.path.startsWith('/vmls/v1/slots/') && request.method === 'PUT') {
          deposits++
          await hold('deposit')
          const slot = hexToBytes(request.path.split('/')[4]), n = Number(request.path.split('/')[5]), attempt = new Uint8Array(4)
          new DataView(attempt.buffer).setUint32(0, n)
          const hash = sha256(request.body), signed = ed25519.sign(sha256(concatBytes(new TextEncoder().encode('VMLS/1 slot receipt'), hexToBytes(installation), slot, attempt, hash)), new Uint8Array(32).fill(76))
          const receipt = concatBytes(Uint8Array.of(1), hexToBytes(box), hexToBytes(installation), slot, attempt, hash, signed)
          slotRecords.set(bytesToHex(slot), { envelope: request.body.slice(), attempt: n, receipt })
          if (mode === 'manual-unavailable') throw new Error('Lost actual deposit answer')
          body = reply('won', { receipt: bytesToHex(hash), attempt: n, signed_receipt: base64Encode(receipt) })
        } else if (request.path.endsWith('/records') && request.method === 'PUT') {
          deposits++
          await hold('deposit')
          if (mode === 'manual-unavailable') throw new Error('Lost actual deposit answer')
          body = reply('stored', { receipt: bytesToHex(sha256(request.body)) })
        } else throw new Error('Unexpected manual fixture request')
        return { status: request.method === 'PUT' ? 201 : 200, body: new TextEncoder().encode(JSON.stringify(body)), witnessRefused: false, path }
      }
      if (request.path !== '/vmls/v1/capabilities' || request.method !== 'GET') throw new Error('Creation must only read capabilities')
      calls++; await hold(calls === 1 ? 'pre' : 'post')
      if (calls > 1 && mode === 'unavailable') throw new Error('Fixture lost post reply')
      const body = { v: 1, security_contract: 1, slot_receipts: 1, fork_evidence: 1, restore_fence: 1,
        installation: calls > 1 && mode === 'changed' ? '88'.repeat(32) : installation,
        ...(calls > 1 && mode === 'malformed' ? { unexpected: true } : {}) }
      return { status: 200, body: new TextEncoder().encode(JSON.stringify(body)), witnessRefused: false, path }
      } catch (error) { transportError = error instanceof Error ? error.message : 'Fixture transport error'; throw error }
    },
    stop: async () => { stops++; if (!witness) { await hold('stop'); if (mode === 'stop-failure' || mode === 'manual-stop-failure') throw new Error('Fixture shutdown failed') } },
    openSocket: async () => { throw new Error('Creation must not open a socket') },
    removeRoute: async () => { throw new Error('Creation must not remove a route') },
    retireRoute: async () => { throw new Error('Creation must not retire a route') },
    finalizeRoute: async () => { throw new Error('Creation must not finalise a route') },
  }
}
;(globalThis as any).__startRoomCreateLink = startFixtureLink

// Fixture-only concurrent writer at the exact fresh confirmation boundary.
// The actual owner's implementation is not rewritten by the bundle.
const confirmTransport = BrowserMlsRoomOperations.prototype.confirmTransport
BrowserMlsRoomOperations.prototype.confirmTransport = async function (context, id, expected) {
  confirmations++
  if (mode === 'manual-confirm-device' && expected.device !== undefined) await replaceRoomDevice(id)
  const mutate = confirmations === (mode.startsWith('post-') ? 2 : 1)
  if (mutate && mode.endsWith('confirm-generation')) {
    const sent = await new BrowserMlsRoomOperations(host, vault).send({ vault: vault.context(location.origin, persona), rendezvousKey: rz, current: () => true }, id, 'ab'.repeat(32), new TextEncoder().encode('Concurrent durable outbox'))
    if (sent.state !== 'active') throw new Error('Concurrent fixture writer did not commit')
  }
  if (mutate && mode.endsWith('confirm-installation')) await host.transact(persona, async tx => { const room = await readMlsRoom(tx, id); room.binding.installation = '88'.repeat(32); await saveMlsRoom(tx, room) }, () => true)
  return confirmTransport.call(this, context, id, expected)
}

export async function prepare(route: PersonaWitnessRoute) {
  const wasm = await loadMlsEngine()
  return store.withPersona(persona, async locked => {
    const initial = await locked.create(), subject = '45'.repeat(32), witness = pairedWitnessIdentity(route)
    const genesis = wasm.coordinatorGenesis(hexToBytes(subject), hexToBytes(initial.data.installation), hexToBytes(witness), [])
    initial.data.coordinator = bytesToHex(genesis.state); initial.data.witnessRoute = route
    initial.data.enrolment = { subject, writer: personaWriter(initial.data.writerSeed), witness, digest: bytesToHex(genesis.digest) }
    initial.marker = { ...initial.marker, state: 'genesis', subject, writer: initial.data.enrolment.writer, digest: bytesToHex(genesis.digest) }
    await locked.write(initial.revision, initial.data, initial.marker)
    return { digest: bytesToHex(genesis.digest), persona }
  })
}
export async function enrol(lifetime = 7 * 86400) {
  const answer = await vault.enrol(vault.context(location.origin, persona), identity, Math.floor(Date.now() / 1000) + lifetime)
  if (answer.ok) device = answer.value.device
  return answer.ok
}
export async function provision(lifetime = 600) {
  const nonce = new Uint8Array(16).fill(9), now = Math.floor(Date.now() / 1000)
  const fields = { v: 1, p: persona, d: getPublicKey(deviceKey), rz, u: 'rendezvous', i: 1, n: base64urlnopad.encode(nonce), e: now + lifetime }
  const plain = JSON.stringify({ ...fields, k: base64urlnopad.encode(childKey) })
  const accepted = await new RendezvousVault(new BrowserRendezvousVaultStorage()).accept(JSON.stringify({ ...fields,
    c: encrypt(plain, getConversationKey(childKey, fields.d)) }), { identity: persona, device: fields.d, nonce, now },
    { decrypt: async (peer, value) => decrypt(value, getConversationKey(deviceKey, peer)) })
  if (!accepted.ok) throw new Error(accepted.reason)
  return accepted.receipt
}
export async function pair(uri: string, expectedBox: string) {
  box = expectedBox
  const answer = await owner.pair(uri, ['wss://witness.example/link'])
  if (answer.state === 'done') roomRoute = answer.value.routeId
  return answer
}
export function start(lifetime = 86400, route = roomRoute) {
  ceremonyStartedAt = Date.now()
  task = owner.create(route, 'Actual owner room', lifetime).then(value => { result = value; return value }, error => { result = { error: error.message }; return result })
}
export function finish() { return task }
export function manual(session: string, route = roomRoute) {
  ceremonyStartedAt = Date.now()
  task = owner.manualRound(route, session).then(value => { result = value; return value }, error => { result = { error: error.message }; return result })
}
export async function queue(session: string) {
  const result = await new BrowserMlsRoomOperations(host, vault).update({ vault: vault.context(location.origin, persona), rendezvousKey: rz, current: () => true }, session, Math.floor(Date.now() / 1000) + 86400, async () => 'approve')
  if (result.state !== 'active') throw new Error('Fixture update did not commit')
  return { generation: result.value.generation, outbox: result.value.outbound.length }
}
export function roomState(session: string) { return new BrowserMlsRoomOperations(host, vault).read({ vault: vault.context(location.origin, persona), rendezvousKey: rz, current: () => true }, session) }
// An authenticated node-signed slot receipt over the genuine engine Commit can
// be observed before its old outgoing record is cleared. Resolve it without PUT.
export async function observeQueuedCommit(session: string) {
  const rooms = new BrowserMlsRoomOperations(host, vault)
  const context = { vault: vault.context(location.origin, persona), rendezvousKey: rz, current: () => true }
  const before = await rooms.driverState(context, session)
  if (before.state !== 'active') throw new Error('Fixture room unavailable')
  const out = before.value.outbox.find(record => record.destination.type === 'CommitSlot')
  if (!out || out.destination.type !== 'CommitSlot') throw new Error('Fixture commit missing')
  const attempt = new Uint8Array(4); new DataView(attempt.buffer).setUint32(0, out.destination.attempt)
  const hash = sha256(out.envelope)
  const signature = ed25519.sign(sha256(concatBytes(new TextEncoder().encode('VMLS/1 slot receipt'), hexToBytes(installation), out.mailbox, attempt, hash)), new Uint8Array(32).fill(76))
  const receipt = concatBytes(Uint8Array.of(1), hexToBytes(box), hexToBytes(installation), out.mailbox, attempt, hash, signature)
  const processed = await rooms.process(context, session, { mailbox: out.mailbox, envelope: out.envelope, receipt, homeBox: box, installation, generation: before.value.generation })
  if (processed.state !== 'active') throw new Error('Fixture commit observation refused')
  const after = await rooms.driverState(context, session)
  if (after.state !== 'active') throw new Error('Fixture committed room unavailable')
  return { outbox: after.value.outbox.length, obsolete: after.value.epoch !== null && out.destination.epoch < after.value.epoch }
}
export async function replaceRoomDevice(session: string) {
  const replaced = await vault.enrol(vault.context(location.origin, persona), identity, Math.floor(Date.now() / 1000) + 7 * 86400, { replace: true, expectedDevice: device })
  if (!replaced.ok) throw new Error('Fixture device replacement refused')
  device = replaced.value.device
  const saved = await host.transact(persona, async tx => { const room = await readMlsRoom(tx, session); room.binding.device = device; room.binding.credentialId = replaced.value.credentialId; await saveMlsRoom(tx, room) }, () => true)
  if (saved.state !== 'active') throw new Error('Fixture binding replacement did not commit')
}
export function members(session: string) { return new BrowserMlsRoomOperations(host, vault).members({ vault: vault.context(location.origin, persona), rendezvousKey: rz, current: () => true }, session) }
export function interrupt(kind: string) {
  if (kind === 'pause') { void owner.pause().catch(() => {}); return }
  if (kind === 'owner') context = { ...context, authority: { ...context.authority, owner: {} } }
  if (kind === 'generation') context = { ...context, generation: context.generation + '1' }
  if (kind === 'mode') context = { ...context, mode: 'quiet' }
  if (kind === 'key') deviceKey[0] ^= 1
  if (kind === 'rollback') {
    // Roll back before this ceremony's first observation, even if time passed
    // while its cleanup was held without another clock read.
    const before = ceremonyStartedAt
    if (before === undefined) throw new Error('Start a ceremony before rolling its clock back')
    Date.now = () => before - 1
  }
  if (kind === 'deadline') { const now = Date.now(); Date.now = () => now + 600_000 }
  if (kind === 'hidden') Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
}
export async function local() {
  return host.transact(persona, async tx => {
    const rooms = []
    for (const id of await mlsRoomIds(tx)) {
      const room = await readMlsRoom(tx, id)
      rooms.push({ id, name: room.name, box: room.binding.homeBox, installation: room.binding.installation,
        rz: room.binding.rendezvousKey })
    }
    return rooms
  }, () => true)
}
export function lockAvailable() { return navigator.locks.request(MLS_ROOM_LINK_OWNER, { ifAvailable: true }, lock => !!lock) }
export function driverLockAvailable(session: string) { return navigator.locks.request(`kithmoot:mls-driver:${persona}:${session}`, { ifAvailable: true }, lock => !!lock) }
export function clearChild() { return new RendezvousVault(new BrowserRendezvousVaultStorage()).clear(persona) }
