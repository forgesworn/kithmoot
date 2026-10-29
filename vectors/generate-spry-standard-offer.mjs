// Public synthetic conformance data only. How a guest decides whether another
// member's `spry:` offer is a standard-profile node it may redeem (a built-in
// relay), and which TURN URLs such a node may answer with: docs/protocol.md,
// "Spry offers". `src/` is NOT imported; every card is signed by hand from
// spry-turn docs/supervised-mode.md with fixed keys and zero BIP-340
// auxiliary randomness, so the file reproduces byte for byte.
//
//   node vectors/generate-spry-standard-offer.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { getEventHash, getPublicKey } from 'nostr-tools/pure'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

const now = 1_700_000_000
// The node key is the repeated byte 1, as in spry-turn's own vectors.
const nodeSk = new Uint8Array(32).fill(1)
const strangerSk = new Uint8Array(32).fill(3)
const node = getPublicKey(nodeSk)
const auxiliary = new Uint8Array(32)
const relay = encodeURIComponent('wss://relay.example/')
const endpoint = `spry://${node}?relay=${relay}`
const CANONICAL = '{"profile":"spry-standard-v1","v":1}'

function sign(template, key = nodeSk) {
  const event = { kind: 24183, created_at: now, tags: [['expiration', String(now + 600)]], content: CANONICAL, ...template, pubkey: getPublicKey(key) }
  const id = getEventHash(event)
  return { ...event, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), key, auxiliary)) }
}

// spry-turn tests/vectors/spry-link.json, copied byte for byte beside this file.
const rust = JSON.parse(readFileSync(new URL('./spry-link.json', import.meta.url), 'utf8'))
const standard = sign({})
if (standard.id !== rust.standardNode.id || standard.sig !== rust.standardNode.sig) {
  throw new Error('the hand-signed standard card no longer matches spry-turn\'s standardNode vector')
}
const tampered = { ...standard, content: '{"profile":"spry-standard-v1","v":2}' }

/** `standard`: what a standard-card verifier answers; `peer`: what the
 *  private-mesh (`spry-peer-v1`) verifier answers. Never both. */
const cards = [
  { name: 'spry-turn standardNode vector', now, event: rust.standardNode, standard: true, peer: false },
  { name: 'spry-turn peer node vector', now, event: rust.node, standard: false, peer: true },
  { name: 'keys in the other order', now, event: sign({ content: '{"v":1,"profile":"spry-standard-v1"}' }), standard: true, peer: false },
  { name: 'one second before expiry', now: now + 599, event: standard, standard: true, peer: false },
  { name: 'signed 60 seconds ahead', now: now - 60, event: standard, standard: true, peer: false },
  { name: 'signed 61 seconds ahead', now: now - 61, event: standard, standard: false, peer: false },
  { name: 'expired', now: now + 600, event: standard, standard: false, peer: false },
  { name: 'expiry more than 600 seconds after signing', now, event: sign({ tags: [['expiration', String(now + 601)]] }), standard: false, peer: false },
  { name: 'expiry not a whole number', now, event: sign({ tags: [['expiration', `${now + 600}.0`]] }), standard: false, peer: false },
  { name: 'a second tag', now, event: sign({ tags: [['expiration', String(now + 600)], ['p', node]] }), standard: false, peer: false },
  { name: 'no expiration tag', now, event: sign({ tags: [['p', node]] }), standard: false, peer: false },
  { name: 'expiration tag with a third element', now, event: sign({ tags: [['expiration', String(now + 600), 'x']] }), standard: false, peer: false },
  { name: 'an address in the content', now, event: sign({ content: '{"address":"[fd12:3456::2]:3745","profile":"spry-standard-v1","v":1}' }), standard: false, peer: false },
  { name: 'version 2', now, event: sign({ content: '{"profile":"spry-standard-v1","v":2}' }), standard: false, peer: false },
  { name: 'version written 1.0', now, event: sign({ content: '{"profile":"spry-standard-v1","v":1.0}' }), standard: false, peer: false },
  { name: 'whitespace in the content', now, event: sign({ content: '{"profile": "spry-standard-v1", "v": 1}' }), standard: false, peer: false },
  { name: 'duplicate key', now, event: sign({ content: '{"profile":"spry-standard-v1","v":1,"v":1}' }), standard: false, peer: false },
  { name: 'peer profile without an address', now, event: sign({ content: '{"profile":"spry-peer-v1","v":1}' }), standard: false, peer: false },
  { name: 'kind 24182', now, event: sign({ kind: 24182 }), standard: false, peer: false },
  { name: 'content changed after signing', now, event: tampered, standard: false, peer: false },
]

/** Whether a guest treats another member's offer as a standard node it may
 *  redeem: a `spry:` endpoint whose card is standard and signed by the
 *  endpoint's own key. The card's expiry is checked when the offer is read
 *  (`now`); a stored offer keeps its card. */
const offers = [
  { name: 'standard card signed by the endpoint key', offer: { endpoint, node: standard }, standard: true },
  { name: 'standard card signed by another key', offer: { endpoint, node: sign({}, strangerSk) }, standard: false },
  { name: 'peer card (a private node)', offer: { endpoint, node: rust.node }, standard: false },
  { name: 'no card', offer: { endpoint }, standard: false },
  { name: 'standard card on an https: offer', offer: { endpoint: 'https://relay.example', node: standard }, standard: false },
  { name: 'control relay on a local name with a trailing dot', offer: { endpoint: `spry://${node}?relay=${encodeURIComponent('wss://localhost./')}`, node: standard }, standard: false },
  { name: 'control relay that is an IP literal', offer: { endpoint: `spry://${node}?relay=${encodeURIComponent('wss://127.0.0.1/')}`, node: standard }, standard: false },
  { name: 'control relay over ws:', offer: { endpoint: `spry://${node}?relay=${encodeURIComponent('ws://relay.example/')}`, node: standard }, standard: false },
]

const ip = '1.2.3.4'
const url = (host, port, transport = 'udp', scheme = 'turn') => `${scheme}:${host}:${port}?transport=${transport}`
/** The TURN URLs a standard node may give a guest. */
const urls = [
  ['UDP and TCP on different ports', [url(ip, 51000), url(ip, 51001, 'tcp')], true],
  ['UDP only', [url(ip, 51000)], true],
  ['TCP only', [url(ip, 51001, 'tcp')], true],
  ['UDP and TCP on one port', [url(ip, 3478), url(ip, 3478, 'tcp')], true],
  ['lowest port', [url(ip, 1024)], true],
  ['highest port', [url(ip, 65535)], true],
  ['just outside carrier-grade NAT, below', [url('100.63.255.255', 51000)], true],
  ['just outside carrier-grade NAT, above', [url('100.128.0.1', 51000)], true],
  ['just outside 172.16/12, below', [url('172.15.255.255', 51000)], true],
  ['just outside 172.16/12, above', [url('172.32.0.1', 51000)], true],
  ['just outside benchmarking, below', [url('198.17.255.255', 51000)], true],
  ['just outside benchmarking, above', [url('198.20.0.1', 51000)], true],
  ['192.0.1.1', [url('192.0.1.1', 51000)], true],
  ['223.255.255.254', [url('223.255.255.254', 51000)], true],
  ['empty list', [], false],
  ['three URLs', [url(ip, 51000), url(ip, 51001, 'tcp'), url(ip, 51002)], false],
  ['the same URL twice', [url(ip, 51000), url(ip, 51000)], false],
  ['two addresses', [url(ip, 51000), url('1.2.3.5', 51001, 'tcp')], false],
  ['turns:', [url(ip, 5349, 'tcp', 'turns')], false],
  ['stun:', [`stun:${ip}:3478`], false],
  ['upper-case scheme', [`TURN:${ip}:51000?transport=udp`], false],
  ['no transport', [`turn:${ip}:51000`], false],
  ['transport tls', [url(ip, 51000, 'tls')], false],
  ['extra query', [`turn:${ip}:51000?transport=udp&x=1`], false],
  ['credentials in the URL', [`turn:user@${ip}:51000?transport=udp`], false],
  ['a name', [url('relay.example', 51000)], false],
  ['IPv6', [url('[2001:4860::1]', 51000)], false],
  ['port 1023', [url(ip, 1023)], false],
  ['port 65536', [url(ip, 65536)], false],
  ['port with a leading zero', [url(ip, '05100')], false],
  ['no port', [`turn:${ip}?transport=udp`], false],
  ['octet with a leading zero', [url('1.2.3.04', 51000)], false],
  ['octet 256', [url('1.2.3.256', 51000)], false],
  ['three octets', [url('1.2.3', 51000)], false],
  ['0.0.0.0/8', [url('0.1.2.3', 51000)], false],
  ['10/8', [url('10.1.2.3', 51000)], false],
  ['100.64/10, start', [url('100.64.0.1', 51000)], false],
  ['100.64/10, end', [url('100.127.255.254', 51000)], false],
  ['127/8', [url('127.0.0.1', 51000)], false],
  ['169.254/16', [url('169.254.1.2', 51000)], false],
  ['172.16/12, start', [url('172.16.0.1', 51000)], false],
  ['172.16/12, end', [url('172.31.255.254', 51000)], false],
  ['192.0.0/24', [url('192.0.0.9', 51000)], false],
  ['192.0.2/24 (documentation)', [url('192.0.2.1', 51000)], false],
  ['192.168/16', [url('192.168.1.1', 51000)], false],
  ['198.18/15 (benchmarking)', [url('198.18.0.1', 51000)], false],
  ['198.19.x (benchmarking)', [url('198.19.255.1', 51000)], false],
  ['198.51.100/24 (documentation)', [url('198.51.100.1', 51000)], false],
  ['203.0.113/24 (documentation)', [url('203.0.113.1', 51000)], false],
  ['224/4 (multicast)', [url('224.0.0.1', 51000)], false],
  ['240/4 (reserved)', [url('240.0.0.1', 51000)], false],
  ['broadcast', [url('255.255.255.255', 51000)], false],
  ['one private among two', [url(ip, 51000), url('10.0.0.1', 51001, 'tcp')], false],
].map(([name, list, accept]) => ({ name, urls: list, accept }))

const out = {
  schema: 1, synthetic: true,
  description: 'Another member\'s spry: offer: the spry-standard-v1 card a guest requires, the offer marker, and the TURN URL rule for a standard node\'s credential answer.',
  nodeKeyRepeatedByte: 1, strangerKeyRepeatedByte: 3, endpoint,
  cards, offers, urls,
}
writeFileSync(new URL('./spry-standard-offer-v1.json', import.meta.url), JSON.stringify(out, null, 2) + '\n')
