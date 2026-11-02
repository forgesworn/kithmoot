/** Opt-in journey for the task-owned, offline Debian systemd fixture.
 * Run only in the disposable container: this pairs its node and closes a room.
 * Uses normal HTTPS/WSS, certificate trust and hostname checks throughout. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { turnWire } from './node-turn-wire.mjs'
import { signNodeRoom, readNodeRoom } from '@forgesworn/fold-kit/node-room'
import { deriveRoom } from '../src/room.js'
import { localIdentity } from '../src/identity.js'
import { createDeviceCredential } from '../src/credential.js'
import { hostRoomEpoch } from '../src/epoch.js'
import { RoomSession } from '../src/session.js'
import { claimKithmootNode, enrolNodeRoom, nodeRoomTransport, nodeKeeperInbox, queryNodeAccess, queryNodeCloseOperation, nodeTurnCredentials } from '../src/kithmoot-node.js'
import { openNodeKeeperAdmissions, beginNodeJoin } from '../src/node-admission.js'
import { openNodeDeviceAccess } from '../src/node-device-access.js'
import { prepareNodeRoomClose, pendingNodeRoomClose, submitPendingNodeRoomClose } from '../src/node-room-close.js'

assert.equal(process.env.E2E_NODE_INSTALLED_FIXTURE, 'disposable-offline-systemd')
const origin = 'https://node.example', sdkCleanups = [], turnClients = [], sockets = []
class SdkSocket extends WebSocket {
  constructor(url) { super(url); sockets.push(this); this.on('message', data => { if (JSON.parse(String(data))[0] === 'EOSE') this.eosed = true }) }
  send(data, ...args) { const frame = JSON.parse(String(data)); if (frame[0] === 'AUTH') this.identity = frame[1]?.pubkey; return super.send(data, ...args) }
}
async function until(check, label) {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) { if (await check()) return; await delay(100) }
  throw Error('Timed out: ' + label)
}
const owner = generateSecretKey(), ownerIdentity = localIdentity(owner), options = {}
const info = await (await fetch(origin + '/node/v1/info')).json(), serviceKey = info.serviceKey
// Capture the one-use local pairing code without ever logging it.
const localPairScript = `const {connect}=require('node:net'); const s=connect('/var/lib/kithmoot-node/node.sock');s.on('connect',()=>s.end(JSON.stringify({op:'pair'})));s.on('data',d=>process.stdout.write(d));s.on('error',()=>process.exit(1));`
const link = JSON.parse(execFileSync('runuser', ['--user', 'kithmoot-node', '--', '/opt/kithmoot-node/current/runtime/bin/node', '-e', localPairScript], { encoding: 'utf8' })).result
const pair = await claimKithmootNode({ origin, ...link }, ownerIdentity)
assert.equal(pair.serviceKey, serviceKey)
try {
  const root = generateSecretKey(), keeperKey = generateSecretKey(), keeperDevice = generateSecretKey(), guestDevice = generateSecretKey()
  const keeperPerson = localIdentity(generateSecretKey()), guestPerson = localIdentity(generateSecretKey()), guestIdentity = localIdentity(guestDevice)
  const sdkRoom = deriveRoom(root).roomId, sdkNow = () => Math.floor(Date.now() / 1000)
  const node = readNodeRoom(signNodeRoom({ authoritySk: keeperKey, room: sdkRoom, serviceKey, origin, now: sdkNow() }), sdkNow())
  await enrolNodeRoom(pair, node, ownerIdentity, options)
  let journal
  const keeper = await openNodeKeeperAdmissions({ ...options, node, authoritySk: keeperKey, roomSecret: root, keeperParticipant: keeperPerson.pubkey,
    epochHint: () => 0, store: { load: async () => journal, save: async value => { journal = structuredClone(value) } } })
  sdkCleanups.push(() => keeper.close())
  const keeperCredential = await createDeviceCredential({ identity: keeperPerson, devicePubkey: getPublicKey(keeperDevice), roomId: sdkRoom, expiresAt: sdkNow() + 86400 })
  await keeper.authoriseKeeperDevice(keeperCredential)
  const keeperTransport = nodeRoomTransport(node, localIdentity(keeperDevice), 'room', { websocketImplementation: SdkSocket })
  sdkCleanups.push(() => keeperTransport.close())
  const keeperInbox = nodeKeeperInbox(node, localIdentity(keeperKey), { websocketImplementation: SdkSocket })
  sdkCleanups.push(() => keeperInbox.close())
  const rootKeys = deriveRoom(root)
  const epochDesk = hostRoomEpoch({ transport: keeperTransport, roomId: sdkRoom, authoritySk: keeperKey, roomKey: rootKeys.roomKey,
    current: () => ({ epoch: 0, secret: root }), removed: () => new Set(), members: () => [keeperPerson.pubkey, guestPerson.pubkey],
    replyDelayMs: [0, 0], expiresAt: () => sdkNow() + 30 * 86400 })
  sdkCleanups.push(() => { epochDesk.close(); rootKeys.roomKey.fill(0) })
  let admitted, admissionError, asksReady = false, asksSeen = 0
  const offAsks = keeperInbox.subscribe([{ kinds: [1059], '#p': [node.authority] }], event => {
    asksSeen++
    if (!keeper.inspect(event)) return
    void keeper.admit(event, true).then(answer => keeperInbox.publish(answer)).catch(error => { admissionError = error })
  }, () => { asksReady = true })
  sdkCleanups.push(offAsks)
  await until(() => asksReady, 'SDK keeper ask subscription authenticated')
  const guestCredential = await createDeviceCredential({ identity: guestPerson, devicePubkey: guestIdentity.pubkey, roomId: sdkRoom, expiresAt: sdkNow() + 86400 })
  const attempt = beginNodeJoin({ node, deviceSk: guestDevice, credential: guestCredential, signal: AbortSignal.timeout(12000), websocketImplementation: SdkSocket })
  sdkCleanups.push(() => attempt.cancel())
  try { admitted = await attempt.result }
  catch (error) { throw Error(`SDK join: ${error.reason}; keeper error=${admissionError?.reason ?? 'none'}; asks=${asksSeen}`) }
  assert.notEqual(admitted, 'denied'); assert.equal(admissionError, undefined)
  assert.deepEqual(admitted.secret, root)
  let deviceState
  const deviceAccess = await openNodeDeviceAccess(node, guestIdentity, admitted.grant,
    { load: async () => deviceState, save: async value => { deviceState = structuredClone(value) } }, options)
  sdkCleanups.push(() => deviceAccess.close()); await deviceAccess.refresh(); assert.equal(deviceAccess.allowed(), true)
  const guestTransport = nodeRoomTransport(node, guestIdentity, 'room', { websocketImplementation: SdkSocket, allowed: deviceAccess.allowed })
  sdkCleanups.push(() => guestTransport.close())
  let closedNotice
  const session = new RoomSession({ node, authority: node.authority, transport: guestTransport, identity: guestPerson, deviceSk: guestDevice,
    secret: admitted.secret, name: 'Guest', expectedEpoch: 0, requireFreshEpoch: true, announceJitterMs: 0, epochSettleMs: 0,
    onClosed: notice => { closedNotice = notice } })
  sdkCleanups.unshift(() => session.leave())
  await session.join([], {}); await session.chat.send('encrypted SDK fixture')
  assert.ok(session.chat.messages().some(message => message.text === 'encrypted SDK fixture'))
  const refused = spawnSync('/opt/kithmoot-node/current/kithmoot-node', ['uninstall', '--delete-everything'], { encoding: 'utf8' })
  assert.equal(refused.status, 1); assert.match(refused.stderr, /close|room/i)
  if (process.env.E2E_NODE_LIVE_UPDATE) {
    assert.match(process.env.E2E_NODE_LIVE_UPDATE, /^\/candidate-[0-9]+\/kithmoot-node$/)
    const oldSockets = new Set(sockets)
    const update = spawnSync(process.env.E2E_NODE_LIVE_UPDATE, ['update'], { encoding: 'utf8', timeout: 90000 })
    assert.equal(update.status, 0, update.stderr)
    await until(async () => { try { return (await queryNodeAccess(node, admitted.grant.tags.find(t => t[0] === 'grant')[1], guestIdentity)).state === 'active' } catch { return false } }, 'grant survives live update')
    await until(() => sockets.some(socket => !oldSockets.has(socket) && socket.readyState === WebSocket.OPEN && socket.identity === guestIdentity.pubkey && socket.eosed), 'guest relay subscription restored after update')
    await session.chat.send('encrypted chat after service update')
  }
  const access = await queryNodeAccess(node, admitted.grant.tags.find(t => t[0] === 'grant')[1], guestIdentity)
  assert.equal(access.state, 'active')
  const credentials = await nodeTurnCredentials(node, access, guestIdentity)
  assert.equal(credentials.urls.length, 4)
  for (const [protocol, port] of [['udp', 3478], ['tcp', 3478], ['tls', 5349], ['tls', 443]]) {
    const client = await turnWire({ protocol, port, host: '1.2.3.4', servername: 'turn.node.example', ca: readFileSync('/fixture/cert.pem') })
    turnClients.push(client); assert.equal((await client.authenticate(credentials)).type, 0x0103)
  }

  const resetFloor = keeper.close(), current = session.currentEpoch()
  let instruction
  try { instruction = prepareNodeRoomClose({ node, authoritySk: keeperKey, roomSecret: root, current, resetFloor, now: sdkNow(), drainSeconds: 1 }) }
  finally { current.secret.fill(0) }
  const pending = pendingNodeRoomClose(pair, node, instruction, sdkNow())
  let pendingStored, reference
  const closeStore = { stage: async value => { pendingStored = structuredClone(value); reference = structuredClone(value.reference) },
    forgetRoom: async value => { pendingStored = undefined; reference = structuredClone(value) } }
  const sdkClose = await submitPendingNodeRoomClose(pending, localIdentity(keeperKey), closeStore, options)
  assert.ok(['draining', 'done'].includes(sdkClose.phase)); assert.equal(pendingStored, undefined)
  await until(() => closedNotice?.destruct === true, 'SDK closing rekey delivered to guest')
  await until(async () => (await queryNodeCloseOperation(reference.node, reference.operation, ownerIdentity)).phase === 'done', 'installed purge and completion')
  await until(() => turnClients.filter((_, i) => i !== 0).every(client => client.closed), 'all revoked TURN streams closed')
  const refusedTurn = await turnWire({ protocol: 'tls', port: 443, host: '1.2.3.4', servername: 'turn.node.example', ca: readFileSync('/fixture/cert.pem') })
  turnClients.push(refusedTurn)
  assert.equal((await refusedTurn.authenticate(credentials)).type, 0x0113)
  keeperKey.fill(0); root.fill(0)
  const finished = await queryNodeCloseOperation(reference.node, reference.operation, ownerIdentity, options)
  assert.equal(finished.phase, 'done'); assert.equal(finished.receipt.callsRevoked, true); assert.equal(finished.receipt.relayPurged, true)
  assert.equal(JSON.stringify(reference).includes(sdkRoom), false)
  assert.equal((await queryNodeAccess(node, admitted.grant.tags.find(t => t[0] === 'grant')[1], guestIdentity, options)).state, 'closed')
  const counts = await (await fetch(origin + '/node/v1/status')).json()
  assert.equal(counts.rooms, 0); assert.equal(counts.devices, 0)
  console.log(JSON.stringify({ schema: 'kithmoot-node-installed/1', result: 'passed', isolatedLinux: true,
    ownerPairing: true, manualAdmission: true, freshRoot: true, encryptedChat: true, activeUninstallRefused: true, liveUpdate: Boolean(process.env.E2E_NODE_LIVE_UPDATE),
    authenticatedTurn: ['udp3478', 'tcp3478', 'tls5349', 'tls443'], cachedAccessRevoked: true,
    closeDelivered: true, callsRevoked: finished.receipt.callsRevoked, relayPurged: finished.receipt.relayPurged,
    signedCompletion: true, coldPublicProof: true, counts }))

} finally {
  for (const client of turnClients) client.close()
  for (const cleanup of sdkCleanups.reverse()) { try { await cleanup() } catch {} }
  for (const socket of sockets) socket.terminate()
  owner.fill(0)
}
