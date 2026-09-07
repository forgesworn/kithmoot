// Run after building this checkout and the immutable previous-release checkout.
// Uses synthetic room keys, a local NIP-01 relay and real ICE/DTLS/SRTP sockets.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils'
import { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader } from 'werift'
import { Peer } from '../dist/src/peer.js'
import { wrapSignal, unwrapSignal } from '../dist/src/signal.js'
import { deriveRoom } from '../dist/src/room.js'
import { NostrRelayPool } from '../dist/src/relay-pool.js'
import { deriveMediaKey, encryptFrame, decryptFrame, frameIv, SALT_LENGTH } from '../dist/src/media-crypto.js'

const baseline = process.env.M2_BASELINE_DIR
if (!baseline) throw new Error('Set M2_BASELINE_DIR to a built previous release')
const revision = execFileSync('git', ['-C', baseline, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const previous = path => import(pathToFileURL(join(baseline, path)).href)
const oldSignal = await previous('dist/src/signal.js')
const oldForwarder = await previous('server/forwarder.mjs')
const Forwarder = process.env.M2_CURRENT_FORWARDER === '1' ? await import('../server/forwarder.mjs') : oldForwarder
const ClientPeer = process.env.M2_PREVIOUS_CLIENT === '1' ? (await previous('dist/src/peer.js')).Peer : Peer
const clientSignal = process.env.M2_PREVIOUS_CLIENT === '1' ? oldSignal : { wrapSignal, unwrapSignal }
const room = deriveRoom(generateSecretKey())
const sender = generateSecretKey(), recipient = generateSecretKey()
const body = { type: 'offer', roomId: room.roomId, sdp: 'synthetic SDP' }
for (const [writer, reader] of [[wrapSignal, oldSignal.unwrapSignal], [oldSignal.wrapSignal, unwrapSignal]]) {
  assert.deepEqual(reader(writer(body, { senderSk: sender, recipientPubkey: getPublicKey(recipient) }), { recipientSk: recipient, roomId: room.roomId }), { from: getPublicKey(sender), body })
}

const relay = spawn(process.execPath, ['test/ws-relay.mjs'], { env: { ...process.env, RELAY_PORT: '7779' }, stdio: ['ignore', 'pipe', 'inherit'] })
await Promise.race([once(relay.stdout, 'data'), once(relay, 'exit').then(() => { throw new Error('Fixture relay exited') })])
const relayUrl = 'ws://127.0.0.1:7779'
const forwarderSk = generateSecretKey()
const config = Forwarder.roomConfigs(Forwarder.loadConfigFromEnv({ KITHMOOT_ROOM_ID: room.roomId, KITHMOOT_FORWARDER_SK: bytesToHex(forwarderSk), NOSTR_RELAYS: relayUrl }))[0]
const serverTransport = new NostrRelayPool([relayUrl])
const realStack = await Forwarder.createWeriftStack()
// LAN acceptance needs no public STUN service; the previous forwarding stack
// and signalling implementation otherwise run unchanged.
const stack = { createConnection() { const host = realStack.createConnection(); host.connection.setConfiguration({ iceServers: [] }); return host } }
const forwarder = Forwarder.createForwarder({ config, transport: serverTransport, stack, log: () => {} })
const clients = [], errors = []
let pump
async function until(predicate, timeout = 30_000) {
  const end = Date.now() + timeout
  while (!predicate()) {
    if (errors.length) throw errors[0]
    if (Date.now() > end) throw new Error('Previous-forwarder acceptance timed out')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
try {
  forwarder.start()
  await until(() => serverTransport.health()[0].state === 'connected')
  for (let i = 0; i < 2; i++) {
    const sk = generateSecretKey(), device = getPublicKey(sk)
    const transport = new NostrRelayPool([relayUrl])
    const connection = new RTCPeerConnection({ iceServers: [] })
    const track = new MediaStreamTrack({ kind: 'video', id: 'synthetic-' + i })
    const received = []
    const peer = new ClientPeer({ factory: () => connection, localDevice: device, remoteDevice: config.pubkey, mustOfferFirst: true,
      onSignal: signal => { void transport.publish(clientSignal.wrapSignal({ ...signal, roomId: room.roomId }, { senderSk: sk, recipientPubkey: config.pubkey })).catch(e => errors.push(e)) },
      onTrack: incoming => incoming.onReceiveRtp.subscribe(packet => received.push(new Uint8Array(packet.payload))),
    })
    clients.push({ transport, connection, peer, track, device, received })
    await new Promise(resolve => transport.subscribe([{ kinds: [21059], '#p': [device] }], event => {
      const signal = clientSignal.unwrapSignal(event, { recipientSk: sk, roomId: room.roomId })
      if (signal?.from === config.pubkey) void peer.handleSignal(signal.body).catch(e => errors.push(e))
    }, resolve))
    await peer.start([track])
    await until(() => connection.connectionState === 'connected')
  }
  console.log(JSON.stringify({ phase: 'first offer and ICE/DTLS', result: 'passed', baseline: revision, currentForwarder: process.env.M2_CURRENT_FORWARDER === '1', previousClient: process.env.M2_PREVIOUS_CLIENT === '1' }))
  const plaintext = clients.map((_, i) => new Uint8Array([0x10, 0x02, 0x00, 20 + i, 40, 60, 80]))
  const sealed = clients.map((client, i) => encryptFrame(plaintext[i], deriveMediaKey(room.roomKey, client.device), frameIv(new Uint8Array(SALT_LENGTH).fill(i + 1), 0), 3))
  let sequence = 0
  pump = setInterval(() => clients.forEach((client, i) => client.track.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 96, sequenceNumber: ++sequence, timestamp: sequence * 3000, ssrc: 4242 + i }), Buffer.from(sealed[i])))), 40)
  await until(() => clients.every(c => c.received.length > 0))
  for (let i = 0; i < 2; i++) assert.deepEqual(decryptFrame(clients[i].received[0], deriveMediaKey(room.roomKey, clients[1 - i].device)), plaintext[1 - i])
  assert.equal(forwarder.stats().peers, 2)
  assert.equal(forwarder.stats().relayed, 2)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ baseline: revision, bidirectionalSignal: 'passed', forwardedEncryptedMedia: 'passed', currentForwarder: process.env.M2_CURRENT_FORWARDER === '1', previousClient: process.env.M2_PREVIOUS_CLIENT === '1', relay: 'local NIP-01', clients: 2, admissionPolicy: 'none' }))
} finally {
  clearInterval(pump)
  for (const client of clients) { client.peer.close(); client.transport.close(); await client.connection.close() }
  forwarder.close(); serverTransport.close(); relay.kill('SIGTERM')
}
