import { BrowserMlsRoomDevelopmentPanel } from '../app/src/mls-room-development-panel.js'
import { invitationFixture } from './mls-invitation-fixture.js'
const active = (label: string, r: any): any => {
  if (r?.state !== 'active') throw new Error(label + ': ' + r?.state + '/' + (r?.reason ?? ''))
  return r.value
}
const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])
const texts = (r: any) => active('read', r).history.map((h: any) => new TextDecoder().decode(h.body))
async function added(f: any, from: string, to: string, observers: string[] = []) {
  const issued = active('issue', await f.issue(from, to))
  const accepted = active('accept', await f.accept(to, from, issued.authorization))
  active('record', await f.record(from, issued.authorization, accepted.response.envelope))
  const add = active('add', await f.add(from, issued.authorization, accepted.response.envelope))
  const committed = await f.commit(from, add, observers)
  if (committed.welcomes.length !== 1) throw new Error('Expected one real Welcome')
  active('welcome', await f.process(to, committed.welcomes[0]))
  const update = active('required update', await f.update(to))
  await f.commit(to, update, [from, ...observers])
  return { issued, response: accepted.response }
}
async function deliver(f: any, from: string, to: string[], text: string) {
  const effect = active('send', await f.send(from, text))
  for (const out of effect.outbound) for (const peer of to) active('receive', await f.process(peer, out))
}
export async function lifecycle() {
  const f: any = await invitationFixture()
  active('create', await f.create('alice'))
  await added(f, 'alice', 'bob')
  await deliver(f, 'alice', ['bob'], 'synthetic forward')
  await deliver(f, 'bob', ['alice'], 'synthetic return')
  const before = active('response before restart', await f.response('bob')).response
  await f.restart('alice'); await f.restart('bob')
  const after = active('response after restart', await f.response('bob')).response
  const exactRetry = bytesEqual(before.envelope, after.envelope) && bytesEqual(before.recordId, after.recordId)
  const aHistory = texts(await f.read('alice')), bHistory = texts(await f.read('bob'))
  await added(f, 'bob', 'carol', ['alice'])
  const a: any = active('creator roster', await f.read('alice'))
  const ownLeaf = a.members.find((m: any) => m.own)?.leafId
  if (!ownLeaf) throw new Error('Creator leaf absent before removal')
  const removal = active('guest removes creator', await f.remove('bob', ownLeaf))
  await f.commit('bob', removal, ['alice', 'carol'])
  await deliver(f, 'bob', ['carol'], 'synthetic after removal')
  const removed = active('removed state', await f.read('alice')), survivor = active('survivor state', await f.read('carol'))
  return {
    forward: bHistory.includes('synthetic forward'), backward: aHistory.includes('synthetic return'), exactRetry,
    removedPhase: removed.phase.type, survivorPhase: survivor.phase.type,
    survivorReceived: texts(await f.read('carol')).includes('synthetic after removal'),
    stats: f.stats(),
  }
}
export async function wrongInviter() {
  const f: any = await invitationFixture()
  active('create', await f.create('alice'))
  const issued = active('issue', await f.issue('alice', 'bob'))
  const before = f.metadata('bob').session
  const protectedBefore = active('protected sessions before', await f.summary('bob')).sessionCount
  let state: string
  try { state = (await f.accept('bob', 'carol', issued.authorization)).state } catch { state = 'refused' }
  return { state, sameSession: f.metadata('bob').session === before, sameProtectedSessionCount: active('protected sessions after', await f.summary('bob')).sessionCount === protectedBefore, stats: f.stats() }
}
export async function lostLocalContinuity() {
  const f: any = await invitationFixture()
  active('create', await f.create('alice'))
  localStorage.removeItem('kithmoot.mls-invitation.local-installation.v1')
  let state: string
  try { state = (await f.read('alice')).state } catch { state = 'refused' }
  return { state }
}

export async function missingAndForgedRegistration() {
  const f: any = await invitationFixture()
  active('create', await f.create('alice'))
  const issued = active('issue', await f.issue('alice', 'bob'))
  const accepted = active('accept', await f.accept('bob', 'alice', issued.authorization))
  active('record', await f.record('alice', issued.authorization, accepted.response.envelope))
  const request = active('private registration request', await f.registrationRequest('alice', issued.authorization, accepted.response.envelope)).registrationRequest
  f.setNodeRegistrationReceipt(false)
  const refused = async (work: () => Promise<any>) => { try { return await work() } catch { return { state: 'refused' } } }
  const unsigned = await refused(() => f.keeperRegister(request))
  const missing = await refused(() => f.addReceipt('alice', issued.authorization, accepted.response.envelope, new Uint8Array()))
  f.setNodeRegistrationReceipt(true)
  const signed = await f.keeperRegister(request)
  if (signed.state !== 'ok') throw new Error('Independent keeper could not produce signed registration')
  const forged = signed.value.registrationReceipt.slice(); forged[forged.length - 1] ^= 1
  const rejected = await refused(() => f.addReceipt('alice', issued.authorization, accepted.response.envelope, forged))
  const before = active('roster after rejected proofs', await f.members('alice'))
  const valid = await f.addReceipt('alice', issued.authorization, accepted.response.envelope, signed.value.registrationReceipt)
  return { unsignedState: unsigned.state, missingState: missing.state, forgedState: rejected.state, membersBeforeValid: before.length, validState: valid.state }
}

export async function adoptionReplyLoss() {
  const f: any = await invitationFixture()
  active('create', await f.create('alice'))
  const issued = active('issue', await f.issue('alice', 'bob'))
  const lost = await f.loseAdoptionReply('bob', 'alice', issued.authorization)
  await f.restart('bob')
  const recovered = active('recover same adoption', await f.accept('bob', 'alice', issued.authorization))
  const firstResponse = recovered.response
  await f.restart('bob')
  const retried = active('recover exact response again', await f.response('bob')).response
  const summary = active('single protected session', await f.summary('bob'))
  return { injected: lost.injected, firstState: lost.result.state, witnessAdvanced: lost.witnessAdvanced,
    sameCandidateSession: recovered.session === lost.candidateSessionId, candidateGeneration: lost.candidateGeneration,
    sessions: summary.sessionCount, exactResponse: bytesEqual(firstResponse.envelope, retried.envelope) && bytesEqual(firstResponse.recordId, retried.recordId) }
}
let ui: BrowserMlsRoomDevelopmentPanel | undefined
export function openRealPanel() { ui = new BrowserMlsRoomDevelopmentPanel(() => undefined); ui.open() }
export async function clearRealPanel() { await ui!.invalidate() }
