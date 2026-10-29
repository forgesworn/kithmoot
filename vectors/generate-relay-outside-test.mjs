// Public synthetic conformance data only. The relay outside test
// (docs/protocol.md, "Relay outside test"): which request and result bodies a
// reader accepts, the verdict a tester sends for what its two peers saw, what
// a host may say about that verdict, and whole signal wraps carrying each
// message. `src/` is NOT imported: every wrap is assembled by hand from the
// signalling envelope in docs/protocol.md ("Call signalling profile 1") with
// fixed keys, zero BIP-340 auxiliary randomness and fixed NIP-44 nonces, so
// the file reproduces byte for byte.
//
//   node vectors/generate-relay-outside-test.mjs
import { writeFileSync } from 'node:fs'
import { getEventHash, getPublicKey } from 'nostr-tools/pure'
import { nip44 } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

const now = 1_800_000_000
const roomId = 'a1'.repeat(32)
// The node key is the repeated byte 1, as in spry-standard-offer-v1.json.
const node = getPublicKey(new Uint8Array(32).fill(1))
const endpoint = `spry://${node}?relay=${encodeURIComponent('wss://relay.example/')}`
const hostSk = new Uint8Array(32).fill(5)
const testerSk = new Uint8Array(32).fill(6)
const strangerSk = new Uint8Array(32).fill(7)
const host = getPublicKey(hostSk), tester = getPublicKey(testerSk), stranger = getPublicKey(strangerSk)
const auxiliary = new Uint8Array(32)
const id = '0123456789abcdef'

function sign(event, key) {
  const full = { ...event, pubkey: getPublicKey(key) }
  const eventId = getEventHash(full)
  return { ...full, id: eventId, sig: bytesToHex(schnorr.sign(hexToBytes(eventId), key, auxiliary)) }
}

/** A signal wrap exactly as docs/protocol.md describes it: kind 20462 signed
 *  by the sending device, NIP-44 to the recipient under a one-time key, kind
 *  21059 tagged only `p` and `expiration` 60 seconds after the inner time. */
function wrap(body, senderSk, recipient, { seed, createdAt = now, innerRecipient = recipient } = {}) {
  const inner = sign({ kind: 20462, created_at: createdAt,
    tags: [['p', innerRecipient], ['call-id', roomId], ['alt', 'KithMoot call signalling'], ['kithmoot', '1']],
    content: JSON.stringify(body) }, senderSk)
  const ephemeral = new Uint8Array(32).fill(seed)
  const nonce = new Uint8Array(32).fill(seed + 100)
  const content = nip44.v2.encrypt(JSON.stringify(inner), nip44.v2.utils.getConversationKey(ephemeral, recipient), nonce)
  return sign({ kind: 21059, created_at: createdAt, tags: [['p', recipient], ['expiration', String(createdAt + 60)]], content }, ephemeral)
}

const request = { id, endpoint }
const requests = [
  ['id and endpoint', request, true],
  ['keys in the other order', { endpoint, id }, true],
  ['upper-case id', { id: id.toUpperCase(), endpoint }, false],
  ['15-character id', { id: id.slice(1), endpoint }, false],
  ['17-character id', { id: id + '0', endpoint }, false],
  ['https endpoint', { id, endpoint: 'https://relay.example' }, false],
  ['endpoint with an ws: control relay', { id, endpoint: `spry://${node}?relay=${encodeURIComponent('ws://relay.example/')}` }, false],
  ['an address', { id, endpoint, address: '203.0.113.9' }, false],
  ['an ok field', { id, endpoint, ok: true }, false],
  ['no id', { endpoint }, false],
  ['no endpoint', { id }, false],
  ['id a number', { id: 1234, endpoint }, false],
].map(([name, relayTest, accept]) => ({ name, relayTest, accept }))

const result = (fields) => ({ id, endpoint, ...fields })
const results = [
  ['pass', result({ ok: true }), true],
  ['pass from the host\'s network', result({ ok: true, sameNetwork: true }), true],
  ...['declined', 'credentials', 'allocate', 'stun', 'inbound'].map(stage => [`failed at ${stage}`, result({ ok: false, stage }), true]),
  ['failed inbound from the host\'s network', result({ ok: false, stage: 'inbound', sameNetwork: true }), true],
  ['failed allocate from the host\'s network', result({ ok: false, stage: 'allocate', sameNetwork: true }), true],
  ['pass with a stage', result({ ok: true, stage: 'inbound' }), false],
  ['failure with no stage', result({ ok: false }), false],
  ['unknown stage', result({ ok: false, stage: 'firewall' }), false],
  ['stage in capitals', result({ ok: false, stage: 'INBOUND' }), false],
  ['sameNetwork false', result({ ok: true, sameNetwork: false }), false],
  ['sameNetwork on declined', result({ ok: false, stage: 'declined', sameNetwork: true }), false],
  ['sameNetwork on credentials', result({ ok: false, stage: 'credentials', sameNetwork: true }), false],
  ['ok as a string', result({ ok: 'true' }), false],
  ['ok as 1', result({ ok: 1 }), false],
  ['an address', result({ ok: true, address: '198.51.100.7' }), false],
  ['a time', result({ ok: true, at: now }), false],
  ['no endpoint', { id, ok: true }, false],
  ['no ok', { id, endpoint }, false],
].map(([name, relayTest, accept]) => ({ name, relayTest, accept }))

const relayIp = '203.0.113.9'
const seen = (fields) => ({ turnHost: relayIp, relayed: true, reflexive: ['198.51.100.7'], hosts: ['192.168.1.20', 'a1b2c3d4-0000-4000-8000-000000000000.local'], local: '192.168.1.20', echoed: true, pathA: true, pathB: true, ...fields })
/** `verdict`: what the tester sends; `finding`: what the host may say. */
const verdicts = [
  ['echo over both paths', seen({}), { ok: true }, 'reachable'],
  ['no local address known', seen({ local: undefined }), { ok: true }, 'reachable'],
  ['outside address is the relay\'s', seen({ reflexive: [relayIp] }), { ok: true, sameNetwork: true }, 'same-network'],
  ['one of two outside addresses is the relay\'s', seen({ reflexive: ['198.51.100.7', relayIp] }), { ok: true, sameNetwork: true }, 'same-network'],
  ['selected local address is the relay\'s', seen({ reflexive: [], local: relayIp }), { ok: true, sameNetwork: true }, 'same-network'],
  ['no echo', seen({ echoed: false, pathA: false, pathB: false }), { ok: false, stage: 'inbound' }, 'unreachable'],
  ['echo but A path not relayed', seen({ pathA: false }), { ok: false, stage: 'inbound' }, 'unreachable'],
  ['echo but B path relayed', seen({ pathB: false }), { ok: false, stage: 'inbound' }, 'unreachable'],
  ['no relayed address', seen({ relayed: false, echoed: false, pathA: false, pathB: false }), { ok: false, stage: 'allocate' }, 'unreachable'],
  ['no relayed address and no outside address', seen({ relayed: false, reflexive: [], echoed: false, pathA: false, pathB: false }), { ok: false, stage: 'allocate' }, 'unreachable'],
  ['no outside address', seen({ reflexive: [], local: undefined, echoed: false, pathA: false, pathB: false }), { ok: false, stage: 'stun' }, 'unreachable'],
  ['no outside address, a host address is the relay\'s (the relay\'s own machine)', seen({ reflexive: [], hosts: ['192.168.1.20', relayIp], local: undefined, echoed: false, pathA: false, pathB: false }), { ok: false, stage: 'inbound', sameNetwork: true }, 'same-network'],
  ['echo with a host address that is the relay\'s', seen({ hosts: [relayIp] }), { ok: true, sameNetwork: true }, 'same-network'],
  ['no outside address, local is the relay\'s', seen({ reflexive: [], local: relayIp, echoed: false, pathA: false, pathB: false }), { ok: false, stage: 'inbound', sameNetwork: true }, 'same-network'],
  ['no relayed address from the host\'s network', seen({ relayed: false, reflexive: [relayIp], echoed: false, pathA: false, pathB: false }), { ok: false, stage: 'allocate', sameNetwork: true }, 'same-network'],
].map(([name, observations, verdict, finding]) => ({ name, observations: JSON.parse(JSON.stringify(observations)), verdict, finding }))
const notRun = [
  { name: 'declined', result: { ok: false, stage: 'declined' }, finding: 'not-run' },
  { name: 'credentials', result: { ok: false, stage: 'credentials' }, finding: 'not-run' },
]

const requestBody = { type: 'relay-test', roomId, relayTest: request }
const resultBody = { type: 'relay-test-result', roomId, relayTest: result({ ok: true, sameNetwork: true }) }
/** Whole wraps. `recipientKeyRepeatedByte` opens it; `expect` is the
 *  unwrapped `{ from, createdAt, body }`, or null for a refusal. */
const wraps = [
  { name: 'host asks the tester', recipientKeyRepeatedByte: 6, now, event: wrap(requestBody, hostSk, tester, { seed: 11 }),
    expect: { from: host, createdAt: now, body: requestBody } },
  { name: 'tester answers the host', recipientKeyRepeatedByte: 5, now: now + 12, event: wrap(resultBody, testerSk, host, { seed: 12, createdAt: now + 12 }),
    expect: { from: tester, createdAt: now + 12, body: resultBody } },
  { name: 'a request carrying a result', recipientKeyRepeatedByte: 6, now, event: wrap({ ...requestBody, relayTest: result({ ok: true }) }, hostSk, tester, { seed: 13 }), expect: null },
  { name: 'a result with an unknown stage', recipientKeyRepeatedByte: 5, now, event: wrap({ ...resultBody, relayTest: result({ ok: false, stage: 'firewall' }) }, testerSk, host, { seed: 14 }), expect: null },
  { name: 'a result naming an address', recipientKeyRepeatedByte: 5, now, event: wrap({ ...resultBody, relayTest: result({ ok: true, address: '198.51.100.7' }) }, testerSk, host, { seed: 15 }), expect: null },
  { name: 'a request with no relayTest', recipientKeyRepeatedByte: 6, now, event: wrap({ type: 'relay-test', roomId }, hostSk, tester, { seed: 16 }), expect: null },
  { name: 'wrapped to the tester but addressed inside to a stranger', recipientKeyRepeatedByte: 6, now, event: wrap(requestBody, hostSk, tester, { seed: 17, innerRecipient: stranger }), expect: null },
  { name: 'another room', recipientKeyRepeatedByte: 6, now, event: wrap({ ...requestBody, roomId: 'b2'.repeat(32) }, hostSk, tester, { seed: 18 }), expect: null },
  { name: 'signed 21 seconds before the reader\'s clock', recipientKeyRepeatedByte: 6, now: now + 21, event: wrap(requestBody, hostSk, tester, { seed: 19 }), expect: null },
]

const out = {
  schema: 1, synthetic: true,
  description: 'Relay outside test: the relay-test request and relay-test-result bodies on the call signalling envelope, the tester\'s verdict from what its two peers saw, what a host may say about a result, and whole signal wraps.',
  roomId, endpoint, nodeKeyRepeatedByte: 1, hostDeviceKeyRepeatedByte: 5, testerDeviceKeyRepeatedByte: 6, strangerDeviceKeyRepeatedByte: 7,
  stages: ['declined', 'credentials', 'allocate', 'stun', 'inbound'],
  requests, results, verdicts, notRun, wraps,
}
writeFileSync(new URL('./relay-outside-test-v1.json', import.meta.url), JSON.stringify(out, null, 2) + '\n')
console.log(`wrote ${requests.length} requests, ${results.length} results, ${verdicts.length + notRun.length} findings, ${wraps.length} wraps`)
