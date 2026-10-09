import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { BrowserMlsPersonaStore, LockedPersonaStore, type PersonaWitnessRoute } from '../app/src/mls-persona-store.js'
import { BrowserPersonaCoordinator } from '../app/src/mls-persona-coordinator.js'
import { personaWriter, pairedWitnessIdentity } from '../app/src/mls-writer-identity.js'
import { CoordinatedMlsVault, BOX_METHOD, type BoxRequest } from '../app/src/mls-coordinated-vault.js'
import { MlsVault, BrowserMlsVaultStorage, SIGN_METHOD, base64Encode, type ConsentScope, type SignLeafBindingRequest } from '../app/src/mls-vault.js'
import { loadMlsEngine } from '../app/src/mls-engine.js'
import type { WitnessAnswer } from '../app/src/mls-witness-link.js'
import { encodeUnsignedBinding } from './vmls-encode.js'
import { bindingDigest } from '../src/vmls/binding.js'
export { saveProfile, restoreProfile, damage } from './mls-persona-coordinator.browser-entry.js'
export { boxRequest } from '../app/src/mls-coordinated-vault.js'

const secret = new Uint8Array(32).fill(42), persona = getPublicKey(secret), principal = 'https://kithmoot.test', boxId = '78'.repeat(32)
const subject = '45'.repeat(32), dbName = 'mls-coordination-test'
let clock = 1_793_577_600, generation = 0, credential: any, deviceId = '', lastReply: any, lastRequest: SignLeafBindingRequest
const identity = { pubkey: persona, async signEvent(e: any) { credential = finalizeEvent(e, secret); return credential } }
const store = new BrowserMlsPersonaStore(dbName)
let host: BrowserPersonaCoordinator, vault: CoordinatedMlsVault
export function restart() {
  host = new BrowserPersonaCoordinator(store, async () => ({ read: r => exchange('read', r), advance: r => exchange('advance', r) }))
  vault = new CoordinatedMlsVault(host, { now: () => clock, generation: () => generation })
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
export async function enrol(replace = false) {
  const answer = await vault.enrol(ctx(), identity, clock + 7 * 86400, { replace })
  if (answer.ok) deviceId = answer.value.device
  return answer
}
export function request() {
  const body = encodeUnsignedBinding({ leafId: randomBytes(32), signatureKey: randomBytes(32), credential, device: deviceId, expiresAt: clock + 86400, homeBox: hexToBytes(boxId) })
  return lastRequest = { v: 1, operation: bytesToHex(randomBytes(32)), body: base64Encode(body), digest: bytesToHex(bindingDigest(body)), expires_at: clock + 300 }
}
export async function sign(req = lastRequest, decision: 'approve' | 'deny' = 'approve') {
  let asked = 0
  const answer = await vault.signLeafBindingV1(ctx(), req, async () => { asked++; return decision })
  if (answer.ok) lastReply = answer.value
  return { answer, asked }
}
export function accept(req = lastRequest) { return vault.acceptSignReply(req, lastReply) }
export function advanceClock(seconds: number) { clock += seconds }
export function changeAccount() { generation++ }
export async function status() { return (await host.status(persona, () => true)).state }
export async function device() { return vault.device(ctx()) }
const scope = (method = SIGN_METHOD): ConsentScope => ({ principal, persona, device: deviceId, homeBox: boxId, method: method as ConsentScope['method'] })
export async function policy(action: 'approve' | 'withdraw' | 'revoke', method = SIGN_METHOD) {
  if (action === 'revoke') return vault.revokeCredential(ctx(), credential.id)
  return vault[action](ctx(), scope(method))
}
export async function box(input?: BoxRequest, decision: 'approve' | 'deny' = 'approve') {
  const req = input ?? { v: 1, box: boxId, method: 'POST', path: '/vmls/v1/fetch', payload: '12'.repeat(32) }
  let asked = 0
  const answer = await vault.signBoxRequestV1(ctx(), req, async () => { asked++; return decision })
  if (!answer.ok) return { answer, asked }
  const event = JSON.parse(atob(answer.value.authorization.slice(6)))
  return { answer, asked, event, accepted: vault.acceptBoxReply(req, answer.value), substituted: vault.acceptBoxReply({ ...req, path: '/vmls/v1/ack' }, answer.value) }
}
export async function boxBurst() {
  const replies = []
  for (let i = 0; i < 32; i++) replies.push(await box())
  return replies.map(r => r.answer.ok ? r.event.created_at : r.answer.refusal)
}
export async function faultSign(mode: 'stage' | 'promotion' | 'stale-close') {
  const write = LockedPersonaStore.prototype.write, close = LockedPersonaStore.prototype.close
  let injected = false
  LockedPersonaStore.prototype.write = async function (...args) {
    const value = await write.apply(this, args)
    if (!injected && ((mode === 'stage' && value.data.staged) || (mode === 'promotion' && !value.data.staged && value.data.active.vault.length))) {
      injected = true; throw new Error('fixture interruption')
    }
    return value
  }
  LockedPersonaStore.prototype.close = async function () { await close.call(this); if (mode === 'stale-close') generation++ }
  try { return await sign() } catch (e) { return { error: (e as Error).message, injected } }
  finally { LockedPersonaStore.prototype.write = write; LockedPersonaStore.prototype.close = close }
}
export async function consentRace(action: 'replace' | 'account' | 'withdraw') {
  return vault.signLeafBindingV1(ctx(), lastRequest, async () => {
    if (action === 'replace') await enrol(true)
    else if (action === 'account') changeAccount()
    else await policy('withdraw')
    return 'approve'
  })
}
const legacyStorage = new BrowserMlsVaultStorage('mls-legacy-test')
let legacy = new MlsVault(legacyStorage, { now: () => clock })
export async function legacyEnrol() {
  const answer = await legacy.enrol(legacy.context(principal, persona), identity, clock + 7 * 86400)
  if (answer.ok) deviceId = answer.value.device
  return answer
}
export async function legacySign() { return legacy.signLeafBindingV1(legacy.context(principal, persona), lastRequest, async () => 'approve') }
export async function migrate() { return vault.migrate(ctx(), legacy) }
export async function legacyAfterMigration() {
  legacy = new MlsVault(legacyStorage, { now: () => clock })
  try { return await legacy.device(legacy.context(principal, persona)) } catch (e) { return { error: (e as Error).message } }
}
export async function localRecord() {
  return store.withPersona(persona, async s => {
    const file = (await s.read())!, o = file.data.active.vault[0]
    const bytes = o && await s.openObject(file.data.installation, o.id, o.sealed)
    try {
      const r = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : undefined
      return { active: file.data.active.vault.length, staged: file.data.staged?.vault.length ?? null,
        fence: file.marker.reason, device: r?.device.device, journal: r?.journal.length, approved: r?.policy.approved.length, retired: r?.retired, migrated: r?.migrated }
    } finally { bytes?.fill(0) }
  })
}
export async function clear() {
  vault.bump()
  return host.clear(persona, () => true)
}
export async function loadExisting() {
  const r = await vault.device(ctx())
  if (r.ok) deviceId = r.value.device
  return r
}
export async function fillJournal() {
  return host.transact(persona, async tx => {
    const id = bytesToHex(new TextEncoder().encode('kithmoot.typed-vault.v1'))
    const r = JSON.parse(new TextDecoder().decode((await tx.readVault(id))!))
    const context = ctx()
    r.journal = Array.from({ length: 1024 }, (_, i) => ({ generation: context.generation, revision: context.revision, principal,
      handle: r.device.device, operation: i.toString(16).padStart(64, '0'), bodyHash: '12'.repeat(32), digest: '34'.repeat(32), deadline: clock + 300, outcome: { ok: false, refusal: 'denied' } }))
    const bytes = new TextEncoder().encode(JSON.stringify(r))
    try { await tx.putVault(id, bytes) } finally { bytes.fill(0); r.device.scalar = '' }
  }, () => true).then(r => r.state)
}
export async function malformedRecord() {
  return host.transact(persona, async tx => {
    await tx.putVault(bytesToHex(new TextEncoder().encode('kithmoot.typed-vault.v1')), new TextEncoder().encode('{"version":2}'))
  }, () => true).then(r => r.state)
}
export async function typedClear() {
  const installation = await store.withPersona(persona, async s => (await s.marker())!.installation)
  return vault.clear(ctx(), installation)
}
