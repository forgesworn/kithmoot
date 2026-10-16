import { prepareOrdinaryPrivateControllerRenewal, stopOrdinaryPrivateControllerRenewal, closeOrdinaryPrivateControllerRenewal, verifyOrdinaryPrivateControllerRenewalAttachment, type OrdinaryPrivateControllerRenewal } from './ordinary-state-owner.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { takeOrdinaryPrivateMemberControllerClaim, takeOrdinaryPrivateMemberControllerSessionClaim,
  type OrdinaryPrivateMemberControllerClaim, type OrdinaryPrivateMemberControllerSessionClaim } from './ordinary-persistent-bootstrap.js'
import { retainOrdinaryPrivateMemberSessionForController, type OrdinaryPrivateMemberSessionResource } from './ordinary-private-member-session.js'

declare const resourceBrand: unique symbol
export interface OrdinaryPrivateMemberControllerResource { readonly [resourceBrand]: true }
type Binding = ReturnType<typeof takeOrdinaryPrivateMemberControllerClaim>
interface Controller {
  readonly binding: Binding
  session?: OrdinaryPrivateMemberSessionResource
  renewal?: OrdinaryPrivateControllerRenewal
  preparing?: Promise<void>
  closed: boolean
  closing?: Promise<void>
}
const controllers = new WeakMap<object, Controller>()
function owned(resource: OrdinaryPrivateMemberControllerResource): Controller {
  const value = controllers.get(resource)
  if (!value) throw new OrdinaryStateHold()
  return value
}
/** Construction stage of the actual member controller. Its component
 * identities are genuine bootstrap products, not a caller's operation bag.
 * It deliberately cannot arm renewal until adoption and trusted consent are
 * implemented together. No timer here can request a wallet signature. */
export function openOrdinaryPrivateMemberControllerFromBootstrapClaim(claim: OrdinaryPrivateMemberControllerClaim): OrdinaryPrivateMemberControllerResource {
  const binding = takeOrdinaryPrivateMemberControllerClaim(claim)
  const resource = Object.freeze({}) as OrdinaryPrivateMemberControllerResource
  controllers.set(resource, Object.assign(Object.create(null), {binding, session: undefined, renewal: undefined, preparing: undefined, closed: false, closing: undefined}))
  return resource
}
/** Spend the actual one-use attachment before checking any state. Component
 * references remain inside this module; the resource exposes no executor,
 * raw Session, owner, scope, signer or NativeSessionView. */
export function attachOrdinaryPrivateMemberControllerSessionFromBootstrapClaim(claim: OrdinaryPrivateMemberControllerSessionClaim): void {
  const binding = takeOrdinaryPrivateMemberControllerSessionClaim(claim), value = owned(binding.controller)
  if (value.closed || value.session || !value.binding.live() || binding.bootstrap !== value.binding.bootstrap ||
      binding.carrier !== value.binding.carrier || binding.generation !== value.binding.generation ||
      binding.graph !== value.binding.graph) throw new OrdinaryStateHold()
  verifyOrdinaryPrivateControllerRenewalAttachment(binding.renewal, binding)
  retainOrdinaryPrivateMemberSessionForController(binding.session, binding.graph)
  value.renewal = binding.renewal
  value.session = binding.session
}
/** Fixed bootstrap continuation after attachment. The exact owner-bound
 * generation reservation and all asynchronous client/read checks remain in
 * the native owner. Publication starts no lifecycle, timer or wallet prompt. */
export function prepareOrdinaryPrivateMemberControllerRenewal(resource: OrdinaryPrivateMemberControllerResource): Promise<void> {
  const value = owned(resource)
  if (value.closed || !value.session || !value.renewal || !value.binding.live()) return Promise.reject(new OrdinaryStateHold())
  if (value.preparing) return value.preparing
  const pending = prepareOrdinaryPrivateControllerRenewal(value.renewal)
  value.preparing = pending
  return pending
}
/** Stable lexical Session schedule edge, installed before Session exists.
 * Pre-armed scheduling refuses before reading caller data or creating work.
 * A later fixed adoption path must own activation and every timer lifetime. */
export function scheduleOrdinaryPrivateMemberController(resource: OrdinaryPrivateMemberControllerResource, _delay: number): void {
  owned(resource)
  throw new OrdinaryStateHold()
}
export function stopOrdinaryPrivateMemberController(resource: OrdinaryPrivateMemberControllerResource): void {
  const value = owned(resource)
  if (value.closed) return
  value.closed = true
  if (value.renewal) stopOrdinaryPrivateControllerRenewal(value.renewal)
  // The fixed bootstrap callback revokes every component. Marking closed
  // first makes the parent's synchronous visit back here idempotent.
  value.binding.revoke()
}
/** Parent cleanup only. The bootstrap joins its protocol and carrier tails
 * before this resource and the actual Session are erased. This stage starts
 * no timer or controller work, so it has no ancestor or child to join. */
export function closeOrdinaryPrivateMemberController(resource: OrdinaryPrivateMemberControllerResource): Promise<void> {
  const value = owned(resource)
  if (value.closing) return value.closing
  let resolve!: () => void, reject!: (error: unknown) => void
  const closing = new Promise<void>((yes, no) => {resolve = yes; reject = no})
  value.closing = closing
  let failure: unknown
  try {stopOrdinaryPrivateMemberController(resource)} catch (error) {failure = error}
  void Promise.resolve().then(async () => {
    if (value.preparing) await Promise.allSettled([value.preparing])
    if (value.renewal) await closeOrdinaryPrivateControllerRenewal(value.renewal)
    value.session = undefined; value.renewal = undefined
    if (failure) throw failure
  }).then(resolve, error => {value.session = undefined; value.renewal = undefined; reject(error)}).catch(() => {})
  void closing.catch(() => {})
  return closing
}
