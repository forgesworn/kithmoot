import { normaliseBlossomServer } from '../../src/attachment.js'
import { isForgeSwornHost } from '../../src/forgesworn-hosts.js'

export { isForgeSwornHost }

export const FILE_STORAGE_KEY = 'kithmoot.file-storage.v1'
export const LEGACY_FILE_STORAGE_KEY = 'kithmoot.blossom-server'
export const FILE_STORAGE_REQUIRED = 'File uploads are off on this device. Turn them on in Settings › Privacy › Where files go.'
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** The version new consents are written with. Version 1 was written while the
 * app pre-filled its own host, so a version 1 consent to a ForgeSworn host
 * may never have been a choice. Versions 2 and 3 are always something a
 * person did. Version 3 also records how the server was chosen (`via`). */
const CONSENT_VERSION = 3

/** How a server came to be chosen. `default` is honoured only while it is
 * still the default; `typed` is an address a person gave; `wildbloom` is
 * reserved for a node the person let KithMoot into (stage C). */
export type FileServerVia = 'default' | 'typed' | 'wildbloom'

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

export interface StoredFileServer { readonly origin: string; readonly via: FileServerVia }

/** The server a stored, valid shared consent names, and how it was chosen.
 * A URL is not proof of private storage. Only the explicit shared-storage
 * consent is read here; a Bothy adapter must authenticate reads too. Never
 * promote an old URL preference into consent or fall back to a host. */
export function storedFileServer(store: Store): StoredFileServer | undefined {
  try {
    const entry = consentEntry(store)
    if (!entry || entry.mode !== 'shared' || typeof entry.origin !== 'string') return undefined
    if (entry.disclosure !== 1 && entry.disclosure !== 2 && entry.disclosure !== CONSENT_VERSION) return undefined
    const origin = normaliseBlossomServer(entry.origin)
    if (origin !== entry.origin) return undefined
    // ForgeSworn's shared storage takes no new files, so a choice naming
    // one of its hosts, however it was made, is never a destination.
    if (isForgeSwornHost(origin)) return undefined
    if (entry.disclosure !== CONSENT_VERSION) return { origin, via: 'typed' }
    if (entry.via !== 'default' && entry.via !== 'typed' && entry.via !== 'wildbloom') return undefined
    return { origin, via: entry.via }
  } catch { return undefined }
}

/** True once a person has chosen "Nowhere" on this device. */
export function fileUploadsChosenOff(store: Store): boolean {
  const entry = consentEntry(store)
  return entry?.mode === 'off'
}

/** Where files go from the stored choice alone, whatever the default is now. */
export function sharedFileServer(store: Store): string {
  return storedFileServer(store)?.origin ?? ''
}

export function usableFileServer(value: string | null | undefined): string {
  if (!value) return ''
  try {
    const origin = normaliseBlossomServer(value)
    return isForgeSwornHost(origin) ? '' : origin
  } catch { return '' }
}

/** The public server entry for an origin, if it is on the list. */
export function publicFileServer(origin: string): PublicFileServer | undefined {
  return PUBLIC_FILE_SERVERS.find(server => server.origin === origin)
}

/** Which server a build offers by default: what whoever built this copy of the
 * app chose (`VITE_KITHMOOT_FILE_SERVER`) if it is usable, else the first
 * vetted public server. Never a ForgeSworn host. */
export function defaultFileServer(deployerDefault?: string, servers: readonly PublicFileServer[] = PUBLIC_FILE_SERVERS): { origin: string; maxBytes?: number } | undefined {
  const deployer = usableFileServer(deployerDefault)
  if (deployer) {
    const known = servers.find(server => server.origin === deployer)
    return known ? { origin: deployer, maxBytes: known.maxBytes } : { origin: deployer }
  }
  const first = servers[0]
  return first ? { origin: first.origin, maxBytes: first.maxBytes } : undefined
}

export type FileDestination =
  | { kind: 'group'; nodes: readonly string[] }       // S5b inserts this branch
  | { kind: 'withdrawn' }                              // S5b inserts this branch
  | { kind: 'bothy' }
  | { kind: 'server'; origin: string; via: FileServerVia }
  | { kind: 'default'; origin: string; maxBytes?: number }  // consent not yet given: show the notice
  | { kind: 'off'; reason: 'chosen' | 'no-default' }

export interface FileDestinationInput {
  store: Store
  roomUsesBothy: boolean
  deployerDefault?: string
  /** The vetted list; only tests pass anything but the real one. */
  publicServers?: readonly PublicFileServer[]
  /** S5b: the room's storage record. `nodes` empty means withdrawn. */
  roomStorage?: { nodes: readonly string[] }
}

/**
 * The one place that decides where a file goes. First match wins:
 *
 * 1. a room storage record with nodes: `group` (S5b)
 * 2. a room storage record with none: `withdrawn` (S5b)
 * 3. a Bothy room: `bothy`
 * 4. the person chose Nowhere: `off`
 * 5. a stored, valid shared consent: `server`; a `default` consent that names a
 *    server which is no longer the default falls through, so uploads never
 *    move to a different third party without telling the person
 * 6. a default exists: `default` (the one-time notice)
 * 7. otherwise `off` (`no-default`)
 *
 * Pure and synchronous: the upload's `fetch` wrapper calls it again just
 * before the request leaves, so a changed choice stops the next upload.
 */
export function resolveFileDestination(input: FileDestinationInput): FileDestination {
  // S5b: the room's own storage list comes first, above Bothy and the device.
  if (input.roomStorage) {
    return input.roomStorage.nodes.length
      ? { kind: 'group', nodes: input.roomStorage.nodes }
      : { kind: 'withdrawn' }
  }
  if (input.roomUsesBothy) return { kind: 'bothy' }
  if (fileUploadsChosenOff(input.store)) return { kind: 'off', reason: 'chosen' }
  const fallback = defaultFileServer(input.deployerDefault, input.publicServers)
  const stored = storedFileServer(input.store)
  if (stored && (stored.via !== 'default' || stored.origin === fallback?.origin)) {
    return { kind: 'server', origin: stored.origin, via: stored.via }
  }
  if (fallback) return { kind: 'default', origin: fallback.origin, ...(fallback.maxBytes !== undefined ? { maxBytes: fallback.maxBytes } : {}) }
  return { kind: 'off', reason: 'no-default' }
}

/** The origin a destination uploads to, or '' when it uploads nowhere yet. */
export function destinationOrigin(destination: FileDestination): string {
  return destination.kind === 'server' ? destination.origin : ''
}

/** Size limit to check before uploading, when the destination's is known. */
export function destinationLimit(destination: FileDestination): number | undefined {
  if (destination.kind === 'default') return destination.maxBytes
  if (destination.kind === 'server') return publicFileServer(destination.origin)?.maxBytes
  return undefined
}

/** "200 MB", for a server's limit. */
export function formatLimit(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
}

/** Press Send with the notice showing: the person acted, so this device now
 * uses the default. Written as `via: 'default'` and honoured only while that
 * server is still the default. */
export function acceptDefaultFileServer(store: Store, origin: string): string {
  const server = normaliseBlossomServer(origin)
  store.setItem(FILE_STORAGE_KEY, JSON.stringify({ mode: 'shared', disclosure: CONSENT_VERSION, origin: server, via: 'default' }))
  return server
}

/** Choosing a server in Settings. `via` says whether it is the public default
 * or an address the person typed. */
export function chooseFileServer(store: Store, value: string, via: FileServerVia = 'typed'): string {
  const origin = normaliseBlossomServer(value)
  if (isForgeSwornHost(origin)) throw new Error(FORGESWORN_STORAGE_CLOSED)
  store.setItem(FILE_STORAGE_KEY, JSON.stringify({ mode: 'shared', disclosure: CONSENT_VERSION, origin, via }))
  return origin
}

/** Nowhere. Removing the key now means "never chosen", which is the default,
 * so turning uploads off writes the choice down. */
export function stopFileUploads(store: Store): void {
  store.setItem(FILE_STORAGE_KEY, JSON.stringify({ mode: 'off', disclosure: CONSENT_VERSION }))
}

/** Said once, in the one-time notice, to a device whose choice named a
 * ForgeSworn host, and in Settings to anyone who types one. */
export const FORGESWORN_STORAGE_CLOSED = 'ForgeSworn’s shared storage no longer takes new files.'

/** Removes a stored choice that names a ForgeSworn host, whichever version
 * wrote it: ForgeSworn's shared storage takes no new files. The device is then
 * "never chosen" and meets the one-time notice, which names the current
 * default; true means the caller should say why, once. Files already stored
 * there are not touched. */
export function retireForgeSwornConsent(store: Store): boolean {
  try {
    const entry = consentEntry(store)
    if (!entry || entry.mode !== 'shared') return false
    if (typeof entry.origin !== 'string' || !isForgeSwornHost(entry.origin)) return false
    store.removeItem(FILE_STORAGE_KEY)
    return true
  } catch { return false }
}


/** One tray line for an upload that did not go through, with the actions it offers. */
export type { FileTrayFailure } from './drafts.js'
import type { FileTrayFailure } from './drafts.js'

export interface UploadFailureContext {
  host: string
  name: string
  /** `navigator.onLine`, read when the upload started. */
  online: boolean
  /** The server was typed or is the person's own Wildbloom, not the public default. */
  own: boolean
  size: number
  /** The server's known limit, already formatted ("200 MB"), if there is one. */
  limit?: string
  /** The size, already formatted. */
  sizeText: string
}

/** The tray's words for an upload error, from the message the upload threw
 * (`uploadEnvelopeBlob` says the status in brackets or after "answered").
 * Undefined for anything it does not recognise, which the caller shows as it
 * is. Never suggests a retry on a different server by itself. */
export function describeUploadFailure(error: unknown, ctx: UploadFailureContext): FileTrayFailure | undefined {
  if (!ctx.online) return { text: `You’re offline. ${ctx.name} will upload when you try again.`, retry: true }
  const message = error instanceof Error ? error.message : String(error)
  const status = Number(/\((\d{3})[:)]/.exec(message)?.[1] ?? /answered (\d{3})/.exec(message)?.[1])
  const network: FileTrayFailure = { text: `${ctx.host} didn’t take ${ctx.name}. Check your connection and try again.`, retry: true, another: true }
  if (status === 413) {
    return ctx.limit
      ? { text: `${ctx.host} takes files up to ${ctx.limit}. ${ctx.name} is ${ctx.sizeText}.` }
      : { text: `${ctx.host} won’t take a file as big as ${ctx.name} (${ctx.sizeText}).`, another: true }
  }
  if (status === 415) return { text: `${ctx.host} won’t store ${ctx.name}. Choose another server.`, another: true }
  if ((status === 401 || status === 403) && ctx.own) {
    return { text: `${ctx.host} didn’t let this device upload. If it’s Wildbloom Node, let KithMoot in again in Settings.`, another: true }
  }
  if (/^Could not reach /.test(message) || status >= 400) return network
  return undefined
}
