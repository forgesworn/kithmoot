import { randomBytes } from '@noble/hashes/utils'
import { getPublicKey, type Event } from 'nostr-tools/pure'
import { decodeNodeJoinRequest, encodeNodeJoinAnswer, encodeNodeJoinRequest, decodeNodeJoinAnswer, readNodeRoom, verifyNodeRoomGrant,
  type NodeJoinRequest, type NodeRoomRecord, type NodeRoomAdmission } from '@forgesworn/fold-kit/node-room'
import { verifyDeviceCredential } from './credential.js'
import { deriveRoom } from './room.js'
import { localIdentity } from './identity.js'
import { buildGrant, buildRevocation, GRANT_LIFETIME_SECONDS, GRANT_RENEW_WITHIN_SECONDS, newGrantId, nextCreatedAt,
  parseGroupEvent, type GroupEvent, type ParsedGrant } from './group-grants.js'
import { KithmootNodeError, postNodeGrant, nodeRoomTransport, type NodeClientOptions } from './kithmoot-node.js'

interface DeviceGrant { participant: string; credential: Event; event: GroupEvent; posted: boolean }
export interface NodeKeeperSnapshot { v: 1; descriptor: string; members: string[]; removed: string[]; grants: DeviceGrant[] }
export interface NodeKeeperStore { load(): Promise<NodeKeeperSnapshot | undefined>; save(snapshot: NodeKeeperSnapshot): Promise<void> }
export interface NodeKeeperAdmissions {
  inspect(request: unknown): { request: NodeJoinRequest; known: boolean } | null
  /** Unknown people require the keeper's explicit Let them in action. */
  admit(request: unknown, approveUnknown?: true): Promise<Event>
  deny(request: unknown): Event
  authoriseKeeperDevice(credential: Event): Promise<GroupEvent>
  /** Existing-room migration only: the embedding must attest current admitted
   * membership from the source session, not from a self-signed credential. */
  authoriseExistingDevice(credential: Event): Promise<GroupEvent>
  remove(participant: string): Promise<void>
  /** Remember participants the room already counts as members, so this
   * keeper, and a later one reading the same journal, lets their devices in
   * without asking. A removed participant is never learned. */
  learnMembers(participants: readonly string[]): Promise<void>
  /** Replays committed grants/revocations after a lost acknowledgement. */
  retry(): Promise<void>
  /** Renews signed grants with ten days left while this keeper is open. */
  renew(): Promise<void>
  /** Stops admission and clears held private keys. The returned signed
   * second is the minimum reset floor for a whole-room close. */
  close(): number
}
const KEY = /^[a-f0-9]{64}$/
const MAX_DEVICES = 5, MAX_RECORDS = 4096

export interface NodeJoinAttempt {
  requestId: string
  expiresAt: number
  result: Promise<NodeRoomAdmission | 'denied'>
  cancel(): void
}
/** A link opens only the ask door. The guest already has a local device key
 * and a signed room credential; there is no code or server address to type. */
export function beginNodeJoin(opts: { node: NodeRoomRecord; deviceSk: Uint8Array; credential: Event; name?: string;
  now?: () => number; allowed?: () => boolean; signal?: AbortSignal; websocketImplementation?: typeof WebSocket }): NodeJoinAttempt {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  if (opts.signal?.aborted || opts.allowed?.() === false) throw new KithmootNodeError(403, 'refused')
  const request = encodeNodeJoinRequest({ ...opts, now: now() })
  let finished = false, off = () => {}, timer: ReturnType<typeof setTimeout> | undefined
  const transport = nodeRoomTransport(opts.node, localIdentity(opts.deviceSk), 'ask', { ...opts, now,
    allowed: () => !finished && request.expiresAt > now() && (opts.allowed?.() ?? true) })
  let resolve!: (value: NodeRoomAdmission | 'denied') => void, reject!: (error: KithmootNodeError) => void
  const result = new Promise<NodeRoomAdmission | 'denied'>((yes, no) => { resolve = yes; reject = no })
  const finish = (value?: NodeRoomAdmission | 'denied', error?: KithmootNodeError) => {
    if (finished) return
    finished = true; clearTimeout(timer); off(); transport.close(); opts.signal?.removeEventListener('abort', cancel)
    if (error) reject(error); else resolve(value!)
  }
  const cancel = () => finish(undefined, new KithmootNodeError(403, 'refused'))
  try {
    off = transport.subscribe([{ kinds: [1059], '#p': [getPublicKey(opts.deviceSk)], since: now() - 30 }], event => {
      if (finished || opts.signal?.aborted || opts.allowed?.() === false) { cancel(); return }
      const answer = decodeNodeJoinAnswer({ node: opts.node, deviceSk: opts.deviceSk, event, requestId: request.requestId,
        requestExpiresAt: request.expiresAt, now: now() })
      if (answer !== null) finish(answer)
    })
    opts.signal?.addEventListener('abort', cancel, { once: true })
    timer = setTimeout(() => finish(undefined, new KithmootNodeError(0, 'expired')), Math.max(1, (request.expiresAt - now()) * 1000))
    void transport.publish(request.event).catch(error => finish(undefined, error instanceof KithmootNodeError ? error : new KithmootNodeError(0, 'unavailable')))
  } catch { finish(undefined, new KithmootNodeError(0, 'unavailable')) }
  return { requestId: request.requestId, expiresAt: request.expiresAt, result, cancel }
}

/** The room key stays in the keeper's app. The durable grant journal reaches
 * the desk before an admission answer can contain that key. This class never
 * publishes bearer welcomes and never treats an HTTP failure as admission. */
export async function openNodeKeeperAdmissions(opts: { node: NodeRoomRecord; authoritySk: Uint8Array; roomSecret: Uint8Array;
  keeperParticipant: string; initialMembers?: readonly string[]; initialRemoved?: readonly string[]; epochHint: () => number; acceptsExistingDevice?: (device: string, participant: string) => boolean; store: NodeKeeperStore; onGrant?: (event: GroupEvent) => Promise<void>
  /** Removals the embedding's session knows of that this journal may not have recorded yet. */
  removed?: (participant: string) => boolean } & NodeClientOptions): Promise<NodeKeeperAdmissions> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000)), node = readNodeRoom(opts.node.event, now(), getPublicKey(opts.authoritySk))
  const derived = deriveRoom(opts.roomSecret)
  const matches = derived.roomId === node?.room; derived.roomKey.fill(0)
  if (!node || !matches || !KEY.test(opts.keeperParticipant)) throw new KithmootNodeError(0, 'invalid')
  const authoritySk = opts.authoritySk.slice(), secret = opts.roomSecret.slice(), authority = localIdentity(authoritySk), host = new URL(node.origin).hostname
  let stopped = false, failed = false, queue: Promise<unknown> = Promise.resolve()
  const live = () => !stopped && !failed && !opts.signal?.aborted && (opts.allowed?.() ?? true) && (node.endsAt === undefined || node.endsAt > now())
  const requireLive = () => { if (!live()) throw new KithmootNodeError(403, 'refused') }
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => { const task = queue.then(run); queue = task.catch(() => {}); return task }
  let state: NodeKeeperSnapshot
  try {
    const saved = await opts.store.load()
    state = saved === undefined ? { v: 1, descriptor: node.event.id, members: [...new Set([opts.keeperParticipant, ...(opts.initialMembers ?? [])])], removed: [...new Set(opts.initialRemoved ?? [])], grants: [] } : structuredClone(saved)
    if (state.v !== 1 || state.descriptor !== node.event.id || !Array.isArray(state.members) || !Array.isArray(state.removed) || !Array.isArray(state.grants)
      || state.members.length > MAX_RECORDS || state.removed.length > MAX_RECORDS || state.grants.length > MAX_RECORDS
      || [...state.members, ...state.removed].some(p => !KEY.test(p)) || new Set(state.members).size !== state.members.length
      || new Set(state.removed).size !== state.removed.length || !state.members.includes(opts.keeperParticipant) || state.removed.includes(opts.keeperParticipant)) throw Error('invalid ledger')
    const devices = new Set<string>(), ids = new Set<string>()
    for (const record of state.grants) {
      const parsed = parseGroupEvent(record.event, { keepers: [node.authority], servers: [host] })
      const credential = verifyDeviceCredential(record.credential, { roomId: node.room, now: record.credential.created_at })
      if (!parsed.ok || parsed.parsed.type !== 'grant' || parsed.parsed.roomId !== node.room || typeof record.posted !== 'boolean'
        || !credential.ok || credential.participant !== record.participant || credential.device !== parsed.parsed.device
        || !state.members.includes(record.participant) || JSON.stringify(parsed.parsed.scopes) !== JSON.stringify(['turn', 'relay-read', 'relay-write'])
        || parsed.parsed.bytes !== undefined || devices.has(parsed.parsed.device) || ids.has(parsed.parsed.grantId)
        || [node.authority, node.serviceKey].includes(parsed.parsed.device) || parsed.parsed.expiration > (node.endsAt ?? Infinity)
        || state.removed.includes(record.participant) && parsed.parsed.status !== 'revoked') throw Error('invalid ledger')
      devices.add(parsed.parsed.device); ids.add(parsed.parsed.grantId)
    }
  } catch { authoritySk.fill(0); secret.fill(0); throw new KithmootNodeError(0, 'invalid') }
  const save = async () => {
    try { await opts.store.save(structuredClone(state)) }
    catch { failed = true; throw new KithmootNodeError(0, 'unavailable') }
  }
  const parsed = (record: DeviceGrant): ParsedGrant => {
    const result = parseGroupEvent(record.event); if (!result.ok || result.parsed.type !== 'grant') throw new KithmootNodeError(0, 'invalid')
    return result.parsed
  }
  // The node already holds a different grant for this device, signed by
  // another keeper of the room: another of the account's devices let it in
  // while this one's own grant went unacknowledged. This record never took
  // effect and cannot while that grant stands. Replayed, it would stop this
  // keeper, and the room with it, from opening again.
  const superseded = (error: unknown, record: DeviceGrant) => error instanceof KithmootNodeError && error.status === 409
    && error.code === 'device-already-granted' && parsed(record).status === 'active'
  /** False when the node holds another keeper's grant for this device instead. */
  const push = async (record: DeviceGrant): Promise<boolean> => {
    try {
      await postNodeGrant(node, record.event, authority, { ...opts, allowed: () => !stopped && !opts.signal?.aborted && (opts.allowed?.() ?? true) })
    } catch (error) {
      if (stopped || !superseded(error, record)) throw error
      const at = state.grants.indexOf(record)
      if (at >= 0) { state.grants.splice(at, 1); await save() }
      return false
    }
    if (stopped) throw new KithmootNodeError(403, 'refused')
    await opts.onGrant?.(structuredClone(record.event)); record.posted = true; await save()
    return true
  }
  const inspect = (raw: unknown) => {
    if (!live()) return null
    const request = decodeNodeJoinRequest({ node, authoritySk, event: raw, now: now() })
    const named = node.existing?.policy?.members
    if (!request || state.removed.includes(request.participant) || opts.removed?.(request.participant) === true || named && !named.includes(request.participant)) return null
    // A room whose policy lists its members has already said who belongs,
    // whether or not this keeper's own journal has met them yet.
    return { request, known: state.members.includes(request.participant) || named !== undefined }
  }
  const issue = async (credential: Event, participant: string): Promise<GroupEvent> => {
    requireLive()
    const proof = verifyDeviceCredential(credential, { roomId: node.room, now: now() })
    if (!proof.ok || proof.participant !== participant || [node.authority, node.serviceKey].includes(proof.device) || state.removed.includes(participant)) throw new KithmootNodeError(403, 'refused')
    let record = state.grants.find(r => parsed(r).device === proof.device)
    if (record && (record.participant !== participant || parsed(record).status !== 'active')) throw new KithmootNodeError(403, 'refused')
    if ((!record || parsed(record).expiration <= now()) && state.grants.filter(r => r !== record && r.participant === participant
      && parsed(r).status === 'active' && parsed(r).expiration > now()).length >= MAX_DEVICES) throw new KithmootNodeError(403, 'refused')
    if (!record) {
      if (state.grants.length >= MAX_RECORDS || state.members.length >= MAX_RECORDS && !state.members.includes(participant)
        || state.grants.filter(r => r.participant === participant && parsed(r).status === 'active' && parsed(r).expiration > now()).length >= MAX_DEVICES) throw new KithmootNodeError(403, 'refused')
      record = { participant, credential: structuredClone(credential), event: buildGrant({ authoritySk, roomId: node.room, device: proof.device, server: host,
        scopes: ['turn', 'relay-read', 'relay-write'], grantId: newGrantId(randomBytes), createdAt: now(), expiration: Math.min(now() + GRANT_LIFETIME_SECONDS, node.endsAt ?? Infinity) }), posted: false }
      state.grants.push(record)
      if (!state.members.includes(participant)) state.members.push(participant)
      await save()
    } else if (parsed(record).expiration <= now() + GRANT_RENEW_WITHIN_SECONDS && parsed(record).expiration < (node.endsAt ?? Infinity)) {
      const previous = parsed(record), createdAt = nextCreatedAt(now(), previous.createdAt)
      record.credential = structuredClone(credential)
      record.event = buildGrant({ authoritySk, roomId: node.room, device: proof.device, server: host, scopes: previous.scopes,
        grantId: previous.grantId, createdAt, expiration: Math.min(createdAt + GRANT_LIFETIME_SECONDS, node.endsAt ?? Infinity) })
      record.posted = false; await save()
    }
    // Repost even an acknowledged grant: a restarted child must ACK its
    // current projection before this new admission answer is signed.
    if (!await push(record)) throw new KithmootNodeError(409, 'refused', 'device-already-granted')
    requireLive()
    if (!verifyNodeRoomGrant(record.event, node, proof.device, now())) throw new KithmootNodeError(0, 'invalid')
    return structuredClone(record.event)
  }
  try { await save() } catch (error) { authoritySk.fill(0); secret.fill(0); throw error }
  return {
    inspect,
    admit: (raw, approveUnknown) => enqueue(async () => {
      requireLive(); const value = inspect(raw)
      if (!value || !value.known && approveUnknown !== true) throw new KithmootNodeError(403, 'refused')
      const grant = await issue(value.request.credential, value.request.participant)
      requireLive()
      return encodeNodeJoinAnswer({ node, authoritySk, request: raw, now: now(), admission: { roomSecret: secret, epochHint: opts.epochHint(), grant } })
    }),
    deny(raw) { requireLive(); return encodeNodeJoinAnswer({ node, authoritySk, request: raw, now: now() }) },
    authoriseKeeperDevice: credential => enqueue(() => issue(credential, opts.keeperParticipant)),
    authoriseExistingDevice: credential => enqueue(async () => {
      requireLive()
      const proof = verifyDeviceCredential(credential, { roomId: node.room, now: now() })
      if (!node.existing || !proof.ok || opts.acceptsExistingDevice?.(proof.device, proof.participant) !== true) throw new KithmootNodeError(403, 'refused')
      const event = await issue(credential, proof.participant)
      requireLive()
      if (opts.acceptsExistingDevice?.(proof.device, proof.participant) !== true) throw new KithmootNodeError(403, 'refused')
      return event
    }),
    remove: participant => enqueue(async () => {
      requireLive()
      if (!KEY.test(participant) || participant === opts.keeperParticipant) throw new KithmootNodeError(403, 'refused')
      if (!state.members.includes(participant)) return
      // Already removed, with every revocation sent: nothing more to do. Owner
      // devices apply each other's removals over and over.
      if (state.removed.includes(participant) && state.grants.every(r => r.participant !== participant || parsed(r).status !== 'active' && r.posted)) return
      if (!state.removed.includes(participant)) state.removed.push(participant)
      const records = state.grants.filter(r => r.participant === participant)
      for (const record of records) {
        const grant = parsed(record)
        if (grant.status === 'active') { record.event = buildRevocation(grant, authoritySk, nextCreatedAt(now(), grant.createdAt)); record.posted = false }
      }
      // Storage failure never prevents the restrictive signed events from
      // reaching the node. It still blocks any subsequent admission here.
      let error: unknown
      try { await save() } catch (cause) { error = cause }
      for (const record of records) try { await push(record) } catch (cause) { error ??= cause }
      if (error) throw error
    }),
    learnMembers: participants => enqueue(async () => {
      requireLive()
      const fresh = [...new Set(participants)].filter(p => KEY.test(p) && !state.members.includes(p) && !state.removed.includes(p))
      if (!fresh.length) return
      state.members.push(...fresh.slice(0, Math.max(0, MAX_RECORDS - state.members.length)))
      await save()
    }),
    retry: () => enqueue(async () => {
      requireLive(); let error: unknown
      for (const record of state.grants.filter(r => !r.posted)) try { await push(record) } catch (cause) { error ??= cause }
      if (error) throw error
    }),
    renew: () => enqueue(async () => {
      requireLive()
      // A copy: a superseded grant leaves the journal mid-loop.
      for (const record of [...state.grants]) {
        const previous = parsed(record)
        // A grant already reaching the room end cannot be extended. Replacing
        // it at the same expiry is rejected by the node, including on return.
        if (previous.status !== 'active' || state.removed.includes(record.participant) || previous.expiration > now() + GRANT_RENEW_WITHIN_SECONDS
          || previous.expiration >= (node.endsAt ?? Infinity)) continue
        const createdAt = nextCreatedAt(now(), previous.createdAt)
        record.event = buildGrant({ authoritySk, roomId: node.room, device: previous.device, server: host, scopes: previous.scopes,
          grantId: previous.grantId, createdAt, expiration: Math.min(createdAt + GRANT_LIFETIME_SECONDS, node.endsAt ?? Infinity) })
        record.posted = false; await save(); await push(record)
      }
    }),
    close() {
      stopped = true; authoritySk.fill(0); secret.fill(0)
      return state.grants.reduce((at, record) => Math.max(at, record.event.created_at), now())
    },
  }
}
