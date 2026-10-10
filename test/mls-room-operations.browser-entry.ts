import { BrowserMlsRoomOperations } from '../app/src/mls-room-operations.js'
import { readMlsRoom, saveMlsRoom, MAX_ROOM_MESSAGES } from '../app/src/mls-room-store.js'
import { readMlsMembership, saveMlsMembership } from '../app/src/mls-membership-store.js'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, randomBytes, concatBytes } from '@noble/hashes/utils.js'
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { base32 } from '@scure/base'
import { BrowserMlsBoxClient } from '../app/src/mls-box-client.js'
import { BrowserMlsKeeperBoxClock } from '../app/src/mls-keeper-box-clock.js'
import type { LinkRequest } from '../app/src/browser-link-types.js'
import { BrowserMlsPersonaStore, LockedPersonaStore, type PersonaWitnessRoute } from '../app/src/mls-persona-store.js'
import { BrowserPersonaCoordinator } from '../app/src/mls-persona-coordinator.js'
import { personaWriter, pairedWitnessIdentity } from '../app/src/mls-writer-identity.js'
import { CoordinatedMlsVault, BOX_METHOD, type BoxRequest } from '../app/src/mls-coordinated-vault.js'
import { MlsVault, BrowserMlsVaultStorage, SIGN_METHOD, base64Encode, type ConsentScope, type SignLeafBindingRequest } from '../app/src/mls-vault.js'
import { loadMlsEngine } from '../app/src/mls-engine.js'
import type { WitnessAnswer } from '../app/src/mls-witness-link.js'
import { pairingFixture } from './mls-pairing-fixture.js'
import { encodeUnsignedBinding } from './vmls-encode.js'
import { bindingDigest } from '../src/vmls/binding.js'
import { createDeviceCredential } from '../src/credential.js'
import { vmlsMemberGrantReference } from '../src/vmls-revocation-request.js'
import { wrapVmlsRevocationRequest } from '../src/vmls-revocation-request.js'
import { localIdentity } from '../src/identity.js'
import { localPeerCrypt } from '../src/dm.js'
import { BrowserMlsRevocationInbox } from '../app/src/mls-revocation-inbox.js'
import { BrowserMlsGrantStore, BrowserMlsGrantLedger, planMlsGrant } from '../app/src/mls-grant-ledger.js'
import { BrowserMlsKeeperDecisions, type MlsKeeperDecisionPlan } from '../app/src/mls-keeper-decisions.js'
import { BrowserMlsKeeperRequestController, type MlsKeeperRequestProgress } from '../app/src/mls-keeper-request-controller.js'
import { BrowserMlsRevocationOutbox } from '../app/src/mls-revocation-outbox.js'
export { saveProfile, restoreProfile, damage } from './mls-persona-coordinator.browser-entry.js'
export { boxRequest } from '../app/src/mls-coordinated-vault.js'

const nodeKey = new Uint8Array(32).fill(76)
const secret = new Uint8Array(32).fill(42), persona = getPublicKey(secret), principal = 'https://kithmoot.test', boxId = bytesToHex(ed25519.getPublicKey(nodeKey))
const subject = '45'.repeat(32), dbName = 'mls-coordination-test'
let clock = Math.floor(Date.now() / 1000), generation = 0, credential: any, deviceId = '', lastReply: any, lastRequest: SignLeafBindingRequest
const identity = { pubkey: persona, async signEvent(e: any) { credential = finalizeEvent(e, secret); return credential } }
const store = new BrowserMlsPersonaStore(dbName)
let host: BrowserPersonaCoordinator, vault: CoordinatedMlsVault, rooms: BrowserMlsRoomOperations
let roomId = '', mode = '', closeAction: (() => void) | undefined
const installation = '79'.repeat(32), operation = '01'.repeat(32)
export function restart() {
  host = new BrowserPersonaCoordinator(store, async () => ({ read: r => exchange('read', r), advance: r => exchange('advance', r), close: async () => { closeAction?.() } }))
  vault = new CoordinatedMlsVault(host, { now: () => clock, generation: () => generation })
  rooms?.invalidate()
  rooms = new BrowserMlsRoomOperations(host, vault, () => clock)
}
async function exchange(method: string, r: Uint8Array): Promise<WitnessAnswer> {
  const a = await window.witnessExchange(method, Array.from(r))
  return a.type === 'receipt' ? { type: 'receipt', bytes: new Uint8Array(a.bytes!) } : { type: a.type as 'unavailable' | 'refused' }
}
restart()
const ctx = () => vault.context(principal, persona)
export async function prepare(route: PersonaWitnessRoute) {
  const wasm = await loadMlsEngine()
  return store.withPersona(persona, async s => {
    const initial = await s.create(), witness = pairedWitnessIdentity(route)
    const genesis = wasm.coordinatorGenesis(hexToBytes(subject), hexToBytes(initial.data.installation), hexToBytes(witness), [])
    initial.data.coordinator = bytesToHex(genesis.state); initial.data.witnessRoute = route
    initial.data.enrolment = { subject, writer: personaWriter(initial.data.writerSeed), witness, digest: bytesToHex(genesis.digest) }
    initial.marker = { ...initial.marker, state: 'genesis', subject, writer: initial.data.enrolment.writer, digest: bytesToHex(genesis.digest) }
    await s.write(initial.revision, initial.data, initial.marker)
    return { digest: bytesToHex(genesis.digest), persona }
  })
}
export async function enrol(replace = false, lifetime = 7 * 86400) {
  const answer = await vault.enrol(ctx(), identity, clock + lifetime, { replace })
  if (answer.ok) deviceId = answer.value.device
  return answer
}

const roomContext = () => ({ vault: ctx(), rendezvousKey: persona, current: () => true })
export async function create(decision: 'approve' | 'deny' = 'approve') {
  const result = await rooms.create(roomContext(), { name: 'Witnessed room', homeBox: boxId, installation, expiresAt: clock + 86400 }, async () => decision)
  if (result.state === 'active') roomId = result.value.session
  return result
}
export async function read() { return rooms.read(roomContext(), roomId) }
export async function revocationAuthority() { return rooms.roomRevocationAuthority(roomContext(), roomId) }
export function keeperIdentities() { return { created: persona, joined: joinKeeper } }
export async function send(op = operation, text = 'durable hello') { return rooms.send(roomContext(), roomId, op, new TextEncoder().encode(text)) }
export async function rename(name = 'New name') { return rooms.rename(roomContext(), roomId, name) }
export async function update(lifetime = 86400) { return rooms.update(roomContext(), roomId, clock + lifetime, async () => 'approve') }
export async function withdraw() { return vault.withdraw(ctx(), { principal, persona, device: deviceId, homeBox: boxId, method: SIGN_METHOD }) }
export async function revoke() { return vault.revokeCredential(ctx(), credential.id) }
export function advance(seconds: number) { clock += seconds }
export async function discover() {
  const answer = await host.transact(persona, async tx => {
    const bytes = await tx.readVault(bytesToHex(new TextEncoder().encode('kithmoot.mls-rooms.v1')))
    return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : []
  }, () => true)
  if (answer.state === 'active') roomId = answer.value[0] ?? ''
  return answer.state === 'active' ? { state: 'active', ids: answer.value } : answer
}
export async function local() { return store.withPersona(persona, async s => {
  const f = (await s.read())!
  return { generation: f.data.active.sessions[0]?.generation ?? null, staged: f.data.staged !== null, fence: f.marker.reason, vault: f.data.active.vault.length }
}) }
export async function race(action: 'send' | 'rename' | 'replace' | 'revoke' | 'withdraw' | 'account' | 'expire' | 'invalidate' | 'parallel') {
  await withdraw()
  const before = await read()
  let nested: any
  const result = await rooms.update(roomContext(), roomId, clock + 86400, async () => {
    if (action === 'send') nested = await send('02'.repeat(32), 'concurrent send')
    if (action === 'rename') nested = await rename('Concurrent name')
    if (action === 'replace') nested = await enrol(true)
    if (action === 'revoke') nested = await revoke()
    if (action === 'withdraw') nested = await withdraw()
    if (action === 'account') generation++
    if (action === 'expire') clock += 601
    if (action === 'invalidate') rooms.invalidate()
    if (action === 'parallel') nested = await update()
    return 'approve'
  })
  return { result, nested, before }
}
export async function fault(operation: 'create' | 'send' | 'update' | 'receive', at: 'stage' | 'promotion' | 'stale-close' | 'expiry-close' | 'binding-expiry-close') {
  const write = LockedPersonaStore.prototype.write
  let injected = false
  const trigger = (f: any) => operation === 'create' ? (f.data.staged ?? f.data.active).sessions.length > 0 :
    (f.data.staged ?? f.data.active).sessions.some((s: any) => s.id === roomId && BigInt(s.generation) > before)
  const before = BigInt((await local()).generation ?? 0)
  LockedPersonaStore.prototype.write = async function (...args) {
    const f = await write.apply(this, args)
    if (!injected && trigger(f) && (at === 'stage' ? f.data.staged !== null : f.data.staged === null)) {
      injected = true
      if (at === 'stage' || at === 'promotion') throw new Error('fixture interruption')
      closeAction = () => { closeAction = undefined; if (at === 'stale-close') generation++; else clock += at === 'binding-expiry-close' ? 11 : 601 }
    }
    return f
  }
  try {
    const result = operation === 'create' ? await create() : operation === 'send' ? await send() : operation === 'update' ? await update(at === 'binding-expiry-close' ? 10 : 86400) : await receive()
    return { result, injected }
  } catch (e) { return { error: (e as Error).message, injected } }
  finally { LockedPersonaStore.prototype.write = write; closeAction = undefined }
}
export async function historyFull() {
  return host.transact(persona, async tx => {
    const r = await readMlsRoom(tx, roomId)
    r.history = Array.from({ length: MAX_ROOM_MESSAGES }, (_, i) => ({ id: 'sent:' + i.toString(16).padStart(64, '0'), direction: 'sent' as const, body: '', epoch: '0', leaf: '01'.repeat(32) }))
    await saveMlsRoom(tx, r)
  }, () => true).then(r => r.state)
}
export async function damageRoom() {
  return host.transact(persona, async tx => { await tx.dropVault(bytesToHex(new TextEncoder().encode('kithmoot.mls-room.v1:')) + roomId) }, () => true).then(r => r.state)
}
export async function pendingNever(operation: 'create' | 'update', end: 'invalidate' | 'expiry') {
  await withdraw()
  const timeout = globalThis.setTimeout
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  // Accelerate only the bounded pending-signature timer, advancing the test
  // clock with it. No engine or witness timeout is weakened.
  if (end === 'expiry') globalThis.setTimeout = ((fn: () => void, ms: number, ...args: any[]) => timeout(() => { if (ms >= 1000 && ms <= 601000) clock += 601; fn() }, ms >= 1000 && ms <= 601000 ? 500 : ms, ...args)) as typeof setTimeout
  const consent = async () => { entered(); return new Promise<'approve'>(() => undefined) }
  try {
    const task = operation === 'create' ? rooms.create(roomContext(), { name: 'Pending', homeBox: boxId, installation, expiresAt: clock + 86400 }, consent) : rooms.update(roomContext(), roomId, clock + 86400, consent)
    await waiting
    if (end === 'invalidate') rooms.invalidate()
    return await task
  } finally { globalThis.setTimeout = timeout }
}

let guest: any, guestPlatform: any, incoming: any, guestLeaf = '', guestDevice = ''
function receipt(slot: any) {
  const attempt = new Uint8Array(4); new DataView(attempt.buffer).setUint32(0, slot.destination.attempt)
  const digest = sha256(concatBytes(new TextEncoder().encode('VMLS/1 slot receipt'), hexToBytes(installation), slot.mailbox, attempt, sha256(slot.envelope)))
  return concatBytes(Uint8Array.of(1), hexToBytes(boxId), hexToBytes(installation), slot.mailbox, attempt, sha256(slot.envelope), ed25519.sign(digest, nodeKey))
}
function guestAck(step: any) { if (step.snapshot) { guest.commitAck(step.snapshot.generation, step.snapshot.generation); step.snapshot.plaintext.fill(0) } }
function boxInput(record: any, signed?: Uint8Array) { return { homeBox: boxId, installation, mailbox: record.mailbox, envelope: record.envelope, receipt: signed } }
function fixturePackageClient(): BrowserMlsBoxClient {
  const route = pairingFixture(nodeKey).route, encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
  const transport = { request: async (request: LinkRequest) => {
    const event = JSON.parse(atob(request.authorization.slice(6)))
    if (!verifyEvent(event) || event.pubkey !== deviceId || event.kind !== 27235 || !request.path.startsWith('/vmls/v1/packages/') ||
        JSON.stringify(event.tags) !== JSON.stringify([
          ['u', `http://${base32.encode(hexToBytes(boxId)).replace(/=+$/, '').toLowerCase()}${request.path}`],
          ['method', 'PUT'], ['payload', bytesToHex(sha256(request.body))],
        ])) throw new Error('Invalid fixture package registration')
    return { status: 201, body: encode({ v: 1, code: 'registered', server_time: clock }), witnessRefused: false,
      path: { status: 'up' as const, relay: null, direct: null, cause: '' } }
  } }
  return new BrowserMlsBoxClient(transport, { routeId: route.routeId, card: hexToBytes(route.card), pairedRouteSecret: hexToBytes(route.pairedRouteSecret),
    cardSerial: BigInt(route.cardSerial), cardVerifiedAt: BigInt(route.cardVerifiedAt) }, boxId, vault, ctx(), async () => 'approve', () => true)
}
export async function addGuest(stageWelcome = false, packageClient: BrowserMlsBoxClient = fixturePackageClient(), joined = false, separatePerson = false) {
  const activeContext = joined ? joinContext() : roomContext(), activeRz = joined ? joinRz : persona, activeRzSecret = joined ? joinRzSecret : secret
  const wasm = await loadMlsEngine(), d = checked(await vault.credential(ctx())), guestSecret = new Uint8Array(32).fill(44), rz = hexToBytes(activeRz)
  const keeperPlatform = new wasm.Platform(hexToBytes(d.device.device), rz, { fill: n => crypto.getRandomValues(new Uint8Array(n)) })
  guestDevice = bytesToHex(schnorr.getPublicKey(guestSecret))
  guestPlatform = new wasm.Platform(hexToBytes(guestDevice), rz, { fill: n => crypto.getRandomValues(new Uint8Array(n)) })
  const personSecret = separatePerson ? guestSecret : secret, person = getPublicKey(personSecret)
  const c = finalizeEvent({ kind: 20460, created_at: clock, content: '', tags: [['d', person], ['scope', 'person'], ['device', guestDevice], ['expiration', String(clock + 7 * 86400)]] }, personSecret)
  const binding = { credential: { pubkey: hexToBytes(person), createdAt: BigInt(clock), tags: c.tags, content: '', sig: hexToBytes(c.sig) }, homeBox: hexToBytes(boxId), expiresAt: BigInt(clock + 86400) }
  const joining = wasm.Session.prepareCapability(guestPlatform, BigInt(clock), { binding, expiresAt: BigInt(clock + 86400), adderRz: rz, counter: 0n })
  const ask = joining.signRequest(), dh = joining.ecdhRequest()
  const made = joining.complete(BigInt(clock), ask.operation, schnorr.sign(ask.digest, guestSecret), secp256k1.getSharedSecret(activeRzSecret, concatBytes(Uint8Array.of(2), dh.peerRz)).slice(1))
  guest = made.session; guestAck(made.step)
  guestLeaf = bytesToHex(guest.ownLeafId())
  const introPending = wasm.prepareIntroduction(keeperPlatform, BigInt(clock), rz, 0n), req = introPending.request()
  const intro = introPending.complete(BigInt(clock), req.operation, secp256k1.getSharedSecret(activeRzSecret, concatBytes(Uint8Array.of(2), req.peerRz)).slice(1))
  const capabilityEnvelope = made.step.outbound[0].envelope
  let added = await rooms.addCapabilities(activeContext, roomId, [intro.openCapability(BigInt(clock), capabilityEnvelope)], packageClient, clock)
  if (added.state === 'transport' && (added.answer.state === 'unavailable' || added.answer.state === 'not-signed')) {
    added = await rooms.addCapabilities(activeContext, roomId, [intro.openCapability(BigInt(clock), capabilityEnvelope)], packageClient, clock)
  }
  intro.free(); introPending.free(); joining.free(); keeperPlatform.free()
  if (added.state !== 'active') {
    if (stageWelcome) return added as any
    throw new Error('fixture add held')
  }
  const slot = added.value.outbound.find((o: any) => o.destination.type === 'CommitSlot')
  const applied = await rooms.process(activeContext, roomId, boxInput(slot, receipt(slot)))
  if (applied.state !== 'active') throw new Error('fixture add not applied')
  const welcome = applied.value.outbound.find((o: any) => o.destination.type === 'Welcome')
  if (stageWelcome) return applied.state
  const accepted = guest.process(BigInt(clock), welcome.mailbox, welcome.envelope, undefined, { homeBox: hexToBytes(boxId), installation: hexToBytes(installation) })
  guestAck(accepted.step)
  const routed = await rooms.driverState(activeContext, roomId)
  if (routed.state !== 'active') throw new Error('fixture Welcome route held')
  const welcomeRecords = routed.value.outbox.filter((item: any) => item.destination.type === 'Welcome').map((item: any) => item.recordId)
  if (welcomeRecords.length) {
    const delivered = await rooms.drive(activeContext, roomId, { generation: routed.value.generation, homeBox: boxId, installation }, { type: 'delivered', records: welcomeRecords })
    if (delivered.state !== 'active') throw new Error('fixture Welcome delivery held')
  }
  const updating = guest.prepareUpdate(BigInt(clock), binding)
  const updated = guest.completeUpdate(BigInt(clock), updating.operation, schnorr.sign(updating.digest, guestSecret)); guestAck(updated)
  const updateSlot = updated.outbound.find((o: any) => o.destination.type === 'CommitSlot'), signed = receipt(updateSlot)
  guestAck(guest.process(BigInt(clock), updateSlot.mailbox, updateSlot.envelope, signed, undefined).step)
  const seen = await rooms.process(activeContext, roomId, boxInput(updateSlot, signed))
  if (seen.state !== 'active') throw new Error('fixture guest update held')
  const sent = guest.send(new TextEncoder().encode('received plaintext survives')); guestAck(sent)
  incoming = sent.outbound.find((o: any) => o.destination.type === 'Leaf')
  return seen.state
}
export async function stageGuestWelcome(packageClient?: BrowserMlsBoxClient) { return addGuest(true, packageClient) }
const inboxGrants = new BrowserMlsGrantStore()
const keeperInbox = () => new BrowserMlsRevocationInbox(host, inboxGrants, () => ({ vault: ctx(), current: () => true, foreground: () => true }), () => clock)
export async function receiveKeeperRequest(wrongPerson = false, ledgerOnly = false, lifetime = 7 * 86400) {
  const senderSecret = new Uint8Array(32).fill(wrongPerson ? 45 : 44)
  const sender = { ...localIdentity(senderSecret), ...localPeerCrypt(senderSecret) }
  const keeper = { ...localIdentity(secret), ...localPeerCrypt(secret) }
  const box = { routeId: 'keeper-inbox-fixture', eventUrl: `ws://${base32.encode(hexToBytes(boxId)).replace(/=+$/, '').toLowerCase()}/events` }
  const grant = await planMlsGrant(keeper, box, sender.pubkey, guestDevice, { session: roomId, name: 'Witnessed room', leaf: guestLeaf }, clock)
  grant.state = 'active'
  if (ledgerOnly) { grant.rooms = []; grant.revokeAfter = clock + 86400 }
  await inboxGrants.put(grant)
  const wrapper = await wrapVmlsRevocationRequest(sender, { sender: sender.pubkey, keeper: persona, device: guestDevice,
    sessions: ['ab'.repeat(32)], boxes: ['cd'.repeat(32)], createdAt: clock, expiration: clock + lifetime })
  return keeperInbox().receive([wrapper], keeper)
}
export async function keeperRequests() { return keeperInbox().view() }
const keeperDecisions = () => new BrowserMlsKeeperDecisions(host, inboxGrants, () => ({ vault: ctx(), current: () => true, foreground: () => true }), () => clock)
export async function deferKeeperRequest() {
  const read = await host.transact(persona, async tx => (await readMlsMembership(tx)).inbox!.prompts.find(prompt => ['pending', 'approved'].includes(prompt.state))!.operation, () => true)
  if (read.state !== 'active') return read
  const retained = await keeperDecisions().retained(read.value)
  if (retained.state !== 'active') return retained
  return keeperDecisions().defer({ binding: ctx(), prompt: retained.value })
}
export async function keeperApprovals(includeDeferred = false) { return keeperDecisions().approvals(includeDeferred) }
export async function keeperDecisionPlan() {
  const result = await host.transact(persona, async tx => (await readMlsMembership(tx)).inbox!.prompts.find(prompt => prompt.state === 'pending')!.operation, () => true)
  if (result.state !== 'active') return result
  return keeperDecisions().plan(result.value)
}
export async function decideKeeperRequest(approve = true) {
  const plan = await keeperDecisionPlan()
  if (plan.state !== 'active') return plan
  return keeperDecisions().decide(plan.value, approve)
}
export async function decideReviewedKeeperRequest(plan: MlsKeeperDecisionPlan) { return keeperDecisions().decide(plan, true) }
/** Short signed lifetime keeps the real room live while its grant lapses. */
export async function shortenKeeperGrant(seconds = 60, revoking = false) {
  const grant = (await inboxGrants.all())[0]!, keeper = localIdentity(secret)
  grant.expiration = clock + seconds
  for (const key of ['active', 'revocation'] as const) {
    const event = grant[key]
    grant[key] = await keeper.signEvent({ kind: event.kind, created_at: event.created_at, content: event.content,
      tags: event.tags.map(tag => tag[0] === 'expiration' ? ['expiration', String(grant.expiration)] : tag) })
  }
  if (revoking) grant.state = 'revoking'
  await inboxGrants.put(grant)
}
export async function lapseKeeperRequest(route: PersonaWitnessRoute, mode = 'ok') {
  const grant = (await inboxGrants.all())[0]!, calls: string[] = []
  const retained = await host.transact(persona, async tx => (await readMlsMembership(tx)).inbox!.prompts.find(prompt => !!prompt.approval)!.operation, () => true)
  if (retained.state !== 'active') return { result: retained, calls }
  const context = () => ({ vault: ctx(), current: () => true, foreground: () => true })
  const transport = { request: async (req: LinkRequest) => {
    const event = JSON.parse(atob(req.authorization.slice(6)))
    if (!verifyEvent(event) || event.pubkey !== deviceId || event.kind !== 27235 || JSON.stringify(event.tags) !== JSON.stringify([
      ['u', `http://${base32.encode(hexToBytes(grant.node)).replace(/=+$/, '').toLowerCase()}${req.path}`],
      ['method', req.method], ['payload', bytesToHex(sha256(req.body))],
    ])) throw new Error('Invalid fixture clock authentication')
    calls.push(req.path)
    const refused = mode === 'refused' && req.path.endsWith('/fetch')
    const body = req.path.endsWith('/capabilities') ? { v: 1, security_contract: 1, slot_receipts: 1, fork_evidence: 1, restore_fence: 1, installation } :
      { v: 1, code: refused ? 'clock-unsafe' : 'ok', server_time: clock + (mode === 'behind' ? -1 : 0), ...(refused ? {} : { records: [], next: null }) }
    return { status: refused ? 503 : 200, body: new TextEncoder().encode(JSON.stringify(body)), witnessRefused: false,
      path: { status: 'up' as const, relay: null, direct: null, cause: '' } }
  } }
  const client = new BrowserMlsBoxClient(transport, { routeId: grant.box.routeId, card: hexToBytes(route.card), pairedRouteSecret: hexToBytes(route.pairedRouteSecret),
    cardSerial: BigInt(route.cardSerial), cardVerifiedAt: BigInt(route.cardVerifiedAt) }, grant.node, vault, ctx(), async () => 'approve', () => true)
  const probe = new BrowserMlsKeeperBoxClock(client, context, () => clock)
  const decisions = new BrowserMlsKeeperDecisions(host, inboxGrants, context, () => clock, undefined, node => node === grant.node ? probe : undefined)
  try {
    const evidence = await probe.probe(grant)
    if (!evidence) return { result: { state: 'held' }, calls }
    return { result: await decisions.lapse(retained.value, grant, evidence), calls }
  } catch (error) { return { error: (error as Error).message, calls } }
  finally { probe.invalidate(); client.invalidate() }
}
let keeperWithdrawalFails = false, keeperProgress: MlsKeeperRequestProgress | undefined
let keeperRouteForgotten = false
const secondKeeperBox = { routeId: 'keeper-second-fixture', eventUrl: `ws://${base32.encode(new Uint8Array(32).fill(77)).replace(/=+$/, '').toLowerCase()}/events` }
export function forgetKeeperRoute(value = true) { keeperRouteForgotten = value }
export async function addSecondKeeperGrant() {
  const previous = (await inboxGrants.all())[0]!
  const grant = await planMlsGrant(localIdentity(secret), secondKeeperBox, previous.persona, previous.device, { session: roomId, name: 'Witnessed room', leaf: guestLeaf }, clock)
  grant.state = 'active'; grant.rooms = []; await inboxGrants.put(grant)
}
const keeperWithdrawals: string[] = []
export function failKeeperWithdrawal(value: boolean) { keeperWithdrawalFails = value }
export function keeperWithdrawalAttempts() { return keeperWithdrawals.slice() }
const keeperController = () => {
  const keeper = localIdentity(secret), box = { routeId: 'keeper-inbox-fixture', eventUrl: `ws://${base32.encode(hexToBytes(boxId)).replace(/=+$/, '').toLowerCase()}/events` }
  const routes = () => [...(keeperRouteForgotten ? [] : [box]), secondKeeperBox]
  const ledger = new BrowserMlsGrantLedger(() => keeper, { resume: async () => undefined, boxes: routes, pairedBoxes: async () => routes() } as any, inboxGrants,
    () => ({ publish: async event => { keeperWithdrawals.push(event.id); if (keeperWithdrawalFails) throw new Error('fixture box withdrawal refused') }, close: () => undefined }), () => clock)
  const context = () => ({ vault: ctx(), current: () => true, foreground: () => true })
  return new BrowserMlsKeeperRequestController(new BrowserMlsKeeperDecisions(host, inboxGrants, context, () => clock, ledger), rooms, ledger, context)
}
export async function approveKeeperRequest(failRemove = false) {
  const plan = await keeperDecisionPlan()
  if (plan.state !== 'active') return plan
  const wasm = await loadMlsEngine(), original = wasm.Session.prototype.remove
  if (failRemove) wasm.Session.prototype.remove = function () { throw { kind: 'engine', code: 'RemoveFailed' } }
  try { return keeperProgress = await keeperController().approve(plan.value) } finally { wasm.Session.prototype.remove = original }
}
export async function continueKeeperRequest() {
  const read = await host.transact(persona, async tx => (await readMlsMembership(tx)).inbox!.prompts.find(prompt => !!prompt.approval)!.operation, () => true)
  if (read.state !== 'active') return read
  return keeperProgress = await keeperController().advance(read.value)
}
export async function applyKeeperRemoval() {
  const slot = keeperProgress?.rooms.flatMap(room => room.effect?.outbound ?? []).find((item: any) => item.destination.type === 'CommitSlot')
  if (!slot) throw new Error('fixture keeper Remove has no commit slot')
  return rooms.process(roomContext(), roomId, boxInput(slot, receipt(slot)))
}
export async function unapprovedKeeperRemoval() {
  const plan = await keeperDecisionPlan()
  if (plan.state !== 'active') return plan
  return rooms.removeRequestedDevice(roomContext(), roomId, plan.value.prompt.operation, guestLeaf)
}
export async function receive() { return rooms.process(roomContext(), roomId, boxInput(incoming)) }
const removalOperation = '03'.repeat(32)
const requestRemovalOperation = '07'.repeat(32)
export async function beginGuestRemoval(compromised = true) {
  const roster = await rooms.members(roomContext(), roomId)
  if (roster.state !== 'active') throw new Error('fixture roster held')
  const members = roster.value.filter(member => member.leafId === guestLeaf)
  return rooms.removeDevice(roomContext(), roomId, { operation: removalOperation, leafId: guestLeaf, members, grants: [], compromised })
}
export async function beginGuestRemovalWithStaleRoster() {
  const roster = await rooms.members(roomContext(), roomId)
  if (roster.state !== 'active') throw new Error('fixture roster held')
  const members = roster.value.filter(member => member.leafId === guestLeaf).map(member => ({ ...member, bindingExpiresAt: member.bindingExpiresAt + 1 }))
  return rooms.removeDevice(roomContext(), roomId, { operation: '05'.repeat(32), leafId: guestLeaf, members, grants: [], compromised: false })
}
export async function beginJoinedMemberRequest(mode: 'valid' | 'wrong-device' | 'wrong-keeper' | 'wrong-box' | 'other-person' = 'valid') {
  const roster = await rooms.members(joinContext(), roomId)
  if (roster.state !== 'active') throw new Error('fixture roster held')
  const leaf = mode === 'other-person' ? joinInviterLeaf : guestLeaf
  const members = roster.value.filter(member => member.leafId === leaf)
  if (members.length !== 1) throw new Error('fixture target missing')
  const device = mode === 'wrong-device' ? '99'.repeat(32) : members[0].device
  const keeper = mode === 'wrong-keeper' ? getPublicKey(new Uint8Array(32).fill(47)) : joinKeeper
  const requestBox = mode === 'wrong-box' ? '98'.repeat(32) : boxId
  const operation = ({ valid: '07', 'wrong-device': '08', 'wrong-keeper': '09', 'other-person': '0a', 'wrong-box': '0b' } as const)[mode].repeat(32)
  return rooms.removeDevice(joinContext(), roomId, { operation, leafId: leaf, members,
    grants: [{ node: hexToBytes(requestBox), grant: hexToBytes(vmlsMemberGrantReference(requestBox, device)), keeper: false }], compromised: true,
    request: { keeper, device, sessions: [roomId], boxes: [requestBox] } })
}
export async function markJoinedMemberRequest() {
  return rooms.setRemovalGrants(joinContext(), roomId, requestRemovalOperation,
    [{ grant: vmlsMemberGrantReference(boxId, guestDevice), state: { type: 'NotAuthorised', requested: true } }])
}
export async function damageJoinedMemberRequestKeeper() {
  return host.transact(persona, async tx => {
    const record = await readMlsMembership(tx), request = record.removals.find(item => item.operation === requestRemovalOperation)?.request
    if (!request) throw new Error('missing request')
    request.keeper = getPublicKey(new Uint8Array(32).fill(47))
    await saveMlsMembership(tx, record)
  }, () => true).then(result => result.state)
}
export async function driveGuestRemoval() { return rooms.driveRemoval(roomContext(), roomId, removalOperation) }
export async function driveGuestRemovalFailure(code: string) {
  const wasm = await loadMlsEngine(), original = wasm.Session.prototype.remove
  wasm.Session.prototype.remove = function () { throw { kind: 'engine', code } }
  try { return await driveGuestRemoval() } finally { wasm.Session.prototype.remove = original }
}
export async function applyGuestRemoval() {
  const driven = await driveGuestRemoval()
  if (driven.state !== 'active') return driven
  const slot = driven.value.outbound.find((item: any) => item.destination.type === 'CommitSlot')
  return slot ? rooms.process(roomContext(), roomId, boxInput(slot, receipt(slot))) : driven
}
export async function markGuestRemovalFailed() {
  const wasm = await loadMlsEngine()
  return host.transact(persona, async tx => {
    const journal = await readMlsMembership(tx), record = journal.removals.find(item => item.operation === removalOperation)
    if (!record) throw new Error('fixture removal missing')
    const bytes = hexToBytes(record.journal), removal = wasm.removalDecode(bytes)
    try { removal.setMls('Failed'); record.failure = 'RemoveFailed'; record.journal = bytesToHex(removal.encode()) }
    finally { removal.free(); bytes.fill(0) }
    await saveMlsMembership(tx, journal)
  }, () => true).then(result => result.state)
}
export async function damageGuestRemovalJournal() {
  return host.transact(persona, async tx => {
    const journal = await readMlsMembership(tx), record = journal.removals.find(item => item.operation === removalOperation)
    if (!record) throw new Error('fixture removal missing')
    record.journal = '00'; await saveMlsMembership(tx, journal)
  }, () => true).then(result => result.state)
}
export async function membership() { return rooms.membership(roomContext(), roomId) }
export async function members() { return rooms.members(roomContext(), roomId) }
export function forgetGuest() { guest?.free(); guest = undefined; guestPlatform?.free(); guestPlatform = undefined }
function checked<T>(r: { ok: true; value: T } | { ok: false; refusal: string }): T { if (!r.ok) throw new Error(r.refusal); return r.value }

export async function cancelledCleanup(operation: 'create' | 'update', end: 'invalidate' | 'expiry') {
  await withdraw()
  const wasm = await loadMlsEngine(), proto = operation === 'create' ? wasm.PendingCreate.prototype : wasm.Session.prototype
  const free = proto.free, timeout = globalThis.setTimeout
  let waiting = 0, entered!: () => void, freed = 0
  const ready = new Promise<void>(resolve => { entered = resolve })
  const consent = async () => { if (++waiting === 2) entered(); return new Promise<'approve'>(() => undefined) }
  if (end === 'expiry') globalThis.setTimeout = ((fn: () => void, ms: number, ...args: any[]) => timeout(() => { if (ms >= 1000 && ms <= 601000) clock += 601; fn() }, ms >= 1000 && ms <= 601000 ? 1000 : ms, ...args)) as typeof setTimeout
  const start = () => operation === 'create' ? rooms.create(roomContext(), { name: 'Pending', homeBox: boxId, installation, expiresAt: clock + 86400 }, consent) : rooms.update(roomContext(), roomId, clock + 86400, consent)
  try {
    const finished = Promise.allSettled([start(), start()])
    await ready
    proto.free = function () { free.call(this as any); if (++freed === 1) throw new Error('fixture free failure') }
    if (end === 'invalidate') rooms.invalidate()
    const results = await finished
    return { freed, results: results.map(r => r.status === 'fulfilled' ? r.value : { error: (r.reason as Error).message }) }
  } finally { proto.free = free; globalThis.setTimeout = timeout }
}
export async function completedCleanup() {
  const wasm = await loadMlsEngine(), free = wasm.PendingCreate.prototype.free
  wasm.PendingCreate.prototype.free = function () { free.call(this); throw new Error('fixture completed free failure') }
  try { return await create() } catch (error) { return { error: (error as Error).message } }
  finally { wasm.PendingCreate.prototype.free = free }
}

/** Wire/signing integration with the real typed vault and WASM parser. The
 * transport is an in-process fixture, not a live Bothy acceptance claim. */
export async function boxClientScenario(route: PersonaWitnessRoute, mode: string) {
  const calls: { path: string; event: string; body: string }[] = [], encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
  const mailbox = new Uint8Array(32).fill(11), envelope = Uint8Array.of(1, 2, 3), hash = bytesToHex(sha256(envelope))
  const box = bytesToHex(hexToBytes(route.card).subarray(5, 37))
  const caps = { v: 1, security_contract: 1, slot_receipts: 1, fork_evidence: 1, restore_fence: 1, installation }
  const response = (status: number, body: Uint8Array) => ({ status, body, witnessRefused: false, path: { status: 'up', relay: null, direct: null, cause: '' } })
  const transport = { request: async (req: LinkRequest) => {
    const event = JSON.parse(atob(req.authorization.slice(6)))
    if (!verifyEvent(event) || event.pubkey !== deviceId || event.kind !== 27235 ||
      JSON.stringify(event.tags) !== JSON.stringify([
        ['u', `http://${base32.encode(hexToBytes(box)).replace(/=+$/, '').toLowerCase()}${req.path}`],
        ['method', req.method], ['payload', bytesToHex(sha256(req.body))],
      ])) throw new Error('Invalid fixture authentication')
    calls.push({ path: req.path, event: event.id, body: bytesToHex(req.body) })
    if (mode === 'clock-account' && req.path.endsWith('/fetch')) generation++
    if (mode === 'late-reply') generation++
    if (mode === 'lost-reply' && calls.length === 1) throw new Error('reply lost')
    if (req.path.endsWith('/capabilities')) return response(200, mode === 'caps-invalid' ? encode({ ...caps, extra: 1 }) : encode({ ...caps, ...(mode === 'clock-installation' && calls.length === 3 ? { installation: '88'.repeat(32) } : {}) }))
    if (req.path.endsWith('/fetch')) {
      if (mode === 'clock-refused') return response(503, encode({ v: 1, code: 'clock-unsafe', server_time: clock + 30 * 86400 }))
      if (mode === 'clock-rewind') clock--
      return response(200, encode({ v: 1, code: 'ok', server_time: clock + (mode === 'clock-server-ahead' ? 30 * 86400 : 0),
        records: mode.startsWith('clock-') ? [] : [{ mailbox: bytesToHex(mailbox), receipt: mode === 'bad-receipt' ? '00'.repeat(32) : hash, envelope: base64Encode(envelope) }], next: null }))
    }
    if (req.path.endsWith('/ack')) return response(200, encode({ v: 1, code: 'marked', server_time: clock, acked: 1 }))
    if (req.path.includes('/packages/')) return response(req.method === 'DELETE' ? 200 : 201, encode({ v: 1, code: req.method === 'DELETE' ? 'withdrawn' : 'registered', server_time: clock }))
    return response(201, encode({ v: 1, code: 'stored', server_time: clock, receipt: hash }))
  } }
  let enter!: () => void, approve!: (answer: 'approve') => void, finished!: () => void
  const entering = new Promise<void>(resolve => { enter = resolve }), consentAnswer = new Promise<'approve'>(resolve => { approve = resolve }), signingFinished = new Promise<void>(resolve => { finished = resolve })
  const signingVault = { current: vault.current.bind(vault), acceptBoxReply: vault.acceptBoxReply.bind(vault), signBoxRequestV1: async (...args: Parameters<typeof vault.signBoxRequestV1>) => {
    try { return await vault.signBoxRequestV1(...args) } finally { finished() }
  } }
  const client = new BrowserMlsBoxClient(transport, { routeId: route.routeId, card: hexToBytes(route.card), pairedRouteSecret: hexToBytes(route.pairedRouteSecret), cardSerial: BigInt(route.cardSerial), cardVerifiedAt: BigInt(route.cardVerifiedAt) }, box, signingVault, ctx(), async () => {
    if (mode === 'cancel-consent' || mode === 'timeout-consent') { enter(); return consentAnswer }
    if (mode === 'stale-consent') generation++
    return mode === 'denied' ? 'deny' : 'approve'
  }, () => true, mode === 'timeout-consent' ? 1000 : 20_000)
  if (mode.startsWith('clock-')) {
    const grant = await planMlsGrant(localIdentity(secret), { routeId: route.routeId, eventUrl: `ws://${base32.encode(hexToBytes(box)).replace(/=+$/, '').toLowerCase()}/events` },
      getPublicKey(new Uint8Array(32).fill(43)), '33'.repeat(32), { session: '44'.repeat(32), name: 'Clock fixture', leaf: '55'.repeat(32) }, clock)
    const probe = new BrowserMlsKeeperBoxClock(client, () => ({ vault: ctx(), current: () => true, foreground: () => true }), () => clock)
    try {
      const evidence = await probe.probe(grant)
      if (evidence) {
        if (mode === 'clock-admission-account') generation++
        if (mode === 'clock-admission-grant') grant.state = 'revoking'
        probe.acceptEvidence(grant, mode === 'clock-admission-clone' ? structuredClone(evidence) : evidence)
      }
      return { evidence, calls, distinctEvents: new Set(calls.map(c => c.event)).size,
        lapsed: evidence !== null && grant.expiration <= Math.min(evidence.phoneTime, evidence.boxTime) }
    } catch (error) { return { error: (error as Error).message, calls } }
    finally { probe.invalidate(); client.invalidate() }
  }
  const first = client.capabilities()
  if (mode === 'cancel-consent' || mode === 'timeout-consent') {
    await entering
    if (mode === 'cancel-consent') client.invalidate()
    const result = await first
    approve('approve'); await signingFinished
    const overview = checked(await vault.overview(ctx()))
    return { results: [result], calls, approved: overview?.approved ?? [] }
  }
  const results: any[] = [await first]
  if (mode === 'routes') {
    results.push(await client.deposit(mailbox, envelope), await client.fetch([mailbox]), await client.ack([{ mailbox, receipt: sha256(envelope) }]),
      await client.registerPackage(mailbox, mailbox, clock + 3600, clock), await client.withdrawPackage(mailbox))
  } else if (mode === 'bad-receipt') results.push(await client.fetch([mailbox]))
  else if (mode === 'lost-reply') results.push(await client.capabilities())
  client.invalidate()
  return { results, calls, distinctEvents: new Set(calls.map(c => c.event)).size }
}

// Join fixture uses the real encrypted provision ceremony and a separate
// inviter. Only the inviter and box/witness transports are simulated.
import { RendezvousVault, BrowserRendezvousVaultStorage, type RendezvousReceipt } from '../app/src/rendezvous-vault.js'
import { base64urlnopad } from '@scure/base'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
const joinRzSecret = new Uint8Array(32).fill(43), provisionDevice = new Uint8Array(32).fill(44), inviterRzSecret = new Uint8Array(32).fill(45)
const joinRz = getPublicKey(joinRzSecret), inviterRz = getPublicKey(inviterRzSecret), rzDatabase = 'mls-join-rendezvous-test'
const joinKeeper = getPublicKey(new Uint8Array(32).fill(48))
let rzVault = new RendezvousVault(new BrowserRendezvousVaultStorage(rzDatabase)), rzReceipt: RendezvousReceipt
let joinOutbound: any, joinWelcome: any, inviter: any, inviterPlatform: any, joinInviterLeaf = ''
const joinRemovalOperation = '06'.repeat(32)
const joinContext = () => ({ vault: ctx(), rendezvousKey: joinRz, current: () => true })
export async function joinRevocationAuthority() { return rooms.roomRevocationAuthority(joinContext(), roomId) }
export async function addJoinedMemberDevice() { return addGuest(false, fixturePackageClient(), true) }
export async function joinMembership() { return rooms.membership(joinContext(), roomId) }
export async function standaloneRequests() {
  const outbox = new BrowserMlsRevocationOutbox(host, () => ({ vault: ctx(), current: () => true }), () => clock)
  return outbox.records()
}
export async function provisionJoin(index = 1, lifetime = 600) {
  const nonce = new Uint8Array(16).fill(9), device = getPublicKey(provisionDevice)
  const plain = JSON.stringify({ v: 1, p: persona, d: device, rz: joinRz, u: 'rendezvous', i: index, n: base64urlnopad.encode(nonce), e: clock + lifetime, k: base64urlnopad.encode(joinRzSecret) })
  const response = JSON.stringify({ v: 1, p: persona, d: device, rz: joinRz, u: 'rendezvous', i: index, n: base64urlnopad.encode(nonce), e: clock + lifetime, c: encrypt(plain, getConversationKey(joinRzSecret, device)) })
  const result = await rzVault.accept(response, { identity: persona, device, nonce, now: clock }, { decrypt: async (peer, value) => decrypt(value, getConversationKey(provisionDevice, peer)) })
  if (!result.ok) throw new Error(result.reason)
  rzReceipt = result.receipt
  return result
}
export async function clearJoinChild() { await new RendezvousVault(new BrowserRendezvousVaultStorage(rzDatabase)).clear(persona) }
export async function typedJoin(mode = 'approve') {
  const result = await rooms.join(joinContext(), { operation, name: 'Joined room', homeBox: boxId, introductionBox: boxId, adderRz: inviterRz, keeper: joinKeeper, counter: 0n, expiresAt: clock + 86400, rendezvous: rzReceipt }, rzVault, async () => {
    if (mode === 'clear') await clearJoinChild()
    if (mode === 'replace') await provisionJoin(2)
    if (mode === 'account') generation++
    if (mode === 'invalidate') rooms.invalidate()
    if (mode === 'expiry') clock += 601
    if (mode === 'revoke') await revoke()
    if (mode === 'device') await enrol(true)
    return mode === 'deny' ? 'deny' : 'approve'
  })
  if (result.state === 'active') { roomId = result.value.session; joinOutbound = result.value.outbound[0] }
  return result
}
export async function readJoin() { return rooms.read(joinContext(), roomId) }
export async function sendJoin() { return rooms.send(joinContext(), roomId, operation, new TextEncoder().encode('joined hello')) }
export function restartJoin() { restart(); rzVault = new RendezvousVault(new BrowserRendezvousVaultStorage(rzDatabase)) }
export async function joinPermissions() { await new Promise(resolve => setTimeout(resolve, 100)); return vault.overview(ctx()) }
export async function makeJoinWelcome() {
  const wasm = await loadMlsEngine(), deviceSecret = new Uint8Array(32).fill(49), root = new Uint8Array(32).fill(48), p = getPublicKey(root)
  const c = finalizeEvent({ kind: 20460, created_at: clock, content: '', tags: [['d', p], ['scope', 'person'], ['device', getPublicKey(deviceSecret)], ['expiration', String(clock + 7 * 86400)]] }, root)
  const binding = { credential: { pubkey: hexToBytes(p), createdAt: BigInt(clock), tags: c.tags, content: '', sig: hexToBytes(c.sig) }, homeBox: hexToBytes(boxId), expiresAt: BigInt(clock + 86400) }
  inviterPlatform = new wasm.Platform(schnorr.getPublicKey(deviceSecret), hexToBytes(inviterRz), { fill: n => crypto.getRandomValues(new Uint8Array(n)) })
  const creating = wasm.Session.prepareCreate(inviterPlatform, BigInt(clock), binding, hexToBytes(installation)), ask = creating.request()
  const made = creating.complete(BigInt(clock), ask.operation, schnorr.sign(ask.digest, deviceSecret)); inviter = made.session
  joinInviterLeaf = bytesToHex(inviter.ownLeafId())
  const ack = (step: any) => { if (step.snapshot) { inviter.commitAck(step.snapshot.generation, step.snapshot.generation); step.snapshot.plaintext.fill(0) } }
  ack(made.step); creating.free()
  const pending = wasm.prepareIntroduction(inviterPlatform, BigInt(clock), hexToBytes(joinRz), 0n), req = pending.request()
  const shared = secp256k1.getSharedSecret(inviterRzSecret, concatBytes(Uint8Array.of(2), req.peerRz))
  const intro = pending.complete(BigInt(clock), req.operation, shared.slice(1)); shared.fill(0)
  const added = inviter.add(BigInt(clock), [intro.openCapability(BigInt(clock), joinOutbound.envelope)]); ack(added)
  const slot = added.outbound.find((o: any) => o.destination.type === 'CommitSlot')
  const applied = inviter.process(BigInt(clock), slot.mailbox, slot.envelope, receipt(slot), undefined); ack(applied.step)
  joinWelcome = applied.step.outbound.find((o: any) => o.destination.type === 'Welcome')
  intro.free(); pending.free(); inviter.free(); inviterPlatform.free()
  return !!joinWelcome
}
export async function acceptJoinWelcome(install = installation, homeBox = boxId) { return rooms.process(joinContext(), roomId, { ...boxInput(joinWelcome), installation: install, homeBox }) }
export async function firstJoinUpdate() {
  const updated = await rooms.update(joinContext(), roomId, clock + 86400, async () => 'approve')
  if (updated.state !== 'active') return updated
  const slot = updated.value.outbound.find((o: any) => o.destination.type === 'CommitSlot')
  return rooms.process(joinContext(), roomId, boxInput(slot, receipt(slot)))
}
export async function beginJoinInviterRemoval() {
  const roster = await rooms.members(joinContext(), roomId)
  if (roster.state !== 'active') throw new Error('fixture joined roster held')
  const members = roster.value.filter(member => member.leafId === joinInviterLeaf)
  return rooms.removeDevice(joinContext(), roomId, { operation: joinRemovalOperation, leafId: joinInviterLeaf, members, grants: [], compromised: true })
}
export async function driveJoinInviterRemoval() { return rooms.driveRemoval(joinContext(), roomId, joinRemovalOperation) }
export async function joinMembers() { return rooms.members(joinContext(), roomId) }
export async function applyJoinInviterRemoval() {
  const driven = await driveJoinInviterRemoval()
  if (driven.state !== 'active') return { driven }
  const slot = driven.value.outbound.find((item: any) => item.destination.type === 'CommitSlot')
  return { driven, applied: slot ? await rooms.process(joinContext(), roomId, boxInput(slot, receipt(slot))) : undefined }
}
export async function joinFault(at: 'stage' | 'promotion' | 'stale-close' | 'lost-advance', welcome = false) {
  const write = LockedPersonaStore.prototype.write
  let injected = false
  const before = BigInt((await local()).generation ?? 0)
  LockedPersonaStore.prototype.write = async function (...args) {
    const f = await write.apply(this, args)
    const candidate = f.data.staged ?? f.data.active
    if (!injected && candidate.sessions.some((s: any) => BigInt(s.generation) > before) && (['stage', 'lost-advance'].includes(at) ? f.data.staged !== null : f.data.staged === null)) {
      injected = true
      if (at === 'lost-advance') await (window as any).loseNextWitnessAdvance()
      else if (at === 'stale-close') closeAction = () => { closeAction = undefined; generation++ }
      else throw new Error('fixture join interruption')
    }
    return f
  }
  try { return { result: welcome ? await acceptJoinWelcome() : await typedJoin(), injected } }
  catch (error) { return { error: (error as Error).message, injected } }
  finally { LockedPersonaStore.prototype.write = write; closeAction = undefined }
}
export async function recoverJoin() {
  restartJoin(); const found = await rooms.findJoin(joinContext(), operation); if (found.state === 'active') roomId = found.value ?? ''
  const result = await readJoin()
  if (result.state === 'active') joinOutbound = (result.value as any).outbox.find((o: any) => o.destination.type === 'Introduction')
  return result
}
export async function joinQueuedClear() {
  const joining = typedJoin(), clearing = clearJoinChild()
  const result = await joining; await clearing
  return result
}
export async function joinReleaseFault(mode: 'child' | 'account' | 'expiry' | 'deadline' | 'cleanup' | 'revision') {
  const storage = new BrowserRendezvousVaultStorage(rzDatabase), lock = storage.withLock.bind(storage)
  let captured: any
  const wasm = await loadMlsEngine(), sign = wasm.PendingCapability.prototype.signRequest, dh = wasm.PendingCapability.prototype.ecdhRequest
  if (mode === 'deadline') {
    wasm.PendingCapability.prototype.signRequest = function () { return { ...sign.call(this), expiresAt: BigInt(clock + 1) } }
    wasm.PendingCapability.prototype.ecdhRequest = function () { return { ...dh.call(this), expiresAt: BigInt(clock + 1) } }
  }
  storage.withLock = async work => {
    const result = await lock(work)
    if (mode === 'child') storage.invalidate()
    if (mode === 'account') generation++
    if (mode === 'expiry') clock += 601
    if (mode === 'deadline') clock += 2
    if (mode === 'cleanup' || mode === 'revision') {
      captured = result
      if (mode === 'cleanup') throw new Error('fixture source cleanup')
      storage.revision = () => { throw new Error('fixture source revision') }
    }
    return result
  }
  rzVault = new RendezvousVault(storage)
  try { return await typedJoin() }
  catch (error) { return { error: (error as Error).message, wiped: captured?.value?.outbound.every((o: any) => o.envelope.every((b: number) => b === 0) && o.mailbox.every((b: number) => b === 0)) } }
  finally { wasm.PendingCapability.prototype.signRequest = sign; wasm.PendingCapability.prototype.ecdhRequest = dh }
}
let joinPrompt: (() => void) | undefined, pendingJoin: Promise<any> | undefined
export async function startWaitingJoin() {
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  pendingJoin = rooms.join(joinContext(), { operation, name: 'Pending', homeBox: boxId, introductionBox: boxId, adderRz: inviterRz, keeper: joinKeeper, counter: 0n, expiresAt: clock + 86400, rendezvous: rzReceipt }, rzVault,
    () => new Promise<'approve'>(resolve => { joinPrompt = () => resolve('approve'); entered() }))
  await waiting
}
export async function finishWaitingJoin() { const result = await pendingJoin; joinPrompt?.(); await new Promise(resolve => setTimeout(resolve, 100)); return result }
export async function neverJoinConsent() {
  const timeout = globalThis.setTimeout
  globalThis.setTimeout = ((fn: () => void, ms: number, ...args: any[]) => timeout(() => { if (ms > 1000 && ms <= 601000) clock += 601; fn() }, ms > 1000 && ms <= 601000 ? 200 : ms, ...args)) as typeof setTimeout
  try { await startWaitingJoin(); return await finishWaitingJoin() }
  finally { globalThis.setTimeout = timeout }
}
export async function forgedJoinSignature() {
  const sign = vault.signLeafBindingV1.bind(vault)
  vault.signLeafBindingV1 = async (...args) => { const answer = await sign(...args); return answer.ok ? { ok: true, value: { ...answer.value } } : answer }
  try { return await typedJoin() } finally { vault.signLeafBindingV1 = sign }
}

/** Test-only handles for the driver integration harness, never app exports. */
export function messageDriverFixture(join = false) {
  return { rooms, vault, host, context: join ? joinContext() : roomContext(), roomId, boxId, installation, nodeKey,
    now: () => clock, advance: (seconds: number) => { clock += seconds }, stale: () => { generation++ },
    incoming: join ? joinWelcome : incoming, receipt, persona }
}
