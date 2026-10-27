import { invitationFixture } from './mls-invitation-fixture.js'
import { BrowserMlsRoomDevelopmentPanel } from '../app/src/mls-room-development-panel.js'
const active = (label: string, r: any): any => { if (r?.state !== 'active') throw new Error(label + ': ' + r?.state + '/' + (r?.reason ?? '')); return r.value }
const refused = async (work: () => Promise<any>, expected: string | number) => {
  let result: any
  try { result = await work() }
  catch (error) {
    const native = error as { kind?: string; code?: string; number?: number }
    if (typeof expected === 'number' && native.kind === 'engine' && native.number === expected && native.code === 'AdminRequired') return true
    throw error
  }
  if (typeof expected !== 'string' || result?.state !== 'refused' || result.reason !== expected) throw new Error(`Expected exact refusal ${expected}; received ${JSON.stringify(result)}`)
  return true
}
async function added(f: any, from: string, to: string, observers: string[] = []) {
  const issued = active('issue', await f.issue(from, to)), accepted = active('accept', await f.accept(to, from, issued.authorization))
  const pending = active('pending state', await f.read(to))
  if (pending.adminRoles) throw new Error('Pending join exposed applied admin roles')
  active('record', await f.record(from, issued.authorization, accepted.response.envelope))
  const add = active('add', await f.add(from, issued.authorization, accepted.response.envelope)), committed = await f.commit(from, add, observers)
  if (committed.welcomes.length !== 1) throw new Error('Expected one real Welcome')
  active('welcome', await f.process(to, committed.welcomes[0]))
  const update = active('member Update', await f.update(to)); await f.commit(to, update, [from, ...observers])
}
async function deliver(f: any, from: string, to: string[], text: string) {
  const sent = active('send', await f.send(from, text)); for (const out of sent.outbound) for (const peer of to) active('receive', await f.process(peer, out))
}
export async function lifecycle() {
  const f: any = await invitationFixture('InvitationAdmins2')
  active('create', await f.create('alice')); await added(f, 'alice', 'bob')
  let a = active('admin read', await f.read('alice')), b = active('member read', await f.read('bob'))
  if (!a.adminRoles.ownIsAdmin || b.adminRoles.ownIsAdmin) throw new Error('Creator/member roles differ')
  const bobLeaf = b.members.find((m: any) => m.own).leafId, aliceLeaf = a.members.find((m: any) => m.own).leafId
  const memberInviteRefused = await refused(() => f.issue('bob', 'carol'), 195), memberRemoveRefused = await refused(() => f.remove('bob', aliceLeaf), 'admin-required')
  const lastRemoveRefused = await refused(() => f.remove('alice', aliceLeaf), 'last-admin'), lastDemoteRefused = await refused(() => f.role('alice', aliceLeaf, false, a.adminRoles.adminSetCommitment), 'last-admin')
  await deliver(f, 'bob', ['alice'], 'ordinary member message')
  const ordinaryDelivered = active('Alice receives member message', await f.read('alice')).history.some((entry: any) => entry.direction === 'received' && new TextDecoder().decode(entry.body) === 'ordinary member message')
  const original = a.adminRoles.adminSetCommitment
  const promote = active('promote exact member device', await f.role('alice', bobLeaf, true, original)); await f.commit('alice', promote, ['bob'])
  const staleRefused = await refused(() => f.role('alice', bobLeaf, false, original), 'stale-admin-policy')
  a = active('applied promotion', await f.read('alice')); b = active('applied member promotion', await f.read('bob'))
  if (!b.adminRoles.ownIsAdmin || a.adminRoles.adminSetCommitment === original) throw new Error('Promotion was not applied')
  const stored = active('stored policy', await f.saved('alice'))
  if (stored.profile !== 'InvitationAdmins2' || stored.invitation.adminSetCommitment !== a.adminRoles.adminSetCommitment) throw new Error('Protected policy did not track applied native roles')
  await f.restart('alice'); await f.restart('bob')
  a = active('restart admin', await f.read('alice')); b = active('restart promoted member', await f.read('bob'))
  if (!b.adminRoles.ownIsAdmin) throw new Error('Trusted restart lost applied roles')
  const snapshot = active('snapshot', await f.summary('alice'))
  const demote = active('demote creator device', await f.role('bob', aliceLeaf, false, b.adminRoles.adminSetCommitment)); await f.commit('bob', demote, ['alice'])
  const demotedInviteRefused = await refused(() => f.issue('alice', 'carol'), 195)
  await added(f, 'bob', 'carol', ['alice'])
  const remove = active('current admin removes demoted creator', await f.remove('bob', aliceLeaf)); await f.commit('bob', remove, ['alice', 'carol'])
  await deliver(f, 'bob', ['carol'], 'after removal')
  return { memberInviteRefused, memberRemoveRefused, lastRemoveRefused, lastDemoteRefused, staleRefused, demotedInviteRefused,
    snapshotVersion: snapshot.snapshotVersion, removedPhase: active('removed', await f.read('alice')).phase.type,
    ordinaryDelivered,
    typedPolicyConsents: f.stats().invitationPolicyConsents.length, keeperActors: f.stats().packagesBy }
}
let panel: BrowserMlsRoomDevelopmentPanel | undefined
export function openPanel() { panel = new BrowserMlsRoomDevelopmentPanel(() => undefined); panel.open() }
