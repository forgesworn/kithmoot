import { resolve, sep } from 'node:path'
import { PASSWORD_WORD_LIST } from './meeting-code-words.mjs'
export const ORIGIN = 'https://kithmoot.forgesworn.dev'
export const HOME = `${ORIGIN}/j/`
export const ATTACHMENT_FRAME_PATH = '/j/attachment-frame.html'
export const ATTACHMENT_FRAME_CSP = "default-src 'none'; script-src https://kithmoot.forgesworn.dev/j/attachment-frame.js; style-src https://kithmoot.forgesworn.dev/j/attachment-frame.css; img-src kithmoot-attachment:; media-src kithmoot-attachment:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'self'"
export const CSP = "default-src 'self'; script-src https://kithmoot.forgesworn.dev/j/ 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: mediastream:; connect-src 'self' wss: https:; worker-src https://kithmoot.forgesworn.dev/j/; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src https://kithmoot.forgesworn.dev/j/girnel/ https://kithmoot.forgesworn.dev/j/attachment-frame.html; frame-ancestors 'none'"
export function isAppUrl(value) {
  try { const u = new URL(value); return u.origin === ORIGIN && u.pathname === '/j/' && !u.username && !u.password }
  catch { return false }
}
/** Hosts whose /j/ join links the desktop app opens itself. */
const INVITATION_HOSTS = new Set(['kithmoot.forgesworn.dev', 'kithmoot.app'])
/**
 * The app address an invitation opens, or undefined for anything else.
 *
 * Accepts the `kithmoot://join` form the web join page and Android use, and
 * a web join link handed over on the command line. The room is in the
 * fragment, so a link without one is not an invitation. Query and fragment
 * are kept byte for byte; only the origin and path become the app's own.
 */
export function invitationTarget(value) {
  let u
  try { u = new URL(value) } catch { return undefined }
  if (u.username || u.password) return undefined
  const code = meetingCodeTarget(u)
  if (code) return code
  if (u.hash.length <= 1) return undefined
  const scheme = u.protocol === 'kithmoot:' && u.host === 'join' && (u.pathname === '' || u.pathname === '/')
  const web = u.protocol === 'https:' && INVITATION_HOSTS.has(u.host) && (u.pathname === '/j' || u.pathname === '/j/')
  return scheme || web ? `${HOME}${u.search}${u.hash}` : undefined
}
/** A meeting code's eight symbols (foregather base32-en-v1), plain or in
 *  triples, as docs/meeting-codes.md parses them. */
const MEETING_CODE = /^(?:[0-9A-HJKMNP-TV-Z]{8}|[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{2})$/i
const PASSWORD_WORDS = new Set(PASSWORD_WORD_LIST.split('\n'))
/**
 * The four words of a `#word-word-word-word` fragment, or undefined: exactly
 * four lowercase words from the frozen list, joined by single hyphens, as
 * the web app writes them (formatted and parsed in app/src/meeting-codes.ts,
 * "passwordFragment"). Nothing is corrected, decoded or matched loosely.
 */
function passwordWordsIn(hash) {
  const match = /^#([a-z]+(?:-[a-z]+){3})$/.exec(hash)
  return match && match[1].split('-').every(word => PASSWORD_WORDS.has(word)) ? match[1] : undefined
}
/**
 * `https://kithmoot.app/c/<code>` and `kithmoot://c/<code>` open the app's
 * join page with `?c=<code>`, which looks the code up and shows the door.
 * A code with a password may carry its words in the fragment
 * (`/c/<code>#<words>`, docs/meeting-codes.md): they go through as
 * `?c=<code>#<words>` so the page opens it without asking. Nothing else: no
 * other host, path or query, and no fragment that is not those words.
 */
function meetingCodeTarget(u) {
  if (u.search) return undefined
  const path = u.protocol === 'https:' && u.host === 'kithmoot.app' && u.pathname.startsWith('/c/') ? u.pathname.slice(3)
    : u.protocol === 'kithmoot:' && u.host === 'c' && u.pathname.startsWith('/') ? u.pathname.slice(1)
      : undefined
  if (path === undefined || !MEETING_CODE.test(path)) return undefined
  const words = u.hash ? passwordWordsIn(u.hash) : undefined
  if (u.hash && !words) return undefined
  return `${HOME}?c=${path.replaceAll('-', '').toUpperCase()}${words ? `#${words}` : ''}`
}
/**
 * What a `window.open` from inside the app may do.
 *
 * `'own-window'` is the app opening an empty window and writing into it
 * itself, which is how the share pop-out works: there is no address to hand
 * to a browser, and denying it left that button doing nothing in the packaged
 * app while it worked in a tab. Anything with an address is a link and leaves
 * for the person's browser; a blank window inherits this window's sandbox and
 * preload and can never be navigated to remote content.
 */
export function windowOpenAction(value) {
  return value === '' || value === 'about:blank' ? 'own-window' : 'external'
}
export function isExternalUrl(value) {
  try { const u = new URL(value); return ['https:', 'http:', 'mailto:'].includes(u.protocol) && !u.username && !u.password }
  catch { return false }
}
export function localAsset(value, root) {
  const u = new URL(value)
  if (u.origin !== ORIGIN || !u.pathname.startsWith('/j/')) return undefined
  let name
  try { name = decodeURIComponent(u.pathname.slice(3)) || 'index.html' } catch { return null }
  if (name.includes('\0') || name.includes('\\') || name.split('/').includes('..')) return null
  // Never permit a PWA worker to replace code shipped inside this app.
  if (/^(sw\.js|workbox-|registerSW)/.test(name)) return null
  const path = resolve(root, name)
  return path.startsWith(resolve(root) + sep) ? path : null
}
export const allowedPermissions = new Set(['media', 'display-capture', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'speaker-selection'])

/** Only the bundled board and attachment surfaces permit framing by the workspace. */
export function appContentPolicy(value) {
  const u = new URL(value)
  if (u.origin === ORIGIN && u.pathname === ATTACHMENT_FRAME_PATH && !u.username && !u.password) return ATTACHMENT_FRAME_CSP
  return u.origin === ORIGIN && u.pathname.startsWith('/j/girnel/') ? CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'") : CSP
}
