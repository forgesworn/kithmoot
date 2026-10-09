import { BrowserMlsRoomOperations } from '../app/src/mls-room-operations.js'
import { BrowserMlsSessionHost } from '../app/src/mls-session-host.js'
import { readMlsRoom, saveMlsRoom, MAX_ROOM_MESSAGES } from '../app/src/mls-room-store.js'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, randomBytes, concatBytes } from '@noble/hashes/utils.js'
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { base32 } from '@scure/base'
import { BrowserMlsBoxClient } from '../app/src/mls-box-client.js'
import type { LinkRequest } from '../app/src/browser-link-types.js'
import { BrowserMlsPersonaStore, LockedPersonaStore, type PersonaWitnessRoute } from '../app/src/mls-persona-store.js'
import { BrowserPersonaCoordinator } from '../app/src/mls-persona-coordinator.js'
import { personaWriter, pairedWitnessIdentity } from '../app/src/mls-writer-identity.js'
import { CoordinatedMlsVault, BOX_METHOD, type BoxRequest } from '../app/src/mls-coordinated-vault.js'
import { MlsVault, BrowserMlsVaultStorage, SIGN_METHOD, base64Encode, type ConsentScope, type SignLeafBindingRequest } from '../app/src/mls-vault.js'
import { loadMlsEngine } from '../app/src/mls-engine.js'
import type { WitnessAnswer } from '../app/src/mls-witness-link.js'
import { encodeUnsignedBinding } from './vmls-encode.js'
import { bindingDigest } from '../src/vmls/binding.js'
import { createDeviceCredential } from '../src/credential.js'
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

let guest: any, guestPlatform: any, incoming: any
function receipt(slot: any) {
  const attempt = new Uint8Array(4); new DataView(attempt.buffer).setUint32(0, slot.destination.attempt)
  const digest = sha256(concatBytes(new TextEncoder().encode('VMLS/1 slot receipt'), hexToBytes(installation), slot.mailbox, attempt, sha256(slot.envelope)))
  return concatBytes(Uint8Array.of(1), hexToBytes(boxId), hexToBytes(installation), slot.mailbox, attempt, sha256(slot.envelope), ed25519.sign(digest, nodeKey))
}
function guestAck(step: any) { if (step.snapshot) { guest.commitAck(step.snapshot.generation, step.snapshot.generation); step.snapshot.plaintext.fill(0) } }
function boxInput(record: any, signed?: Uint8Array) { return { homeBox: boxId, installation, mailbox: record.mailbox, envelope: record.envelope, receipt: signed } }
export async function addGuest() {
  const wasm = await loadMlsEngine(), d = checked(await vault.credential(ctx())), guestSecret = new Uint8Array(32).fill(44), rz = hexToBytes(persona)
  const keeperPlatform = new wasm.Platform(hexToBytes(d.device.device), rz, { fill: n => crypto.getRandomValues(new Uint8Array(n)) })
  guestPlatform = new wasm.Platform(schnorr.getPublicKey(guestSecret), rz, { fill: n => crypto.getRandomValues(new Uint8Array(n)) })
  const c = finalizeEvent({ kind: 20460, created_at: clock, content: '', tags: [['d', persona], ['scope', 'person'], ['device', bytesToHex(schnorr.getPublicKey(guestSecret))], ['expiration', String(clock + 7 * 86400)]] }, secret)
  const binding = { credential: { pubkey: rz, createdAt: BigInt(clock), tags: c.tags, content: '', sig: hexToBytes(c.sig) }, homeBox: hexToBytes(boxId), expiresAt: BigInt(clock + 86400) }
  const joining = wasm.Session.prepareCapability(guestPlatform, BigInt(clock), { binding, expiresAt: BigInt(clock + 86400), adderRz: rz, counter: 0n })
  const ask = joining.signRequest(), dh = joining.ecdhRequest()
  const made = joining.complete(BigInt(clock), ask.operation, schnorr.sign(ask.digest, guestSecret), secp256k1.getSharedSecret(secret, concatBytes(Uint8Array.of(2), dh.peerRz)).slice(1))
  guest = made.session; guestAck(made.step)
  const introPending = wasm.prepareIntroduction(keeperPlatform, BigInt(clock), rz, 0n), req = introPending.request()
  const intro = introPending.complete(BigInt(clock), req.operation, secp256k1.getSharedSecret(secret, concatBytes(Uint8Array.of(2), req.peerRz)).slice(1))
  const sessionHost = new BrowserMlsSessionHost(host, (id, plain, mark) => wasm.Session.open(keeperPlatform, id, plain, mark))
  const added = await sessionHost.step({ persona, current: () => true }, roomId, s => {
    const st = s.add(BigInt(clock), [intro.openCapability(BigInt(clock), made.step.outbound[0].envelope)])
    return { snapshot: st.snapshot, value: { outbound: st.outbound } }
  }, { persist: async (tx, s) => { const r = await readMlsRoom(tx, roomId); r.generation = String(s.generation()); await saveMlsRoom(tx, r) } })
  intro.free(); introPending.free(); joining.free(); keeperPlatform.free()
  if (added.state !== 'active') throw new Error('fixture add held')
  const slot = added.value.outbound.find((o: any) => o.destination.type === 'CommitSlot')
  const applied = await rooms.process(roomContext(), roomId, boxInput(slot, receipt(slot)))
  if (applied.state !== 'active') throw new Error('fixture add not applied')
  const welcome = applied.value.outbound.find((o: any) => o.destination.type === 'Welcome')
  const accepted = guest.process(BigInt(clock), welcome.mailbox, welcome.envelope, undefined, { homeBox: hexToBytes(boxId), installation: hexToBytes(installation) })
  guestAck(accepted.step)
  const updating = guest.prepareUpdate(BigInt(clock), binding)
  const updated = guest.completeUpdate(BigInt(clock), updating.operation, schnorr.sign(updating.digest, guestSecret)); guestAck(updated)
  const updateSlot = updated.outbound.find((o: any) => o.destination.type === 'CommitSlot'), signed = receipt(updateSlot)
  guestAck(guest.process(BigInt(clock), updateSlot.mailbox, updateSlot.envelope, signed, undefined).step)
  const seen = await rooms.process(roomContext(), roomId, boxInput(updateSlot, signed))
  if (seen.state !== 'active') throw new Error('fixture guest update held')
  const sent = guest.send(new TextEncoder().encode('received plaintext survives')); guestAck(sent)
  incoming = sent.outbound.find((o: any) => o.destination.type === 'Leaf')
  return seen.state
}
export async function receive() { return rooms.process(roomContext(), roomId, boxInput(incoming)) }
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
  const calls: { path: string; event: string }[] = [], encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
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
    calls.push({ path: req.path, event: event.id })
    if (mode === 'late-reply') generation++
    if (mode === 'lost-reply' && calls.length === 1) throw new Error('reply lost')
    if (req.path.endsWith('/capabilities')) return response(200, mode === 'caps-invalid' ? encode({ ...caps, extra: 1 }) : encode(caps))
    if (req.path.endsWith('/fetch')) return response(200, encode({ v: 1, code: 'ok', server_time: clock, records: [{ mailbox: bytesToHex(mailbox), receipt: mode === 'bad-receipt' ? '00'.repeat(32) : hash, envelope: base64Encode(envelope) }], next: null }))
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
