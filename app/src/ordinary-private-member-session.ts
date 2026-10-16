import { getPublicKey } from 'nostr-tools/pure'
import { RoomSession, type RoomSessionOptions } from '../../src/session.js'
import { registerRetainedNativeSessionBinding, type NativeSessionView } from '../../src/session-native-binding.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { takeOrdinaryPrivateSessionClaim, type OrdinaryPrivateSessionClaim } from './ordinary-persistent-bootstrap.js'
import type { OrdinaryProtocolGraphIdentity } from './ordinary-protocol-work.js'
import type { ProtocolExecution } from '../../src/protocol-execution.js'

declare const resourceBrand: unique symbol
export interface OrdinaryPrivateMemberSessionResource { readonly [resourceBrand]: true }
interface OwnedSession {
  readonly protocol: ProtocolExecution
  readonly graph: OrdinaryProtocolGraphIdentity
  readonly view: NativeSessionView
  readonly secret: Uint8Array
  readonly device: Uint8Array
  readonly seals: readonly Uint8Array[]
  disposed: boolean
  controllerClaimed: boolean
  closeResult?: Promise<Readonly<{ok: true} | {ok: false; error: unknown}>>
  closing?: Promise<void>
  draining?: Promise<void>
}
type CloseResult = Readonly<{ok: true} | {ok: false; error: unknown}>
const sessions = new WeakMap<object, OwnedSession>()
function owned(resource: OrdinaryPrivateMemberSessionResource): OwnedSession {
  const value = sessions.get(resource); if (!value) throw new OrdinaryStateHold(); return value
}
/** Fixed app-only construction. Consume the opaque genuine bootstrap claim
 * before material access. Raw options, SDK objects and mechanical Session
 * registrations are deliberately not accepted by this production wrapper. */
export function openOrdinaryPrivateMemberSessionFromBootstrapClaim(claim: OrdinaryPrivateSessionClaim): OrdinaryPrivateMemberSessionResource {
  const binding = takeOrdinaryPrivateSessionClaim(claim)
  const {material, transport, protocol, participant, roomId, authority, credentialTtlSeconds, current, schedule, revoke} = binding
  let secret: Uint8Array | undefined, device: Uint8Array | undefined
  const seals: Uint8Array[] = []
  let view: NativeSessionView | undefined, cancel: (() => void) | undefined
  try {
    secret = new Uint8Array(material.admission.secret); device = new Uint8Array(material.deviceKey)
    for (const key of material.sealKeys ?? [material.sealKey]) seals.push(new Uint8Array(key))
    const resume = structuredClone(material.credential)
    const options = Object.freeze(Object.assign(Object.create(null), {secret, deviceSk: device, resume, sealKeys: Object.freeze(seals), transport, protocol, authority,
      memberEpochDesk: false, epochCatchUp: false, requireFreshEpoch: true, expectedEpoch: 0, endsAt: material.admission.endsAt,
      onClosed: revoke, onRemoved: revoke, onEpochConflict: revoke,
      timing: Object.freeze(Object.assign(Object.create(null), {credentialTtlSeconds}))}))
    const capture = Object.freeze({protocol, transport, roomId, device: getPublicKey(device), participant,
      credential: JSON.stringify(resume), seals: Object.freeze(seals.map(key => getPublicKey(key))), expectedEpoch: 0, current})
    cancel = registerRetainedNativeSessionBinding(options, {attach: value => {view = value}, schedule, revoke}, capture)
    // Retained native construction is internal and intentionally absent from
    // the public Primary/Secondary options union. No identity is fabricated.
    new RoomSession(options as unknown as RoomSessionOptions)
    if (!view) throw new OrdinaryStateHold()
    const resource = Object.freeze({}) as OrdinaryPrivateMemberSessionResource
    sessions.set(resource, Object.assign(Object.create(null), {view, secret, device, seals, protocol, graph: binding.graph,
      disposed: false, controllerClaimed: false, closeResult: undefined, closing: undefined, draining: undefined}))
    return resource
  } catch (error) {
    view?.revoke(); secret?.fill(0); device?.fill(0); for (const key of seals) key.fill(0)
    throw error
  } finally { cancel?.() }
}
/** Component ownership only, after the genuine controller attachment claim
 * was consumed in its current construction decision. No Session or view is
 * returned; a different protocol or a second attachment is refused. */
export function retainOrdinaryPrivateMemberSessionForController(resource: OrdinaryPrivateMemberSessionResource, graph: OrdinaryProtocolGraphIdentity): void {
  const value = owned(resource)
  if (value.disposed || value.closeResult || value.closing || value.controllerClaimed || value.graph !== graph) throw new OrdinaryStateHold()
  value.controllerClaimed = true
}
/** Fixed lexical Session operations only. No instance, view or credential
 * facade escapes to a document caller. Joining still needs its fresh native
 * execution; the resource itself supplies no current membership authority. */
export function stopOrdinaryPrivateMemberSession(resource: OrdinaryPrivateMemberSessionResource): void {
  startLexicalClose(owned(resource))
}
/** Publish the shared result before native close can synchronously revoke
 * its parent and visit this component again. Closing aborts a pending join
 * immediately; secret disposal still belongs to the parent's terminal drain. */
function startLexicalClose(value: OwnedSession): Promise<CloseResult> {
  if (value.closeResult) return value.closeResult
  let resolve!: (result: CloseResult) => void
  const result = new Promise<CloseResult>(yes => {resolve = yes})
  value.closeResult = result
  const success = () => resolve(Object.freeze(Object.assign(Object.create(null), {ok: true as const})))
  const failure = (error: unknown) => resolve(Object.freeze(Object.assign(Object.create(null), {ok: false as const, error})))
  try {
    value.view.revoke()
    void value.view.close().then(success, failure).catch(failure)
  } catch (error) {failure(error)}
  return result
}
/** The caller must close its graph/carrier and join outstanding operations
 * before this final erasure. The lexical close runs once. A disposal failure
 * permits a later erasure-only retry; successful disposal is terminal, even
 * when close rejected. Neither retry nor terminal replay reopens the Session. */
export function closeOrdinaryPrivateMemberSession(resource: OrdinaryPrivateMemberSessionResource): Promise<void> {
  const value = owned(resource)
  if (value.closing) return value.closing
  let resolve!: () => void, reject!: (error: unknown) => void
  const attempt = new Promise<void>((yes, no) => {resolve = yes; reject = no})
  value.closing = attempt
  // Attach before synchronous close can re-enter this component. A later
  // erasure-only retry preserves the original settled close outcome.
  void attempt.catch(() => {if (!value.disposed && value.closing === attempt) value.closing = undefined})
  void startLexicalClose(value).then(closed => {
    let disposalFailed = false, disposalFailure: unknown
    try { value.view.dispose(); value.disposed = true }
    catch (error) {disposalFailed = true; disposalFailure = error}
    finally {value.secret.fill(0); value.device.fill(0); for (const key of value.seals) key.fill(0)}
    if (!closed.ok) throw closed.error
    if (disposalFailed) throw disposalFailure
  }).then(resolve, reject).catch(() => {})
  return attempt
}
/** Parent-owned terminal cleanup. Uncertain erasure retains custody: only
 * the module-owned disposed flag can finish this single shared drain. Backoff
 * performs memory cleanup only and never starts protocol or native work. */
export function drainOrdinaryPrivateMemberSession(resource: OrdinaryPrivateMemberSessionResource): Promise<void> {
  const value = owned(resource)
  if (value.draining) return value.draining
  let resolve!: () => void, reject!: (error: unknown) => void
  const draining = new Promise<void>((yes, no) => {resolve = yes; reject = no})
  value.draining = draining
  // Publish before cleanup can invoke another parent close synchronously.
  void Promise.resolve().then(async () => {
    let first: {error: unknown} | undefined, delay = 25
    for (;;) {
      try { await closeOrdinaryPrivateMemberSession(resource) }
      catch (error) { first ??= {error} }
      if (value.disposed) break
      await new Promise<void>(resolve => {setTimeout(resolve, delay)})
      delay = Math.min(1_000, delay * 2)
    }
    if (first) throw first.error
  }).then(resolve, reject).catch(() => {})
  void draining.catch(() => {})
  return draining
}
