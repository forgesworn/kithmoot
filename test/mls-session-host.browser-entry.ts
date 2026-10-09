import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { BrowserMlsPersonaStore, LockedPersonaStore, type PersonaWitnessRoute } from '../app/src/mls-persona-store.js'
import { BrowserPersonaCoordinator } from '../app/src/mls-persona-coordinator.js'
import { BrowserMlsSessionHost } from '../app/src/mls-session-host.js'
import { pairedWitnessIdentity, personaWriter } from '../app/src/mls-writer-identity.js'
import { loadMlsEngine } from '../app/src/mls-engine.js'
import type { Session } from '../app/public/vmls-wasm/vmls_wasm.js'
import type { WitnessAnswer } from '../app/src/mls-witness-link.js'
export { saveProfile, restoreProfile } from './mls-persona-coordinator.browser-entry.js'

const secret = new Uint8Array(32).fill(42), device = new Uint8Array(32).fill(43), persona = getPublicKey(secret)
const store = new BrowserMlsPersonaStore('mls-coordination-test'), subject = '45'.repeat(32)
const now = BigInt(Math.floor(Date.now() / 1000)), homeBox = new Uint8Array(32).fill(78), installation = new Uint8Array(32).fill(79)
let epoch = 0, currentEpoch = 0, host: BrowserMlsSessionHost<Session>, coord: BrowserPersonaCoordinator
let platform: InstanceType<Awaited<ReturnType<typeof loadMlsEngine>>['Platform']>
let opened = 0, freed = 0, acks = 0, ackBeforePromotion = false, atPromotion = false, mode = ''
let snapshots: Uint8Array[] = [], values: Uint8Array[] = [], originals: any[] = [], ids: string[] = []
let savedCreation: any
const context = () => ({ persona, current: () => currentEpoch === epoch })
function track(session: Session): Session {
  opened++
  const ack = session.commitAck.bind(session), free = session.free.bind(session)
  session.commitAck = (g: bigint, h: bigint) => {
    acks++; if (mode && !atPromotion) ackBeforePromotion = true
    if (mode === 'ack-throw') throw new Error('fixture activation failure')
    ack(g, h)
  }
  session.free = () => { freed++; free(); if (mode === 'free-throw') throw new Error('fixture free failure') }
  return session
}
export async function restart() {
  platform?.free()
  const wasm = await loadMlsEngine()
  platform = new wasm.Platform(schnorr.getPublicKey(device), schnorr.getPublicKey(secret), { fill: n => crypto.getRandomValues(new Uint8Array(n)) })
  coord = new BrowserPersonaCoordinator(store, async () => {
    const exchange = async (method: string, request: Uint8Array): Promise<WitnessAnswer> => {
      const a = await window.witnessExchange(method, Array.from(request))
      return a.type === 'receipt' ? { type: 'receipt', bytes: new Uint8Array(a.bytes!) } : { type: a.type as 'unavailable' | 'refused' }
    }
    return { read: r => exchange('read', r), advance: r => exchange('advance', r), close: async () => {
      if (mode === 'close-throw') throw new Error('fixture close failure')
      if (mode === 'stale-close') epoch++
      if (mode === 'invalidated-close') host.invalidate()
    } }
  })
  host = new BrowserMlsSessionHost(coord, (id, plain, mark) => track(wasm.Session.open(platform, id, plain, mark)))
  currentEpoch = epoch
}
export async function prepare(route: PersonaWitnessRoute) {
  await restart()
  const wasm = await loadMlsEngine()
  return store.withPersona(persona, async s => {
    const initial = await s.create(), witness = pairedWitnessIdentity(route)
    const genesis = wasm.coordinatorGenesis(hexToBytes(subject), hexToBytes(initial.data.installation), hexToBytes(witness), [])
    initial.data.coordinator = bytesToHex(genesis.state); initial.data.witnessRoute = route
    initial.data.enrolment = { subject, writer: personaWriter(initial.data.writerSeed), witness, digest: bytesToHex(genesis.digest) }
    initial.marker = { ...initial.marker, state: 'genesis', subject, writer: initial.data.enrolment.writer, digest: bytesToHex(genesis.digest) }
    await s.write(initial.revision, initial.data, initial.marker)
    return { digest: bytesToHex(genesis.digest), subject }
  })
}
function step(raw: any) {
  if (raw.snapshot) snapshots.push(raw.snapshot.plaintext)
  const value = { events: raw.events, outbound: raw.outbound }
  originals.push(value)
  for (const event of value.events) if (event.body) values.push(event.body)
  for (const o of value.outbound) values.push(o.envelope)
  return { snapshot: raw.snapshot, value }
}
export async function create() {
  const wasm = await loadMlsEngine()
  const credential = finalizeEvent({ kind: 20460, created_at: Number(now), content: '', tags: [['d', persona], ['scope', 'person'], ['device', bytesToHex(schnorr.getPublicKey(device))], ['expiration', String(now + 20n * 86400n)]] }, secret)
  const pending = wasm.Session.prepareCreate(platform, now, { credential: { pubkey: hexToBytes(credential.pubkey), createdAt: BigInt(credential.created_at), tags: credential.tags, content: '', sig: hexToBytes(credential.sig) }, homeBox, expiresAt: now + 10n * 86400n }, installation)
  try {
    const req = pending.request(), signature = schnorr.sign(req.digest, device)
    return await host.create(context(), () => {
      const made = pending.complete(now, req.operation, signature)
      ids.push(bytesToHex(made.session.id()))
      savedCreation = structuredClone(made.step)
      return { session: track(made.session), step: step(made.step) }
    })
  } finally { pending.free() }
}
export async function send(index = 0) { return host.step(context(), ids[index], s => step(s.send(new TextEncoder().encode('held plaintext')))) }
export async function read(index = 0) {
  return host.step(context(), ids[index], s => ({ snapshot: null, value: { id: bytesToHex(s.id()), generation: String(s.generation()), outbox: s.outbox().map((o: any) => ({ id: bytesToHex(o.recordId), envelope: bytesToHex(o.envelope) })), phase: s.phase() } }))
}
export async function delivered(index = 0) { return host.step(context(), ids[index], s => step(s.outboundDelivered(s.outbox().map((o: any) => o.recordId)))) }
export async function tick(index = 0) { return host.step(context(), ids[index], s => step(s.tick(now))) }
export async function installationChanged(index = 0) { return host.step(context(), ids[index], s => step(s.observeInstallation(now, new Uint8Array(32).fill(80)))) }
export async function drop(index = 0) { return host.drop(context(), ids[index]) }
export async function unknown() { return host.step(context(), 'ab'.repeat(32), () => { throw new Error('unknown callback must not run') }) }
export async function sessions() { const r = await host.sessions(context()); return r.state === 'active' ? { state: r.state, value: [...r.value].map(([k,v]) => [k,String(v)]) } : r }
export async function local() { return store.withPersona(persona, async s => {
  const f = (await s.read())!
  return { sessions: f.data.active.sessions, staged: f.data.staged?.sessions ?? null, vault: f.data.active.vault, fence: f.marker.reason }
}) }
export function counters() { return { opened, freed, acks, ackBeforePromotion, snapshotsWiped: snapshots.every(p => p.every(b => b === 0)), valuesWiped: values.every(p => p.every(b => b === 0)) } }
export async function malformed(kind: 'id' | 'generation' | 'missing' | 'throw') {
  return host.step(context(), ids[0], s => {
    const made = step(s.send(new Uint8Array([9])))
    if (kind === 'id') made.snapshot.session = new Uint8Array(32)
    if (kind === 'generation') made.snapshot.generation++
    if (kind === 'missing') { made.snapshot.plaintext.fill(0); made.snapshot = null }
    if (kind === 'throw') { made.snapshot.plaintext.fill(0); throw new Error('fixture engine error') }
    return made
  }).catch(e => ({ error: e.message }))
}
export async function readopt() {
  const wasm = await loadMlsEngine(), raw = structuredClone(savedCreation)
  const reopened = wasm.Session.open(platform, raw.snapshot.session, raw.snapshot.plaintext.slice(), 0n)
  return host.create(context(), () => ({ session: track(reopened), step: step(raw) })).catch(e => ({ error: e.message }))
}
export async function fault(kind: string) {
  mode = kind; atPromotion = false
  const write = LockedPersonaStore.prototype.write
  LockedPersonaStore.prototype.write = async function (...args) {
    const f = await write.apply(this, args)
    if (f.data.staged) {
      if (mode === 'stage') throw new Error('fixture stage interruption')
      if (mode === 'stale-stage') epoch++
    } else {
      atPromotion = true
      if (mode === 'promotion') throw new Error('fixture promotion interruption')
    }
    return f
  }
  try { return await proposeAdd() } catch (e) { return { error: (e as Error).message } }
  finally { mode = ''; LockedPersonaStore.prototype.write = write }
}
export async function concurrent() { return Promise.all([send(), send()]) }
export async function bumpVault() { return coord.transact(persona, async tx => { await tx.putVault('00', new Uint8Array([7])) }, () => true) }

async function proposeAdd() {
  const wasm = await loadMlsEngine(), guestKey = new Uint8Array(32).fill(44), rz = schnorr.getPublicKey(secret)
  const guestPlatform = new wasm.Platform(schnorr.getPublicKey(guestKey), rz, { fill: n => crypto.getRandomValues(new Uint8Array(n)) })
  const credential = finalizeEvent({ kind: 20460, created_at: Number(now), content: '', tags: [['d', persona], ['scope', 'person'], ['device', bytesToHex(schnorr.getPublicKey(guestKey))], ['expiration', String(now + 20n * 86400n)]] }, secret)
  const joining = wasm.Session.prepareCapability(guestPlatform, now, {
    binding: { credential: { pubkey: hexToBytes(credential.pubkey), createdAt: BigInt(credential.created_at), tags: credential.tags, content: '', sig: hexToBytes(credential.sig) }, homeBox, expiresAt: now + 10n * 86400n },
    expiresAt: now + 2n * 86400n, adderRz: rz, counter: 0n,
  })
  let guest: Session | undefined, introducing: any, introduction: any
  try {
    const ask = joining.signRequest(), dh = joining.ecdhRequest()
    const made = joining.complete(now, ask.operation, schnorr.sign(ask.digest, guestKey), secp256k1.getSharedSecret(secret, concatBytes(Uint8Array.of(2), dh.peerRz)).slice(1))
    guest = made.session
    made.step.snapshot.plaintext.fill(0)
    const envelope = made.step.outbound[0].envelope
    introducing = wasm.prepareIntroduction(platform, now, rz, 0n)
    const req = introducing.request()
    introduction = introducing.complete(now, req.operation, secp256k1.getSharedSecret(secret, concatBytes(Uint8Array.of(2), req.peerRz)).slice(1))
    return await host.step(context(), ids[0], s => step(s.add(now, [introduction.openCapability(now, envelope)])))
  } finally { guest?.free(); introduction?.free(); introducing?.free(); joining.free(); guestPlatform.free() }
}

export async function resume() {
  await restart()
  const r = await host.sessions(context())
  if (r.state !== 'active') throw new Error('fixture resume held')
  ids = [...r.value.keys()]
}
