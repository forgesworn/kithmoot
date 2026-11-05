import { base64urlnopad } from '@scure/base'
import { randomBytes } from '@noble/hashes/utils'
import { readNodeRoom, readNodeTurnPorts, recoverNodeClosure, readNodeCloseReceipt, readNodeOperationReceipt, verifyNodeRoomGrant,
  type NodeRoomRecord, type NodeCloseReceipt, type NodeTurnPorts } from '@forgesworn/fold-kit/node-room'
import type { Event } from 'nostr-tools/pure'
import type { ParticipantIdentity, UnsignedEvent } from './identity.js'
import { verifyEventUncached } from './verify.js'
import { parseGroupEvent, type GroupEvent, type ParsedGrant, type ParsedReset } from './group-grants.js'
import { spryHash, type SpryCredential, type SpryOffer } from './spry.js'
import { NostrRelayPool, type RelayTransport, type RelayPoolClient } from './relay-pool.js'
import type { PeerContext, PeerFactory, RTCPeerConnectionLike } from './peer.js'

export class KithmootNodeError extends Error {
  constructor(readonly status: number, readonly reason: 'unavailable' | 'refused' | 'invalid' | 'expired') {
    super(reason === 'unavailable' ? 'Your KithMoot node cannot be reached.' : reason === 'expired' ? 'Your access to this node has expired.' : reason === 'refused' ? 'Your KithMoot node refused this request.' : 'Your KithMoot node returned invalid information.')
  }
}
export interface NodeClientOptions { fetcher?: typeof fetch; now?: () => number; signal?: AbortSignal; allowed?: () => boolean }
export interface NodeRelayOptions { websocketImplementation?: typeof WebSocket; now?: () => number; allowed?: () => boolean }
export interface PairedKithmootNode { v: 1; origin: string; serviceKey: string; owner: string; turnPorts?: NodeTurnPorts }
export interface NodeOwnerStatus {
  v: 1; version: string; ready: boolean; paired: boolean; rooms: number; devices: number; pending: number
  turnReady: boolean; relayReady: boolean; storeBytes?: number
}
export type NodeClosePhase = 'publishing' | 'draining' | 'teardown' | 'erasing' | 'done'
export interface NodeCloseInstruction { operation: string; deadline: number; reset: GroupEvent; closure: Event; events: Event[] }
export interface NodeCloseStatus { phase: NodeClosePhase; receipt?: NodeCloseReceipt }
export interface NodePairingLink { origin: string; code: string; expiresAt: number }
export type NodeDeviceAccess =
  | { state: 'active'; grant: ParsedGrant; offer: SpryOffer }
  | { state: 'removed'; grant: ParsedGrant }
  | { state: 'reset'; reset: ParsedReset }
  | { state: 'closed'; closure: Event }
  | { state: 'ended' }
const KEY = /^[a-f0-9]{64}$/
const paths = new Set(['/node/v1/claim', '/node/v1/enrol', '/groups/v1/events', '/node/v1/access', '/node/v1/close', '/node/v1/operation', '/node/v1/status', '/v1/credentials'])
function invalid(): never { throw new KithmootNodeError(0, 'invalid') }
function nodeOrigin(raw: unknown): string {
  if (typeof raw !== 'string') return invalid()
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.origin !== raw || url.port || !url.hostname.includes('.') || /^[0-9.]+$/.test(url.hostname)
    || /\.(localhost|local|internal|home|invalid)$/.test(url.hostname)) return invalid()
  return url.origin
}
function pinned(node: NodeRoomRecord, now: number): NodeRoomRecord {
  const value = readNodeRoom(node.event, Math.min(now, node.endsAt === undefined ? now : node.endsAt - 1), node.authority)
  return value ?? invalid()
}
async function body(response: Response, limit = 65536): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) return invalid()
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > limit) return invalid(); chunks.push(value) }
  } finally { await reader.cancel().catch(() => {}) }
  const bytes = new Uint8Array(length); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!result || typeof result !== 'object' || Array.isArray(result)) return invalid()
  return result as Record<string, unknown>
}
/** Exact signed request to one pinned HTTPS origin. Never sends cookies,
 * follows redirects, or tries another service after refusal. */
async function request(origin: string, path: string, value: unknown, identity: ParticipantIdentity, options: NodeClientOptions = {}): Promise<Record<string, unknown>> {
  if (options.signal?.aborted || options.allowed?.() === false) throw new KithmootNodeError(403, 'refused')
  if (!paths.has(path) || !KEY.test(identity.pubkey)) return invalid()
  const url = nodeOrigin(origin) + path, content = JSON.stringify(value), now = (options.now ?? (() => Math.floor(Date.now() / 1000)))()
  const unsigned: UnsignedEvent = { kind: 27235, created_at: now, content: '', tags: [['u', url], ['method', 'POST'], ['payload', spryHash(content)], ['nonce', base64urlnopad.encode(randomBytes(32))]] }
  const expected = JSON.stringify(unsigned)
  let signed: Event
  try { signed = await identity.signEvent(unsigned) }
  catch { throw new KithmootNodeError(403, 'refused') }
  if (!signed || typeof signed !== 'object') return invalid()
  const template: UnsignedEvent = JSON.parse(expected)
  const signedAt = (options.now ?? (() => Math.floor(Date.now() / 1000)))()
  const proof: Event = { ...template, created_at: signed.created_at, pubkey: signed.pubkey, id: signed.id, sig: signed.sig }
  if (signed.pubkey !== identity.pubkey || signed.kind !== template.kind || !Number.isSafeInteger(signed.created_at) || signed.created_at < signedAt - 60 || signed.created_at > signedAt + 30 || signed.content !== ''
    || JSON.stringify(signed.tags) !== JSON.stringify(template.tags) || !verifyEventUncached(proof)) return invalid()
  if (options.signal?.aborted || options.allowed?.() === false) throw new KithmootNodeError(403, 'refused')
  let status = 0
  try {
    const response = await (options.fetcher ?? fetch)(url, { method: 'POST', body: content,
      headers: { 'Content-Type': 'application/json', Authorization: `Nostr ${btoa(JSON.stringify(proof))}` },
      credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000) })
    status = response.status
    if (!response.ok) throw new KithmootNodeError(status, status === 408 || status === 425 || status === 429 || status >= 500 ? 'unavailable' : 'refused')
    return await body(response)
  } catch (error) { if (error instanceof KithmootNodeError) throw error; throw new KithmootNodeError(status, status ? 'invalid' : 'unavailable') }
}
export function parseKithmootNodePairingLink(fragment: string, now = Math.floor(Date.now() / 1000)): NodePairingLink {
  try {
    if (!fragment.startsWith('#kithmoot-node=') || fragment.length > 2048) return invalid()
    const raw = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(fragment.slice(15))))
    if (Object.keys(raw).length !== 4 || raw.v !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(raw.code) || !Number.isSafeInteger(raw.expiresAt)
      || raw.expiresAt <= now || raw.expiresAt > now + 360) throw new KithmootNodeError(0, 'expired')
    return { origin: nodeOrigin(raw.node), code: raw.code, expiresAt: raw.expiresAt }
  } catch (error) { if (error instanceof KithmootNodeError) throw error; return invalid() }
}
export async function claimKithmootNode(link: NodePairingLink, owner: ParticipantIdentity, options: NodeClientOptions = {}): Promise<PairedKithmootNode> {
  if (options.signal?.aborted || options.allowed?.() === false) throw new KithmootNodeError(403, 'refused')
  const now = (options.now ?? (() => Math.floor(Date.now() / 1000)))()
  if (link.expiresAt <= now || link.expiresAt > now + 360 || !/^[A-Za-z0-9_-]{43}$/.test(link.code)) throw new KithmootNodeError(0, 'expired')
  const origin = nodeOrigin(link.origin)
  let info: Record<string, unknown>
  try {
    const response = await (options.fetcher ?? fetch)(origin + '/node/v1/info', { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000) })
    if (!response.ok) throw new KithmootNodeError(response.status, 'refused')
    info = await body(response)
  } catch (error) { if (error instanceof KithmootNodeError) throw error; throw new KithmootNodeError(0, 'unavailable') }
  if (info.v !== 1 || info.profile !== 'kithmoot-node/1' || info.origin !== origin || typeof info.serviceKey !== 'string' || !KEY.test(info.serviceKey)
    || info.serviceKey === owner.pubkey || info.relay !== `wss://${new URL(origin).host}/events` || info.calls !== 'relay-only' || info.files !== 'off') return invalid()
  const ports = readNodeTurnPorts(info.turnPorts)
  if (!ports) return invalid()
  const result = await request(origin, '/node/v1/claim', { code: link.code }, owner, options)
  if (result.paired !== true) return invalid()
  return { v: 1, origin, serviceKey: info.serviceKey, owner: owner.pubkey, ...(ports.udpTcp === 3478 && ports.tls === 5349 ? {} : { turnPorts: ports }) }
}
export async function enrolNodeRoom(pair: PairedKithmootNode, record: NodeRoomRecord, owner: ParticipantIdentity, options: NodeClientOptions = {}): Promise<void> {
  const node = pinned(record, (options.now ?? (() => Math.floor(Date.now() / 1000)))())
  const pairedPorts = readNodeTurnPorts(pair.turnPorts), roomPorts = readNodeTurnPorts(node.turnPorts)
  if (pair.owner !== owner.pubkey || pair.origin !== node.origin || pair.serviceKey !== node.serviceKey || !pairedPorts || !roomPorts
    || pairedPorts.udpTcp !== roomPorts.udpTcp || pairedPorts.tls !== roomPorts.tls) return invalid()
  const result = await request(node.origin, '/node/v1/enrol', { room: node.room, authority: node.authority, inviter: node.authority, ...(node.endsAt === undefined ? {} : { ends: node.endsAt }) }, owner, options)
  if (result.enrolled !== true) return invalid()
}
export async function queryKithmootNodeStatus(pair: PairedKithmootNode, owner: ParticipantIdentity, options: NodeClientOptions = {}): Promise<NodeOwnerStatus> {
  if (pair.v !== 1 || pair.owner !== owner.pubkey || !KEY.test(pair.serviceKey) || pair.serviceKey === owner.pubkey) return invalid()
  const value = await request(pair.origin, '/node/v1/status', {}, owner, options)
  if (value.v !== 1 || value.serviceKey !== pair.serviceKey || typeof value.version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(value.version)
    || ['ready', 'paired', 'turnReady', 'relayReady'].some(k => typeof value[k] !== 'boolean')
    || ['rooms', 'devices', 'pending'].some(k => !Number.isSafeInteger(value[k]) || Number(value[k]) < 0)
    || value.storeBytes !== undefined && (!Number.isSafeInteger(value.storeBytes) || Number(value.storeBytes) < 0)) return invalid()
  return { v: 1, version: value.version, ready: value.ready as boolean, paired: value.paired as boolean, rooms: Number(value.rooms),
    devices: Number(value.devices), pending: Number(value.pending), turnReady: value.turnReady as boolean, relayReady: value.relayReady as boolean,
    ...(value.storeBytes === undefined ? {} : { storeBytes: Number(value.storeBytes) }) }
}
export async function postNodeGrant(record: NodeRoomRecord, event: GroupEvent, authority: ParticipantIdentity, options: NodeClientOptions = {}): Promise<void> {
  const now = (options.now ?? (() => Math.floor(Date.now() / 1000)))(), node = pinned(record, now)
  const parsed = parseGroupEvent(event, { now, keepers: [node.authority], servers: [new URL(node.origin).hostname] })
  if (!parsed.ok || parsed.parsed.roomId !== node.room || event.pubkey !== authority.pubkey) return invalid()
  if (parsed.parsed.type === 'grant' && parsed.parsed.scopes.some(s => !['turn', 'relay-read', 'relay-write'].includes(s))) return invalid()
  const result = await request(node.origin, '/groups/v1/events', event, authority, options)
  if (result.accepted !== true) return invalid()
}
export async function queryNodeAccess(record: NodeRoomRecord, grantId: string, device: ParticipantIdentity, options: NodeClientOptions = {}): Promise<NodeDeviceAccess> {
  const now = (options.now ?? (() => Math.floor(Date.now() / 1000)))(), node = pinned(record, now)
  if (node.endsAt !== undefined && node.endsAt <= now) return { state: 'ended' }
  if (!/^[a-f0-9]{32}$/.test(grantId)) return invalid()
  const value = await request(node.origin, '/node/v1/access', { room: node.room, grant: grantId }, device, options)
  if (value.state === 'closed') {
    const closure = recoverNodeClosure(value.proof, node, now)
    return closure ? { state: 'closed', closure } : invalid()
  }
  const parsed = parseGroupEvent(value.event, { now, keepers: [node.authority], servers: [new URL(node.origin).hostname] })
  if (!parsed.ok || parsed.parsed.roomId !== node.room) return invalid()
  const grant = parsed.parsed
  if (value.state === 'reset' && grant.type === 'reset') return { state: 'reset', reset: grant }
  if (grant.type !== 'grant' || grant.device !== device.pubkey || grant.grantId !== grantId) return invalid()
  if (value.state === 'removed' && grant.status === 'revoked') return { state: 'removed', grant }
  const offer = value.offer as Partial<SpryOffer> | undefined
  if (value.state !== 'active' || !verifyNodeRoomGrant(value.event, node, device.pubkey, now) || !offer || offer.v !== 1 || offer.endpoint !== node.origin
    || typeof offer.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(offer.token) || !Number.isSafeInteger(offer.expiresAt)
    || offer.expiresAt! <= now || offer.expiresAt! > now + 30 * 86400 + 30) return invalid()
  return { state: 'active', grant, offer: { v: 1, endpoint: node.origin, token: offer.token, expiresAt: offer.expiresAt! } }
}
/** Four TURN URLs are accepted only for the keeper-signed node record.
 * Existing Spry issuers retain their independent URL rules. */
export async function nodeTurnCredentials(record: NodeRoomRecord, access: Extract<NodeDeviceAccess, { state: 'active' }>, device: ParticipantIdentity, options: NodeClientOptions = {}): Promise<SpryCredential> {
  const now = (options.now ?? (() => Math.floor(Date.now() / 1000)))(), node = pinned(record, now)
  if (!verifyNodeRoomGrant(access.grant.event, node, device.pubkey, now) || access.offer.endpoint !== node.origin || access.offer.expiresAt <= now) return invalid()
  const value = await request(node.origin, '/v1/credentials', { grant: access.offer.token }, device, options)
  const receivedAt = (options.now ?? (() => Math.floor(Date.now() / 1000)))()
  // Authenticated issuance time accommodates small clock differences without
  // extending the server's five-minute lifetime. Missing timestamps keep the
  // older strict local-clock bound; managed peers also have a monotonic cap.
  const issuedAt = value.issuedAt
  if (issuedAt !== undefined && (!Number.isSafeInteger(issuedAt) || Number(issuedAt) > receivedAt + 30 || Number(issuedAt) < receivedAt - 300
    || Number(value.expiresAt) <= Number(issuedAt) || Number(value.expiresAt) > Number(issuedAt) + 300)) return invalid()
  if (!Array.isArray(value.urls) || !value.urls.length || value.urls.length > 4 || new Set(value.urls).size !== value.urls.length || value.urls.some(url => !node.turnUrls.includes(url))
    || typeof value.username !== 'string' || !/^[0-9]{1,12}:[a-f0-9]{24}$/.test(value.username) || typeof value.credential !== 'string' || !/^[A-Za-z0-9+/]{27}=$/.test(value.credential)
    || !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= receivedAt || issuedAt === undefined && Number(value.expiresAt) > receivedAt + 300
    || Number(value.username.split(':')[0]) !== value.expiresAt || !Number.isSafeInteger(value.accessExpiresAt) || Number(value.accessExpiresAt) < Number(value.expiresAt)
    || Number(value.accessExpiresAt) > Math.min(access.grant.expiration, node.endsAt ?? Infinity)) return invalid()
  return { urls: value.urls as string[], username: value.username, credential: value.credential, expiresAt: Number(value.expiresAt), accessExpiresAt: Number(value.accessExpiresAt) }
}
export async function closeNodeRoom(record: NodeRoomRecord, instruction: NodeCloseInstruction, authority: ParticipantIdentity,
  options: NodeClientOptions = {}): Promise<NodeCloseStatus> {
  const now = (options.now ?? (() => Math.floor(Date.now() / 1000)))(), node = pinned(record, now)
  if (authority.pubkey !== node.authority) return invalid()
  const result = await request(node.origin, '/node/v1/close', { room: node.room, ...instruction }, authority, options)
  if (result.operation !== instruction.operation || !['publishing', 'draining', 'teardown', 'erasing', 'done'].includes(String(result.phase))) return invalid()
  if (result.phase !== 'done') return { phase: result.phase as NodeClosePhase }
  const receipt = readNodeCloseReceipt((result.result as Record<string, unknown>)?.receipt, node, instruction.operation, now)
  return receipt ? { phase: 'done', receipt } : invalid()
}
/** Owner-only status polling after the room and its authority key have been
 * deleted. No room id, descriptor or member grant is sent or retained. */
export async function queryNodeCloseOperation(pair: PairedKithmootNode, operation: string, owner: ParticipantIdentity, options: NodeClientOptions = {}): Promise<NodeCloseStatus> {
  if (pair.v !== 1 || pair.owner !== owner.pubkey || !KEY.test(pair.serviceKey) || pair.serviceKey === owner.pubkey || !/^[a-f0-9]{32}$/.test(operation)) return invalid()
  const result = await request(pair.origin, '/node/v1/operation', { operation }, owner, options)
  if (result.operation !== operation || !['publishing', 'draining', 'teardown', 'erasing', 'done'].includes(String(result.phase))) return invalid()
  if (result.phase !== 'done') return { phase: result.phase as NodeClosePhase }
  const receipt = readNodeOperationReceipt((result.result as Record<string, unknown>)?.receipt, pair.serviceKey, operation,
    (options.now ?? (() => Math.floor(Date.now() / 1000)))())
  return receipt ? { phase: 'done', receipt } : invalid()
}
const transports = new WeakMap<RelayTransport, string>()
const factories = new WeakMap<PeerFactory, string>()
export function assertNodeRoomTransport(transport: RelayTransport, node: NodeRoomRecord, device: string): void {
  if (transports.get(transport) !== `${node.event.id}:${device}`) throw new Error('A node room needs its pinned, authenticated relay transport.')
}
export function assertNodeCallFactory(factory: PeerFactory, node: NodeRoomRecord, device: string): void {
  if (factories.get(factory) !== `${node.event.id}:${device}`) throw new Error('A node room needs its relay-only call factory.')
}
/** One partition and one signing identity. There is no account-relay merge,
 * peer relay, public discovery, alternate issuer or shared socket fallback. */
export function nodeRoomTransport(record: NodeRoomRecord, identity: ParticipantIdentity, mode: 'room' | 'ask', options: NodeRelayOptions = {}): RelayPoolClient {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000)), node = pinned(record, now())
  if (mode === 'room' && [node.authority, node.serviceKey].includes(identity.pubkey)) return invalid()
  let closed = false
  const allowed = () => !closed && (node.endsAt === undefined || node.endsAt > now()) && (options.allowed?.() ?? true)
  if (!allowed() || !['room', 'ask'].includes(mode)) throw new KithmootNodeError(403, 'refused')
  const pool = new NostrRelayPool([node.relay], undefined, { websocketImplementation: options.websocketImplementation,
    authentication: [{ url: node.relay, identity, node: { room: node.room, mode } }], sendGuard: allowed, probeQuietMs: 5000 })
  const checkEvent = (event: Event): void => {
      if (!allowed() || [27541, 27542, 27543, 27544].includes(event.kind)) throw new KithmootNodeError(403, 'refused')
      const expiration = event.tags.filter(t => t[0] === 'expiration')
      if (expiration.length !== 1 || expiration[0]!.length !== 2 || !/^[1-9][0-9]*$/.test(expiration[0]![1]!)
        || Number(expiration[0]![1]) <= now() || Number(expiration[0]![1]) > Math.min(now() + 30 * 86400, node.endsAt ?? Infinity)
        || mode === 'ask' && event.kind !== 1059) return invalid()
  }
  const transport: RelayPoolClient = {
    async publish(event) { checkEvent(event); await pool.publish(event) },
    async publishGuarded(event, current, settings) {
      checkEvent(event)
      await pool.publishGuarded(event, () => allowed() && current(), settings)
    },
    subscribe(filters, onEvent, onEose) {
      if (!allowed()) throw new KithmootNodeError(403, 'refused')
      return pool.subscribe(filters, (event, via) => { if (allowed()) onEvent(event, via) }, () => { if (allowed()) onEose?.() })
    },
    close() { closed = true; pool.close() },
    describe: () => [{ url: node.relay, read: true, write: true }],
    configuration: () => [{ url: node.relay, read: true, write: true }],
    health: () => pool.health(),
    get closed() { return closed },
    get publishing() { return pool.publishing },
    settled: timeout => pool.settled(timeout),
    publishEvidence: id => pool.publishEvidence(id),
    askBack: id => { if (allowed()) pool.askBack(id) },
    // HTTP reachability cannot detect a half-open signalling stream. Probe
    // this authenticated socket inside its pinned room partition.
    probe: async () => { if (!allowed()) throw new KithmootNodeError(403, 'refused'); await pool.probe() },
    reconnect: () => { if (allowed()) pool.reconnect() },
    setAuthentication: () => { throw new Error('This room uses its pinned device authentication.') },
    async query(url, filters, timeout, maxEvents) {
      if (!allowed() || url !== node.relay) throw new KithmootNodeError(403, 'refused')
      return pool.query(url, filters, timeout, maxEvents)
    },
    async publishQuietly(url, event) {
      if (url !== node.relay) throw new KithmootNodeError(403, 'refused')
      checkEvent(event); await pool.publishQuietly(url, event)
    },
    setRelays(entries) {
      if (entries.length !== 1 || (typeof entries[0] === 'string' ? entries[0] : entries[0]?.url) !== node.relay
        || typeof entries[0] !== 'string' && (entries[0]?.read !== true || entries[0]?.write !== true)) throw new Error('This room uses its KithMoot node relay.')
    },
  }
  if (mode === 'room') transports.set(transport, `${node.event.id}:${identity.pubkey}`)
  return transport
}

/** The inviter's separate, restricted ask inbox. Room-device grants confer
 * no access to this namespace; the keeper signs its own scoped NIP-42 proof.
 * This transport cannot be used as a RoomSession's admitted room door. */
export function nodeKeeperInbox(record: NodeRoomRecord, authority: ParticipantIdentity, options: NodeRelayOptions = {}): RelayPoolClient {
  const node = pinned(record, (options.now ?? (() => Math.floor(Date.now() / 1000)))())
  if (authority.pubkey !== node.authority) return invalid()
  return nodeRoomTransport(node, authority, 'ask', options)
}

/** Relay-only browser connections with fresh TURN credentials before the old
 * username expires. A failed refresh never changes the transport policy. */
export async function nodeCallFactory(record: NodeRoomRecord, device: ParticipantIdentity, access: () => Promise<NodeDeviceAccess>, options: NodeClientOptions & {
  PeerConnection?: typeof RTCPeerConnection; onUnavailable?: (error: KithmootNodeError) => void; monotonic?: () => number
  /** Reopen signalling before a connectivity restart: its old socket may
   * still appear open while sending offers into the previous route. */
  onRecovering?: () => void
  /** Rebuild through the signalling owner after installing fresh credentials.
   * Native ICE restarts can retain an allocation tied to the old username.
   * A context limits connectivity recovery to that participant; no context
   * rotates all peers. Return false to use native recovery. */
  rebuildPeers?: (context?: PeerContext) => boolean
  /** Register the native connection with the embedding's media receivers
   * without wrapping and losing the pinned node factory's identity. */
  onPeer?: (peer: RTCPeerConnection, context?: PeerContext) => void
} = {}): Promise<{ factory: PeerFactory; reconnect(): Promise<void>; close(): void }> {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000)), node = pinned(record, now())
  const Base = options.PeerConnection ?? globalThis.RTCPeerConnection
  if (!Base) throw new KithmootNodeError(0, 'unavailable')
  const peers = new Set<RTCPeerConnection>(), retiring = new WeakSet<RTCPeerConnection>(), controller = new AbortController()
  const contexts = new WeakMap<RTCPeerConnection, PeerContext | undefined>()
  const pendingRestarts = new Map<RTCPeerConnection, () => void>()
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, expiryTimer: ReturnType<typeof setTimeout> | undefined, retryTimer: ReturnType<typeof setTimeout> | undefined
  const monotonic = options.monotonic ?? (() => performance.now())
  let deadline = Infinity, credentialDeadline = Infinity, rotationAt = Infinity
  let credential: SpryCredential
  let renewing: Promise<void> | undefined
  let restartRequested = false
  let rotateAll = false
  const pendingPeers = new Map<RTCPeerConnection, PeerContext | undefined>()
  const allowed = () => !stopped && !options.signal?.aborted && (options.allowed?.() ?? true)
  const requestOptions = { ...options, allowed, signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal }
  // Gather all media slots on one transport. Parallel replacement generations
  // otherwise compete with old-route leases for the node's TURN quotas.
  const configuration = (): RTCConfiguration => ({ bundlePolicy: 'max-bundle', iceTransportPolicy: 'relay', iceServers: [{ urls: [...credential.urls], username: credential.username, credential: credential.credential }] })
  const close = () => {
    if (stopped) return; stopped = true; controller.abort(); clearTimeout(timer); clearTimeout(expiryTimer); clearTimeout(retryTimer)
    options.signal?.removeEventListener('abort', close)
    for (const peer of peers) peer.close()
    peers.clear(); pendingPeers.clear(); pendingRestarts.clear()
  }
  const obtain = async (): Promise<SpryCredential> => {
    const value = await access()
    if (!allowed() || value.state !== 'active') throw new KithmootNodeError(403, 'refused')
    return nodeTurnCredentials(node, value, device, requestOptions)
  }
  const notify = (error: KithmootNodeError) => { try { options.onUnavailable?.(error) } catch {} }
  const remaining = () => Math.min(credential.expiresAt - now(), (credentialDeadline - monotonic()) / 1000, (deadline - monotonic()) / 1000)
  const expire = (): void => {
    if (!allowed()) { close(); return }
    if (remaining() <= 0) { notify(new KithmootNodeError(0, 'expired')); close(); return }
    expiryTimer = setTimeout(expire, Math.max(1, remaining() * 1000))
  }
  const install = (next: SpryCredential, all: boolean): void => {
    const nextDeadline = monotonic() + Math.min(300, next.expiresAt - now()) * 1000
    credentialDeadline = credential?.username === next.username ? Math.min(credentialDeadline, nextDeadline) : nextDeadline
    // Other peers may still use an older login. A single-pair repair cannot
    // move their expiry or their scheduled rotation into the future.
    deadline = all ? credentialDeadline : Math.min(deadline, credentialDeadline)
    credential = next; clearTimeout(expiryTimer)
    expiryTimer = setTimeout(expire, Math.max(1, remaining() * 1000))
  }
  const schedule = (seconds: number) => {
    clearTimeout(timer); const delay = Math.max(1000, seconds * 1000)
    rotationAt = monotonic() + delay
    timer = setTimeout(() => { rotationAt = Infinity; void renew() }, delay)
  }
  const repair = (peer: RTCPeerConnection): void => {
    if (peer.signalingState === 'closed') { peers.delete(peer); return }
    if (retiring.has(peer)) { pendingRestarts.delete(peer); return }
    const restart = pendingRestarts.get(peer)
    pendingRestarts.delete(peer)
    try { peer.setConfiguration(configuration()); if (restart) restart(); else peer.restartIce() } catch { peer.close(); peers.delete(peer) }
  }
  const runRenewal = async (): Promise<void> => {
    if (!allowed()) { close(); return }
    if (remaining() <= 0) { expire(); return }
    try {
      const next = await obtain()
      if (!allowed() || remaining() <= 0) { close(); return }
      const all = rotateAll || remaining() <= 60
      install(next, all)
      if (all) {
        if (!options.rebuildPeers?.()) for (const peer of peers) repair(peer)
        pendingPeers.clear(); pendingRestarts.clear(); rotateAll = false
      } else {
        for (const [peer, context] of pendingPeers) {
          if (!peers.has(peer) || retiring.has(peer) || peer.signalingState === 'closed') { pendingPeers.delete(peer); pendingRestarts.delete(peer); continue }
          if (!options.rebuildPeers?.(context)) repair(peer)
          pendingPeers.delete(peer); pendingRestarts.delete(peer)
        }
      }
      // A grant near its own end cannot extend this username. Give the
      // keeper a chance to renew at the end without a per-second mint loop.
      const left = remaining()
      const delay = left <= 60 ? left : left - 60
      if (all || monotonic() + delay * 1000 < rotationAt) schedule(delay)
    } catch (error) {
      if (!allowed()) { close(); return }
      const failure = error instanceof KithmootNodeError ? error : new KithmootNodeError(0, 'unavailable')
      notify(failure)
      if (failure.reason === 'refused') close()
      else if (remaining() <= 0) expire()
      else {
        clearTimeout(retryTimer)
        retryTimer = setTimeout(() => { void startRenewal() }, Math.max(1, Math.min(5, remaining()) * 1000))
      }
    }
  }
  const startRenewal = (): Promise<void> => {
    if (renewing) return renewing
    clearTimeout(retryTimer)
    const pending = runRenewal().finally(() => { if (renewing === pending) { renewing = undefined; restartRequested = false } })
    renewing = pending
    return pending
  }
  const renew = (restart = false, peer?: RTCPeerConnection, context?: PeerContext): Promise<void> => {
    if (peer && (!options.rebuildPeers || context)) pendingPeers.set(peer, context)
    else rotateAll = true
    if (restart && !restartRequested && allowed()) {
      restartRequested = true
      try { options.onRecovering?.() } catch { /* An observer cannot prevent credential recovery. */ }
    }
    return startRenewal()
  }
  install(await obtain(), true)
  if (!allowed()) { close(); throw new KithmootNodeError(403, 'refused') }
  schedule(remaining() <= 60 ? remaining() : remaining() - 60)
  options.signal?.addEventListener('abort', close, { once: true })
  const factory: PeerFactory = context => {
      if (!allowed() || remaining() <= 0) { close(); throw new KithmootNodeError(0, 'expired') }
      const peer = new Base(configuration()), end = peer.close.bind(peer)
      let connected = false, recovering = false
      peer.close = () => { peers.delete(peer); pendingRestarts.delete(peer); end() }
      contexts.set(peer, context)
      peer.addEventListener?.('connectionstatechange', () => {
        if (retiring.has(peer)) return
        // Either endpoint can lose its route. Repair this pair without
        // interrupting another participant's healthy audio and video.
        if (peer.connectionState === 'connected') { connected = true; recovering = false }
        else if (connected && !recovering && (peer.connectionState === 'disconnected' || peer.connectionState === 'failed')) {
          recovering = true; void renew(true, peer, context)
        }
      })
      // Native RTCTrackEvent includes every field Peer reads. Its DOM
      // callback type is narrower than the portable adapter declaration.
      peers.add(peer)
      try { options.onPeer?.(peer, context) } catch (error) { peer.close(); throw error }
      return peer as unknown as RTCPeerConnectionLike
    }
  factory.onRetiring = value => {
    const peer = value as unknown as RTCPeerConnection
    if (peers.has(peer)) { retiring.add(peer); pendingRestarts.delete(peer) }
  }
  factory.onIceRestart = (value, restart) => {
    const peer = value as unknown as RTCPeerConnection
    if (!peers.has(peer) || retiring.has(peer) || peer.signalingState === 'closed') return
    // Peer/SlotPeer also observes the failure. Its native restart and offer
    // must wait for the same refresh as the node's listener, rather than
    // gathering another allocation with the old login in parallel.
    pendingRestarts.set(peer, restart)
    void renew(true, peer, contexts.get(peer))
  }
  factories.set(factory, `${node.event.id}:${device.pubkey}`)
  return {
    factory,
    reconnect: () => renew(true),
    close,
  }
}
