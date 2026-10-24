import { parseCallRelay, type CallRelay } from './call-relay.js'

export const CALL_RELAY_PROFILE_LIMIT = 16_384
export const INVALID_CALL_RELAY_PROFILE = 'This is not a supported call relay file. Ask for a file containing only TURN addresses, username and password.'

/** A provider's per-device transport login, never a provider account or root key.
 * Parsing has no network or storage effects. Do not echo untrusted input. */
export function parseCallRelayProfile(text: string): CallRelay {
  try {
    if (text.length > CALL_RELAY_PROFILE_LIMIT) throw new Error()
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    const profile = value as Record<string, unknown>
    if (Object.keys(profile).some(key => !['urls', 'username', 'credential', 'credentialType'].includes(key))) throw new Error()
    if (profile.credentialType !== undefined && profile.credentialType !== 'password') throw new Error()
    const urls = typeof profile.urls === 'string' ? [profile.urls] : profile.urls
    if (!Array.isArray(urls) || urls.some(url => typeof url !== 'string') ||
        typeof profile.username !== 'string' || typeof profile.credential !== 'string') throw new Error()
    // A JSON URL entry must be one URL, not a second comma-separated list.
    if (urls.some(url => url.includes(','))) throw new Error()
    const relay = parseCallRelay(urls.join(','), profile.username, profile.credential)
    if (!relay) throw new Error()
    return relay
  } catch { throw new Error(INVALID_CALL_RELAY_PROFILE) }
}
