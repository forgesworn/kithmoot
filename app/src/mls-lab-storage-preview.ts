import { invitationPreviewEnabled } from './mls-invitation-engine.js'
import { adminInvitationPreviewEnabled } from './mls-admin-invitation-engine.js'

/** Disposable node storage permission only. It confers no MLS authority. */
export function labStoragePreviewEnabled(): boolean {
  const legacy = invitationPreviewEnabled(), admin = adminInvitationPreviewEnabled()
  return import.meta.env?.VITE_BROWSER_MLS_PREVIEW === 'true' && legacy !== admin
}
