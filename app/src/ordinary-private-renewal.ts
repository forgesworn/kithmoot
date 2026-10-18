/** @internal Private member-renewal ownership. This registry never carries
 * legacy Factory bindings, owners, scopes, SDK objects or signer facades.
 * Its intent is data; fixed native E/P/C/S consumers still owe fresh custody. */
import type { ProtocolExecution } from '../../src/protocol-execution.js'
import { RESUME_MIN_REMAINING_SECONDS } from '../../src/session.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { takeOrdinaryPrivateRenewalFactoryClaim, ordinaryPrivateRenewalFactoryCurrent,
  prepareOrdinaryPrivateRenewalIntent, takeOrdinaryPrivateRenewalIntent, stopOrdinaryPrivateRenewalFactory, verifyOrdinaryPrivateRenewalLifecycle,
  type OrdinaryPrivateMemberNative, type OrdinaryPrivateRenewalFactoryClaim } from './ordinary-state-owner.js'
import { ordinaryPrivateForegroundCurrent, type OrdinaryPrivateForegroundAuthority } from './ordinary-foreground-signer.js'
import { verifyOrdinaryLifecycleRoot, verifyOrdinaryLifecyclePromise } from './ordinary-protocol-work.js'
import type { OrdinaryRenewalIntent } from './ordinary-renewal-obligation.js'

declare const factoryBrand: unique symbol
export interface OrdinaryPrivateRenewalFactory { readonly [factoryBrand]: true }
declare const obligationBrand: unique symbol
export interface OrdinaryPrivateRenewalObligation { readonly [obligationBrand]: true }
interface Factory {
  readonly native: OrdinaryPrivateMemberNative
  readonly foreground: OrdinaryPrivateForegroundAuthority
  readonly roots: WeakSet<object>
  readonly state: { prepared: boolean }
}
interface Obligation {
  readonly factory: OrdinaryPrivateRenewalFactory
  readonly root: ProtocolExecution
  readonly intent: OrdinaryRenewalIntent
  state: 'available' | 'claimed' | 'released'
}
const factories = new WeakMap<object, Factory>()
const obligations = new WeakMap<object, Obligation>()
function hold(): never { throw new OrdinaryStateHold() }
function current(value: Obligation): Factory {
  const factory = factories.get(value.factory)
  if (!factory || !ordinaryPrivateRenewalFactoryCurrent(value.factory) ||
      !ordinaryPrivateForegroundCurrent(factory.foreground, factory.native, value.intent.participant,
        value.intent.authority.foregroundExpiresAt)) hold()
  return factory
}
/** Fixed bootstrap-module consumer. Claim consumption is synchronous before
 * any callback, reflection or await; the returned value is another opaque
 * handle, never a callable operation bag or unpacked owner binding. */
export function openOrdinaryPrivateRenewalFactoryFromOwnerClaim(claim: OrdinaryPrivateRenewalFactoryClaim): OrdinaryPrivateRenewalFactory {
  const value = takeOrdinaryPrivateRenewalFactoryClaim(claim)
  if (factories.has(value.factory)) hold()
  factories.set(value.factory, Object.freeze({native: value.native, foreground: value.foreground, roots: new WeakSet<object>(), state: {prepared: false}}))
  return value.factory
}
/** Ownership registration only. The owner captures and acknowledges exact
 * predecessor/source data before returning its one-use intent witness.
 * This supplies no phase-P authority and performs no signing. */
export async function prepareOrdinaryPrivateRenewalObligation(factory: OrdinaryPrivateRenewalFactory, root: ProtocolExecution,
  desired: Readonly<{issuedAt: number; expiresAt: number; semanticDigest: string}>): Promise<OrdinaryPrivateRenewalObligation> {
  const value = factories.get(factory)
  if (!value || value.state.prepared || value.roots.has(root) || !ordinaryPrivateRenewalFactoryCurrent(factory)) hold()
  verifyOrdinaryPrivateRenewalLifecycle(factory, root)
  value.state.prepared = true
  value.roots.add(root)
  const witness = await prepareOrdinaryPrivateRenewalIntent(factory, root, desired)
  const intent = takeOrdinaryPrivateRenewalIntent(factory, root, witness)
  const token = Object.freeze({}) as OrdinaryPrivateRenewalObligation
  obligations.set(token, {factory, root, intent, state: 'available'})
  return token
}
/** Sole future E consumer: the owner resolves this opaque factory locally.
 * Raw native owners/scopes are never returned through this edge. */
export function takeOrdinaryPrivateRenewalObligation(token: OrdinaryPrivateRenewalObligation): Readonly<{
  factory: OrdinaryPrivateRenewalFactory; root: ProtocolExecution; intent: OrdinaryRenewalIntent
}> {
  const value = obligations.get(token)
  if (!value || value.state !== 'available') hold()
  verifyOrdinaryLifecycleRoot(value.root); current(value); verifyOrdinaryLifecycleRoot(value.root)
  value.state = 'claimed'
  return Object.freeze({factory: value.factory, root: value.root, intent: value.intent})
}
export function checkOrdinaryPrivateRenewalObligation(token: OrdinaryPrivateRenewalObligation): void {
  const value = obligations.get(token)
  if (!value || value.state !== 'claimed') hold()
  verifyOrdinaryLifecycleRoot(value.root); current(value); verifyOrdinaryLifecycleRoot(value.root)
}
export function checkOrdinaryPrivateRenewalSigningObligation(token: OrdinaryPrivateRenewalObligation, pending: Promise<unknown>): void {
  const value = obligations.get(token)
  if (!value || value.state !== 'claimed') hold()
  verifyOrdinaryLifecyclePromise(value.root, pending)
  if (value.intent.expiresAt - Math.floor(Date.now() / 1000) < RESUME_MIN_REMAINING_SECONDS) hold()
  current(value); verifyOrdinaryLifecyclePromise(value.root, pending)
}
export function releaseOrdinaryPrivateRenewalObligation(token: OrdinaryPrivateRenewalObligation | undefined): void {
  if (!token) return
  const value = obligations.get(token)
  if (value) value.state = 'released'
  obligations.delete(token)
}
export function closeOrdinaryPrivateRenewalFactory(factory: OrdinaryPrivateRenewalFactory): void {
  stopOrdinaryPrivateRenewalFactory(factory); factories.delete(factory)
}
