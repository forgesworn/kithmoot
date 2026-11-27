import { CALL_RELAY_PROFILE_LIMIT, parseCallRelay, withCallRelayStandby, type CallRelay, type CallRelayLogin } from './call-relay.js'

export const INVALID_CALL_RELAY_PROFILE = 'This is not a supported call relay file. Ask for a file with TURN addresses, login details and an optional standby relay.'

function readProfile(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
  const profile = value as Record<string, unknown>
  if (Object.keys(profile).some(key => !allowed.includes(key))) throw new Error()
  return profile
}

function readLogin(profile: Record<string, unknown>): CallRelayLogin {
  if (profile.credentialType !== undefined && profile.credentialType !== 'password') throw new Error()
  const urls = typeof profile.urls === 'string' ? [profile.urls] : profile.urls
  if (!Array.isArray(urls) || urls.some(url => typeof url !== 'string' || url.includes(',')) ||
      typeof profile.username !== 'string' || typeof profile.credential !== 'string') throw new Error()
  const relay = parseCallRelay(urls.join(','), profile.username, profile.credential)
  if (!relay) throw new Error()
  return relay
}

/** A provider's per-device transport login, never a provider account or root key.
 * Parsing has no network or storage effects. Do not echo untrusted input. */
export function parseCallRelayProfile(text: string): CallRelay {
  try {
    if (text.length > CALL_RELAY_PROFILE_LIMIT) throw new Error()
    const fields = ['urls', 'username', 'credential', 'credentialType']
    const profile = readProfile(JSON.parse(text), [...fields, 'standby'])
    const primary = readLogin(profile)
    return profile.standby === undefined ? primary : withCallRelayStandby(primary, readLogin(readProfile(profile.standby, fields)))
  } catch { throw new Error(INVALID_CALL_RELAY_PROFILE) }
}
