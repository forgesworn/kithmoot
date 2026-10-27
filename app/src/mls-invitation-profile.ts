/** An explicit distribution choice. This candidate is off unless selected at build time. */
export type MlsInvitationProfile = 'disabled' | 'admin2'
type Environment = Record<string, unknown>
export function mlsInvitationProfile(env: Environment = import.meta.env ?? {}): MlsInvitationProfile {
  const value = env.VITE_MLS_INVITATION_PROFILE
  if (value !== undefined && value !== '' && value !== 'disabled' && value !== 'admin2') throw new Error('VITE_MLS_INVITATION_PROFILE must be disabled or admin2')
  const profile = value === 'admin2' ? 'admin2' : 'disabled'
  if (profile === 'admin2') {
    if (env.VITE_ACCOUNT_NETWORK_DEFAULT !== 'private-invitations') throw new Error('Admin2 requires VITE_ACCOUNT_NETWORK_DEFAULT=private-invitations')
    for (const flag of ['VITE_BROWSER_MLS_PREVIEW', 'VITE_BROWSER_MLS_INVITATION_PREVIEW', 'VITE_BROWSER_MLS_ADMIN_INVITATION_PREVIEW', 'VITE_MIXED_INVITATION_LAB']) {
      if (env[flag] !== undefined && env[flag] !== '' && env[flag] !== 'false') throw new Error(`Admin2 product candidate cannot mix with ${flag}`)
    }
  }
  return profile
}
export const admin2ProductSelected = () => mlsInvitationProfile() === 'admin2'
export const browserMlsEnabled = () => admin2ProductSelected() || import.meta.env?.DEV === true && import.meta.env?.VITE_BROWSER_MLS_PREVIEW === 'true'
export function selectedRoomCreateOptions<T extends { experimentalInvitation?: boolean; experimentalAdminInvitation?: boolean }>(options: T): T {
  if (!admin2ProductSelected()) return { ...options }
  if (options.experimentalInvitation) throw new Error('Admin2 candidate refuses legacy invitation creation')
  return { ...options, experimentalInvitation: false, experimentalAdminInvitation: true }
}
/** Applied before any native snapshot opener. Unprofiled FullVmls1 is held too. */
export function roomProfileAllowed(room: { profile?: string; invitation?: unknown }): boolean {
  if (admin2ProductSelected()) return room.profile === 'InvitationAdmins2' && !!room.invitation
  if (room.profile === 'InvitationAdmins2') return import.meta.env?.DEV === true && import.meta.env?.VITE_BROWSER_MLS_ADMIN_INVITATION_PREVIEW === 'true'
  if (room.invitation) return import.meta.env?.DEV === true && import.meta.env?.VITE_BROWSER_MLS_INVITATION_PREVIEW === 'true'
  return true
}
