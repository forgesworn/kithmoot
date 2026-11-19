import { BrowserMlsRoomConsent } from '../app/src/mls-room-consent.js'
import { BrowserMlsRoomForeground } from '../app/src/mls-room-foreground.js'
import type { AdminInvitationConsent } from '../app/src/mls-coordinated-vault.js'

const hex = (value: number) => value.toString(16).padStart(2, '0').repeat(32)
const account = hex(1)
const context = {
  invitationId: hex(2), inviterPersona: account, inviterDevice: hex(3), inviterRz: hex(4),
  joinerPersona: hex(5), joinerDevice: hex(6), joinerRz: hex(7), groupId: hex(8),
  groupHome: hex(9), groupInstallation: hex(10), joinerHome: hex(11),
  adminSetCommitment: hex(12), returnRoute: { type: 'PrivateOob' as const }, expiresAt: 1_900_000_000,
}
const permission: AdminInvitationConsent = {
  method: 'signAdminInvitationV2/1', principal: 'admin-consent-test', persona: account,
  device: hex(3), homeBox: context.groupHome, context,
}

export function startAdminConsent() {
  const global = window as unknown as { adminConsentDecision?: string; adminConsentPending?: boolean; adminConsentContext?: typeof context }
  global.adminConsentPending = true
  global.adminConsentDecision = undefined
  global.adminConsentContext = context
  const foreground = new BrowserMlsRoomForeground()
  const deadline = Math.floor(Date.now() / 1000) + 60
  void foreground.run(account, () => true, scope =>
    new BrowserMlsRoomConsent(document).askAdminInvitation(foreground, scope, permission, deadline, () => true),
  ).then(result => {
    global.adminConsentDecision = result.state === 'done' ? result.value : 'interrupted'
    global.adminConsentPending = false
  })
}
