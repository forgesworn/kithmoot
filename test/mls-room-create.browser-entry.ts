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
import { MLS_ROOM_LINK_OWNER } from '../app/src/mls-room-link-vault.js'
import type { PersonaWitnessRoute } from '../app/src/mls-persona-store.js'
import type { LinkConfig, LinkEngine, LinkRequest } from '../app/src/browser-link-types.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
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
const path = { status: 'up', relay: null, direct: null, cause: '' }
async function hold(at: string) { phase = at; if (mode === 'hold-' + at) await new Promise<void>(resolve => { released = resolve }) }
export function configure(next = '') { mode = next; calls = 0; confirmations = 0; phase = ''; result = undefined }
export function release() { released?.(); released = undefined }
export function status() { return { mode, phase, calls, starts, stops, settled: result !== undefined } }
export function advanceClock(seconds: number) { const before = Date.now(); Date.now = () => before + seconds * 1000 }

// Installed by an esbuild test-only module seam; never supplied to the owner.
export async function startFixtureLink(config: LinkConfig): Promise<LinkEngine> {
  starts++
  const witness = config.routes.some(route => route.routeId === 'witness')
  return {
    pairRoute: async bundle => ({ routeId: bundle.routeId, card: bundle.serverCard.slice(), pairedRouteSecret: new Uint8Array(32).fill(3), cardSerial: 1n, cardVerifiedAt: BigInt(Math.floor(Date.now() / 1000)) }),
    request: async (request: LinkRequest) => {
      if (witness) {
        if (request.routeId !== 'witness' || request.authorization !== '' || request.method !== 'POST') throw new Error('Invalid witness transport')
        const answer = await (window as any).witnessExchange(request.path.endsWith('/read') ? 'read' : 'advance', Array.from(request.body))
        return { status: answer.status, body: new Uint8Array(answer.bytes), witnessRefused: false, path }
      }
      const event = JSON.parse(atob(request.authorization.slice(6)))
      if (request.routeId !== roomRoute || request.path !== '/vmls/v1/capabilities' || request.method !== 'GET' ||
          !verifyEvent(event) || event.pubkey !== device || event.kind !== 27235 || JSON.stringify(event.tags) !== JSON.stringify([
            ['u', `http://${base32.encode(hexToBytes(box)).replace(/=+$/, '').toLowerCase()}${request.path}`],
            ['method', 'GET'], ['payload', bytesToHex(sha256(request.body))],
          ])) throw new Error('Invalid actual device authentication')
      calls++; await hold(calls === 1 ? 'pre' : 'post')
      if (calls > 1 && mode === 'unavailable') throw new Error('Fixture lost post reply')
      const body = { v: 1, security_contract: 1, slot_receipts: 1, fork_evidence: 1, restore_fence: 1,
        installation: calls > 1 && mode === 'changed' ? '88'.repeat(32) : installation,
        ...(calls > 1 && mode === 'malformed' ? { unexpected: true } : {}) }
      return { status: 200, body: new TextEncoder().encode(JSON.stringify(body)), witnessRefused: false, path }
    },
    stop: async () => { stops++; if (!witness) { await hold('stop'); if (mode === 'stop-failure') throw new Error('Fixture shutdown failed') } },
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
  task = owner.create(route, 'Actual owner room', lifetime).then(value => { result = value; return value }, error => { result = { error: error.message }; return result })
}
export function finish() { return task }
export function members(session: string) { return new BrowserMlsRoomOperations(host, vault).members({ vault: vault.context(location.origin, persona), rendezvousKey: rz, current: () => true }, session) }
export function interrupt(kind: string) {
  if (kind === 'pause') { void owner.pause().catch(() => {}); return }
  if (kind === 'owner') context = { ...context, authority: { ...context.authority, owner: {} } }
  if (kind === 'generation') context = { ...context, generation: context.generation + '1' }
  if (kind === 'mode') context = { ...context, mode: 'quiet' }
  if (kind === 'key') deviceKey[0] ^= 1
  if (kind === 'rollback') { const now = Date.now(); Date.now = () => now - 1000 }
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
export function clearChild() { return new RendezvousVault(new BrowserRendezvousVaultStorage()).clear(persona) }
