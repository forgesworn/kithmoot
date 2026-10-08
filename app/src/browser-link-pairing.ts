import { base64, base64urlnopad, base32nopad } from '@scure/base'
import { hexToBytes } from '@noble/hashes/utils'
import type { LinkPairing } from './browser-link-types.js'

/** A pairing code is a short-lived capability. Never include input in errors,
 * logs, URLs, or persisted settings. Rust verifies the signed card at pairing. */
export function readLinkPairing(uri: string, now = Math.floor(Date.now() / 1000)): LinkPairing {
  try {
    if (!uri.startsWith('bothy:') || uri.length > 10_000) throw new Error()
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64urlnopad.decode(uri.slice(6))))
    if (value.v !== 2 || !/^[0-9a-f]{64}$/.test(value.bothy) || !/^[0-9a-f]{32}$/.test(value.secret) ||
      !['phone', 'box'].includes(value.role) || typeof value.name !== 'string' || value.name.length > 256 ||
      !Number.isSafeInteger(value.exp) || value.exp <= now || value.exp > now + 600 || typeof value.card !== 'string') throw new Error()
    const card = base64.decode(value.card)
    if (card.length < 126 || card.length > 4096) throw new Error()
    return { routeId: crypto.randomUUID(), serverCard: card, pairingSecret: hexToBytes(value.secret), expiresAt: value.exp }
  } catch { throw new Error('Use a current Bothy pairing code (version 2, valid for at most ten minutes).') }
}

/** Call only with a card returned by the verifying engine. This is a virtual
 * authority; it must never be handed to the browser's native WebSocket. */
export function linkEventUrl(card: Uint8Array): string {
  if (card.length < 126 || card.length > 4096 || new TextDecoder().decode(card.subarray(0, 4)) !== 'FSL1' || card[4] !== 1) throw new Error('Invalid Link card.')
  return `ws://${base32nopad.encode(card.subarray(5, 37)).toLowerCase()}/events`
}

export function linkRelays(urls: readonly string[]): string[] {
  if (urls.length < 1 || urls.length > 16) throw new Error('Choose between one and sixteen Link relays.')
  return [...new Set(urls.map(text => {
    const url = new URL(text)
    if (text.length > 2048 || url.protocol !== 'wss:' || url.username || url.password || url.hash) throw new Error('Link relays must use wss:// without credentials or fragments.')
    return url.href
  }))]
}
