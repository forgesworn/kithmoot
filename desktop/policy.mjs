import { resolve, sep } from 'node:path'
export const ORIGIN = 'https://kithmoot.forgesworn.dev'
export const HOME = `${ORIGIN}/j/`
export const CSP = "default-src 'self'; script-src https://kithmoot.forgesworn.dev/j/ 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: mediastream:; connect-src 'self' wss: https:; worker-src https://kithmoot.forgesworn.dev/j/; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'"
export function isAppUrl(value) {
  try { const u = new URL(value); return u.origin === ORIGIN && u.pathname === '/j/' && !u.username && !u.password }
  catch { return false }
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
