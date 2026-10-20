import { normaliseBlossomServer } from '../../src/attachment.js'

export const FILE_STORAGE_KEY = 'kithmoot.file-storage.v1'
export const LEGACY_FILE_STORAGE_KEY = 'kithmoot.blossom-server'
export const FILE_STORAGE_REQUIRED = 'File uploads are off. Private Bothy storage is not connected in this app yet. To use shared storage instead, open Add a file and explicitly allow the displayed server.'
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** The version new consents are written with. Version 1 was written while the
 * app pre-filled its own host, so a version 1 consent to a ForgeSworn host
 * may never have been a choice. Version 2 is always something a person did. */
const CONSENT_VERSION = 2
const FORGESWORN_DOMAINS = ['forgesworn.dev', 'kithmoot.app']

/** True for ForgeSworn's own hosts and any name under them. Unparseable input
 * is false: a caller that cares must validate the URL itself. */
export function isForgeSwornHost(origin: string): boolean {
  try {
    // A trailing dot names the same host in DNS, so it must not be a way round.
    const host = new URL(origin).hostname.toLowerCase().replace(/\.+$/, '')
    return FORGESWORN_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`))
  } catch { return false }
}

export interface PublicFileServer {
  readonly origin: string
  readonly operator: string
  readonly maxBytes: number
  /** The day the round trip below last passed. */
  readonly checked: string
}

/**
 * Public Blossom servers run by other people, offered as a convenience. This
 * is a short list on purpose, and listing a server is not consent to use it.
 *
 * An entry qualifies when we can name its operator and find published terms,
 * and a real round trip passed on the `checked` date: upload of an
 * `application/vnd.forgesworn.encrypted` envelope, fetch by hash with CORS
 * from the app origin, and a BUD-02 delete.
 *
 * Tried on 2026-10-20 and left out: blossom.primal.net rejects the bytes on
 * PUT with 415; blossom.band and blossom.nostr.build refuse the type;
 * nostr.download and files.sovbit.host worked but name no operator and
 * publish no terms.
 *
 * No ForgeSworn host may ever appear here (the test suite checks).
 */
export const PUBLIC_FILE_SERVERS: readonly PublicFileServer[] = Object.freeze([
  Object.freeze({ origin: 'https://blossom.yakihonne.com', operator: 'Yakihonne LLC', maxBytes: 209715200, checked: '2026-10-20' }),
])

function consentEntry(store: Store): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(store.getItem(FILE_STORAGE_KEY) ?? 'null')
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

/** A URL is not proof of private storage. Only the explicit shared-storage
 * consent is implemented here; a Bothy adapter must authenticate reads too.
 * Never promote an old URL preference into consent or fall back to the host. */
export function sharedFileServer(store: Store): string {
  try {
    const entry = consentEntry(store)
    if (!entry || entry.mode !== 'shared' || typeof entry.origin !== 'string') return ''
    if (entry.disclosure !== 1 && entry.disclosure !== CONSENT_VERSION) return ''
    const origin = normaliseBlossomServer(entry.origin)
    if (origin !== entry.origin) return ''
    // Version 1 came from the old pre-filled suggestion of ForgeSworn's own
    // host, so it is not taken as a choice. Typing the host is one.
    if (entry.disclosure === 1 && isForgeSwornHost(origin)) return ''
    return origin
  } catch { return '' }
}

export function requireSharedFileServer(store: Store): string {
  const origin = sharedFileServer(store)
  if (!origin) throw new Error(FILE_STORAGE_REQUIRED)
  return origin
}

export function allowSharedFileServer(store: Store, value: string, acknowledged: boolean): string {
  if (!acknowledged) throw new Error('Confirm that encrypted files may be publicly downloadable before allowing shared storage.')
  const origin = normaliseBlossomServer(value)
  store.setItem(FILE_STORAGE_KEY, JSON.stringify({ mode: 'shared', disclosure: CONSENT_VERSION, origin }))
  return origin
}

export function stopFileUploads(store: Store): void {
  store.removeItem(FILE_STORAGE_KEY)
}

/** Removes a version 1 consent that names a ForgeSworn host and says whether it
 * did, so the app can tell the person once. Nothing else is touched. */
export function retireSuggestedForgeSwornConsent(store: Store): boolean {
  try {
    const entry = consentEntry(store)
    if (!entry || entry.mode !== 'shared' || entry.disclosure !== 1) return false
    if (typeof entry.origin !== 'string' || !isForgeSwornHost(entry.origin)) return false
    store.removeItem(FILE_STORAGE_KEY)
    return true
  } catch { return false }
}

function usableSuggestion(value: string | null | undefined): string {
  if (!value) return ''
  try {
    const origin = normaliseBlossomServer(value)
    return isForgeSwornHost(origin) ? '' : origin
  } catch { return '' }
}

/** Display only. A previous destination is useful context, never authority.
 * `deployerDefault` is what whoever built this copy of the app chose to suggest.
 * Never the app's own origin, and never a ForgeSworn host unless the person
 * chose it with a consent that is still honoured. */
export function suggestedFileServer(store: Store, deployerDefault?: string): string {
  const approved = sharedFileServer(store)
  if (approved) return approved
  let legacy: string | null = null
  try { legacy = store.getItem(LEGACY_FILE_STORAGE_KEY) } catch { /* A blocked store has no suggestion. */ }
  return usableSuggestion(legacy) || usableSuggestion(deployerDefault)
}
