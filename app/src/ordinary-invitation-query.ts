import type { Event } from 'nostr-tools/pure'
import { requestPersistentRoomAdmissionEvidence, type PersistentInvitationEvidenceResult } from '@forgesworn/fold-kit/persistent-invitation-evidence'
import { deriveInvitationId, type RoomInvitation } from '../../src/invitation.js'
import { KINDS } from '../../src/kinds.js'
import type { NetworkProfile } from '../../src/anonymous.js'
import type { ParticipantIdentity, UnsignedEvent } from '../../src/identity.js'
import type { RelayTransport } from '../../src/relay-pool.js'
import { authenticatedWebSocket, AUTH_TIMEOUT_MS, type RelayAuthentication, type AuthenticationGrant } from '../../src/relay-auth.js'
import { verifyEventUncached } from '../../src/verify.js'
import { creatorDestinations } from './persistent-creator-proof.js'
import { OrdinaryStateHold, ordinaryUtf8Length } from './ordinary-state-codec.js'

export interface OrdinaryInvitationQueryCarrier {
  readonly generation: string
  readonly profile: NetworkProfile
  readonly destinations: readonly string[]
  readonly websocketImplementation: typeof WebSocket
  readonly authentication?: readonly RelayAuthentication[]
}
export interface OrdinaryInvitationQueryOptions extends OrdinaryInvitationQueryCarrier {
  current(): OrdinaryInvitationQueryCarrier | undefined
  readonly timeoutMs?: number
  readonly authenticationTimeoutMs?: number
  readonly maxQueuedFrames?: number
  readonly maxQueuedBytes?: number
  readonly signal?: AbortSignal
}
export const INVITATION_QUERY_QUEUE_FRAMES = 32
export const INVITATION_QUERY_QUEUE_BYTES = 512 * 1024
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!
function hold(): never { throw new OrdinaryStateHold() }
interface Grant { url: string; identity: ParticipantIdentity; pubkey: string; sign: ParticipantIdentity['signEvent'] }

/** Internal carrier used only by the native bootstrap adapter. The guard is
 * supplied by that adapter, never by its external query options. No pool,
 * default destination, reconnect, publication or synthetic EOSE is provided. */
export async function queryInvitationOnProtectedCarrier(invitation: RoomInvitation, input: OrdinaryInvitationQueryOptions,
  guard: <T>(work: () => T) => Promise<T>, live: () => boolean, signal: AbortSignal): Promise<PersistentInvitationEvidenceResult['evidence']> {
  const captured = { ...input }
  const options = { ...captured, destinations: creatorDestinations(captured.destinations, captured.profile),
    authentication: (captured.authentication ?? []).map(value => ({ ...value })) }
  const timeout = options.timeoutMs ?? 15_000, authTimeout = options.authenticationTimeoutMs ?? AUTH_TIMEOUT_MS
  const maxFrames = options.maxQueuedFrames ?? INVITATION_QUERY_QUEUE_FRAMES, maxBytes = options.maxQueuedBytes ?? INVITATION_QUERY_QUEUE_BYTES
  if (!/^[0-9a-f]{64}$/.test(options.generation) || typeof options.websocketImplementation !== 'function' || typeof options.current !== 'function' ||
      !Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120_000 || !Number.isSafeInteger(authTimeout) || authTimeout < 100 || authTimeout > 120_000 ||
      !Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > INVITATION_QUERY_QUEUE_FRAMES ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > INVITATION_QUERY_QUEUE_BYTES || options.profile === 'tor' && options.authentication.length) hold()
  const grants = new Map<string, Grant>()
  for (const value of options.authentication) {
    const url = creatorDestinations([value.url], options.profile)[0]!
    if (!options.destinations.includes(url) || grants.has(url) || !value.identity || !/^[0-9a-f]{64}$/.test(value.identity.pubkey) ||
        typeof value.identity.signEvent !== 'function') hold()
    grants.set(url, { url, identity: value.identity, pubkey: value.identity.pubkey, sign: value.identity.signEvent })
  }
  const controller = new AbortController(), sockets = new Set<WebSocket>(), work = new Set<Promise<unknown>>()
  let active = true, failed = false, queuedFrames = 0, queuedBytes = 0, messages = 0
  const deadline = Date.now() + timeout
  const stop = (failure = true) => {
    if (failure) failed = true
    active = false; controller.abort()
    for (const socket of sockets) try { socket.close() } catch { /* Shutdown cannot resume the query. */ }
  }
  const current = (complete = false) => {
    try {
      if ((!active && !complete) || failed || aborted.call(signal) || options.signal && aborted.call(options.signal) || Date.now() >= deadline || !live()) return false
      const selected = options.current()
      if (!selected || selected.generation !== options.generation || selected.profile !== options.profile ||
          selected.websocketImplementation !== options.websocketImplementation ||
          JSON.stringify(creatorDestinations(selected.destinations, selected.profile)) !== JSON.stringify(options.destinations)) return false
      const authentication = selected.authentication ?? [], seen = new Set<string>()
      if (authentication.length !== grants.size) return false
      for (const value of authentication) {
        const url = creatorDestinations([value.url], selected.profile)[0]!, grant = grants.get(url)
        if (!grant || seen.has(url) || value.identity !== grant.identity || value.identity.pubkey !== grant.pubkey || value.identity.signEvent !== grant.sign) return false
        seen.add(url)
      }
      // Every external getter/callback above may revoke or re-enter.
      return (active || complete) && !failed && !aborted.call(signal) && !(options.signal && aborted.call(options.signal)) && Date.now() < deadline && live() && (active || complete) && !failed
    } catch { return false }
  }
  const track = <T>(promise: Promise<T>): Promise<T> => {
    work.add(promise); void promise.finally(() => work.delete(promise)).catch(() => {}); return promise
  }
  const read = <T>(effect: () => T): Promise<T> => track(guard(() => { if (!current()) hold(); const value = effect(); if (!current()) hold(); return value }))
  const id = 'ordinary-invitation', filters = [{ kinds: [KINDS.GROUP_INVITATION, KINDS.INVITATION_RETIREMENT], authors: [invitation.inviter], '#d': [deriveInvitationId(invitation)] }]
  const request = JSON.stringify(['REQ', id, ...filters]), completed = new Set<string>()
  let subscribed = false
  const transport: RelayTransport = {
    publish: () => Promise.reject(new OrdinaryStateHold()), close: () => stop(false),
    subscribe: (supplied, receive, eose) => {
      if (subscribed || !current() || JSON.stringify(supplied) !== JSON.stringify(filters)) hold()
      subscribed = true
      for (const url of options.destinations) {
        const grant = grants.get(url), Base = options.websocketImplementation
        let socket: WebSocket | undefined, tail = Promise.resolve(), reqQueued = false, reqSent = false, authQueued = false, authSent = false, expectedAuth: string | undefined
        const enqueue = (bytes: number, effect: () => void) => {
          if (!current() || queuedFrames + 1 > maxFrames || queuedBytes + bytes > maxBytes) hold()
          queuedFrames++; queuedBytes += bytes
          const job = tail.then(() => read(effect)).catch(() => { stop() }).finally(() => { queuedFrames--; queuedBytes -= bytes })
          tail = job; void track(job)
        }
        class QuerySocket extends Base {
          constructor(destination: string) { if (destination !== url || !current()) hold(); super(destination); sockets.add(this) }
          override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
            try {
              if (typeof data !== 'string' || !current()) hold()
              const req = data === request, auth = expectedAuth !== undefined && data === expectedAuth
              if (req ? reqQueued : auth ? authQueued : true) hold()
              const bytes = ordinaryUtf8Length(data, INVITATION_QUERY_QUEUE_BYTES)
              if (req) reqQueued = true; else authQueued = true
              enqueue(bytes, () => {
                if (this.readyState !== 1 || (req ? reqSent || grant && !authSent : authSent || data !== expectedAuth)) hold()
                super.send(data)
                if (req) reqSent = true; else { authSent = true; expectedAuth = undefined }
              })
            } catch { stop(); throw new OrdinaryStateHold() }
          }
        }
        let authentication: AuthenticationGrant | undefined
        if (grant) authentication = { pubkey: grant.pubkey, sign: template => track((async () => {
          const canonical = JSON.stringify(template), statement: UnsignedEvent = JSON.parse(canonical)
          if (statement.kind !== 22242 || statement.content !== '' || !Number.isSafeInteger(statement.created_at) || statement.tags.length !== 2 ||
              JSON.stringify(statement.tags[0]) !== JSON.stringify(['relay', url]) || statement.tags[1]?.length !== 2 ||
              statement.tags[1]?.[0] !== 'challenge' || !statement.tags[1][1] || statement.tags[1][1].length > 1024) hold()
          let signing: Promise<Event> | undefined
          try {
            await read(() => { signing = grant.sign.call(grant.identity, JSON.parse(canonical)); void signing.catch(() => {}) })
            if (!signing) hold()
            const signed = await signing, event: Event = { ...statement, id: signed.id, pubkey: signed.pubkey, sig: signed.sig }
            if (!current() || signed.pubkey !== grant.pubkey || signed.kind !== statement.kind || signed.created_at !== statement.created_at ||
                signed.content !== statement.content || JSON.stringify(signed.tags) !== JSON.stringify(statement.tags) || !verifyEventUncached(event)) hold()
            await read(() => { if (expectedAuth !== undefined || authQueued) hold(); expectedAuth = JSON.stringify(['AUTH', event]) })
            return event
          } finally { if (signing) await Promise.allSettled([signing]) }
        })()) }
        const Auth = authenticatedWebSocket(QuerySocket as typeof WebSocket, () => authentication, () => current(), () => stop(), authTimeout)
        void read(() => {
          socket = new Auth(url); sockets.add(socket)
          socket.onopen = () => { try { if (!current()) hold(); socket!.send(request) } catch { stop() } }
          socket.onerror = () => stop()
          socket.onclose = () => { if (active && !completed.has(url)) stop() }
          socket.onmessage = message => {
            try {
              if (!current() || typeof message.data !== 'string' || ++messages > 128) hold()
              const data = message.data, bytes = ordinaryUtf8Length(data, 264_192)
              enqueue(bytes, () => {
                if (!reqSent || completed.has(url)) hold()
                const frame: unknown = JSON.parse(data)
                if (!Array.isArray(frame)) hold()
                if (frame[0] === 'EVENT' && frame.length === 3 && frame[1] === id) receive(frame[2] as Event, url)
                else if (frame[0] === 'EOSE' && frame.length === 2 && frame[1] === id) {
                  completed.add(url)
                  if (completed.size === options.destinations.length) queueMicrotask(() => { if (current()) eose?.(); else stop() })
                } else hold()
              })
            } catch { stop() }
          }
        }).catch(() => stop())
      }
      // Close the dedicated sockets rather than sending an unguarded CLOSE
      // after cancellation. No other subscription shares these connections.
      return () => stop(false)
    },
  }
  const cancel = () => stop(), timer = setTimeout(cancel, timeout)
  EventTarget.prototype.addEventListener.call(signal, 'abort', cancel, { once: true })
  if (options.signal) EventTarget.prototype.addEventListener.call(options.signal, 'abort', cancel, { once: true })
  let result: PersistentInvitationEvidenceResult | undefined
  try {
    if (!current()) hold()
    result = await requestPersistentRoomAdmissionEvidence({ transport, invitation, timeoutMs: timeout, signal: controller.signal })
    if (failed || completed.size !== options.destinations.length) hold()
  } catch { return hold() }
  finally {
    clearTimeout(timer); EventTarget.prototype.removeEventListener.call(signal, 'abort', cancel)
    if (options.signal) EventTarget.prototype.removeEventListener.call(options.signal, 'abort', cancel)
    stop(false)
    while (work.size) await Promise.allSettled([...work])
    sockets.clear()
    if (result?.outcome.status === 'admitted') result.outcome.admission.secret.fill(0)
  }
  // Shutdown and every queued/provider continuation have finished. Capture
  // only evidence at the final native handoff, with carrier consent still
  // current; the decoded root never leaves this internal helper.
  try {
    const evidence = await guard(() => { if (!current(true) || !result) hold(); return result.evidence })
    if (!current(true)) hold()
    return evidence
  } finally { result = undefined }
}
