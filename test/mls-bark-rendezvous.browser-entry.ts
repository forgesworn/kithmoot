import { invitationFixture } from './mls-invitation-fixture.js'
import { loadMlsEngine } from '../app/src/mls-engine.js'
import { loadInvitationEngine } from '../app/src/mls-invitation-engine.js'
export async function provision(mode: string) { return (await invitationFixture()).barkProvision(mode) }
export async function coexistence() {
  const f = await invitationFixture()
  const legacy = await f.create('alice', false), invitation = await f.create('bob', true)
  const left = await f.read('alice'), right = await f.read('bob')
  return { legacy: legacy.state, invitation: invitation.state, legacyRead: left.state, invitationRead: right.state,
    oneModule: (await loadMlsEngine() as unknown) === await loadInvitationEngine() }
}

export async function retainedInvitation(mode = 'success') {
  const f = await invitationFixture(), invitationDeadline = Math.floor(Date.now() / 1000) + 3600
  const created = await f.create('alice')
  if (created.state !== 'active') throw new Error('Fixture room creation failed')
  f.advance(601); f.restart('alice'); f.restart('bob')
  if (mode === 'clear') await f.clearRendezvous('alice')
  if (mode === 'rotation') await f.rotateRendezvous('alice')
  if (mode === 'account') f.invalidate('alice')
  let issued
  try { issued = await f.issue('alice', 'bob', { expiresAt: invitationDeadline }) }
  catch (error) { return { held: true, reason: String(error) } }
  if (issued.state !== 'active') return { held: true, reason: issued.state }
  const accepted = await f.accept('bob', 'alice', issued.value.authorization)
  return { issued: issued.state, accepted: accepted.state, reopened: (await f.read('alice')).state }
}
