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
