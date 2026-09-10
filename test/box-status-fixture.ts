import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { base32, base64, base64urlnopad } from '@scure/base'
import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex } from '@noble/hashes/utils'
import { buildLinkCard, buildCard, cardLink } from 'nostr-contact-card'

/** Deterministic keys for protocol tests only. */
export function boxFixture(now = 1_800_000_000) {
const boxKey = new Uint8Array(32).fill(1), masterKey = new Uint8Array(32).fill(2)
const nodeKey = new Uint8Array(32).fill(3), stashKey = new Uint8Array(32).fill(4)
const p = getPublicKey(boxKey), master = getPublicKey(masterKey)
const node = ed25519.getPublicKey(nodeKey)
const card = buildLinkCard({ nodeSecret: nodeKey, issuedAt: now - 60, expiresAt: now + 86400, serial: 8, relays: ['wss://transport.example'] })
const claim = finalizeEvent({ kind: 30640, created_at: now - 100, content: '', tags: [
  ['d', p], ['p', p, '', 'node'], ['p', master, '', 'master'],
  ['p', getPublicKey(stashKey), '', 'stash'], ['role', 'box'], ['status', 'active'],
] }, masterKey)
const pin = { p, claim: claim.id, nodeId: bytesToHex(node), highestSerial: 7 }
const tags = [
  ['card', base64.encode(card)], ['card-exp', String(now + 86400)],
  ['node', base32.encode(node).replace(/=+$/, '').toLowerCase()], ['claim', claim.id],
  ['free', '1073741824'], ['pool', '2147483648'], ['max-blob', '1048576'],
  ['classes', 'working', 'circle'], ['charge-control', 'mains'],
  ['sheltered', '1073741824', '100'], ['policy', 'introductions'],
  ['drops', 'on', 'wss://owned.example/drops'], ['carriers', 'link', 'tor'],
  ['software', 'bothy/0.1.1', 'a'.repeat(40)], ['relaying', 'off'],
  ['retention', 'blobs=until-unpinned', 'drops=86400', 'logs=none'],
]
const status = (changed = tags, created_at = now) => finalizeEvent({ kind: 10640, created_at, content: '', tags: changed }, boxKey)
const withTag = (name: string, values: string[]) => tags.map(t => t[0] === name ? [name, ...values] : t)

const contactCard = cardLink('https://kithmoot.test/j/', buildCard({
  identityPrivateKey: masterKey, rz: getPublicKey(new Uint8Array(32).fill(5)),
  ephemeralPrivateKey: new Uint8Array(32).fill(6), name: 'Rowan', relays: [],
  boxes: [{ p, claim: claim.id, card: base64urlnopad.encode(card) }], now: () => now,
}))
return { now, boxKey, masterKey, nodeKey, stashKey, p, master, node, card, claim, pin, tags, status, withTag, contactCard }
}
