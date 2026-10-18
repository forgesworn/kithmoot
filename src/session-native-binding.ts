/** @internal Package construction plumbing. This is deliberately absent from
 * the public entry point and package exports. An exports fence governs API
 * resolution, not trusted code or absolute filesystem imports. */
import type { DeviceCredential } from './types.js'
import type { ProtocolExecution } from './protocol-execution.js'
import type { RelayTransport } from './relay-pool.js'

declare const planBrand: unique symbol
export interface NativeSessionPlan { readonly [planBrand]: true }
export interface NativeSessionSnapshot {
  readonly credential: DeviceCredential
  readonly epoch: number
  readonly epochId: string
  readonly seals: readonly string[]
  readonly channels: readonly string[]
}
export interface NativeSessionCandidate {
  readonly credential: DeviceCredential
  readonly sealKeys: readonly Uint8Array[]
  readonly predecessor: string
  readonly operation: string
  readonly root: ProtocolExecution
  /** Actual factory checks. Preparation and apply have distinct phases. */
  readonly checkPreparation: () => void
  readonly checkApplication: () => void
}
export interface NativeSessionView {
  join(): Promise<void>
  close(): Promise<void>
  dispose(): void
  snapshot(): NativeSessionSnapshot
  prepare(candidate: NativeSessionCandidate): NativeSessionPlan
  check(plan: NativeSessionPlan): void
  apply(plan: NativeSessionPlan): void
  discard(plan: NativeSessionPlan): void
  restate(scope: ProtocolExecution): Promise<void>
  revoke(): void
}
export interface NativeSessionBinding {
  attach(view: NativeSessionView): void
  schedule(delay: number): void
  revoke(): void
  /** Internal retained embedding check, after epoch settlement and before any
   * roster, descriptor, mesh or presence exposure. Synchronous native read. */
  beforeAnnounce?(snapshot: NativeSessionSnapshot): void
}
/** Owned record from the fixed genuine-claim app wrapper only. This is
 * mechanical constructor plumbing, never a replacement for native custody. */
export interface RetainedNativeSessionCapture {
  readonly protocol: ProtocolExecution
  readonly transport: RelayTransport
  readonly roomId: string
  readonly device: string
  readonly participant: string
  readonly credential: string
  readonly seals: readonly string[]
  readonly expectedEpoch: number
  readonly current: () => void
}
interface NativeSessionConstruction {
  readonly binding: Readonly<NativeSessionBinding>
  readonly retained?: Readonly<RetainedNativeSessionCapture>
}
const entries = new WeakMap<object, Readonly<NativeSessionConstruction>>()
/** Only the actual native bootstrap factory imports this registrar. The exact
 * options object is unshared, and registration cannot replace another cell. */
export function registerNativeSessionBinding(options: object, input: NativeSessionBinding): () => void {
  return register(options, input)
}
/** Retained construction carries no ParticipantIdentity. This cell selects
 * mechanics only; the private embedding still owes genuine native custody. */
export function registerRetainedNativeSessionBinding(options: object, input: NativeSessionBinding, capture: RetainedNativeSessionCapture): () => void {
  if (!Object.isFrozen(options) || Object.getPrototypeOf(capture) !== Object.prototype || !Object.isFrozen(capture)) throw new Error('retained native construction must be module-owned')
  const names = ['protocol', 'transport', 'roomId', 'device', 'participant', 'credential', 'seals', 'expectedEpoch', 'current'] as const
  const descriptors = Object.getOwnPropertyDescriptors(capture)
  if (Reflect.ownKeys(descriptors).length !== names.length || names.some(name => !descriptors[name] || !Object.hasOwn(descriptors[name]!, 'value'))) {
    throw new Error('invalid retained native construction record')
  }
  const seals = descriptors.seals!.value as readonly string[], current = descriptors.current!.value as () => unknown
  if (!Array.isArray(seals) || !Object.isFrozen(seals) || seals.length < 1 || seals.length > 128 || typeof current !== 'function' ||
      Object.getPrototypeOf(current) === Object.getPrototypeOf(async () => {})) throw new Error('invalid retained native construction record')
  const held = Object.freeze({ ...capture, current: () => {
    const result = Reflect.apply(current, capture, [])
    if (result !== undefined) {
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') void Promise.resolve(result).catch(() => {})
      throw new Error('retained native current check must complete synchronously')
    }
  } })
  return register(options, input, held)
}
function register(options: object, input: NativeSessionBinding, retained?: Readonly<RetainedNativeSessionCapture>): () => void {
  const prototype = Object.getPrototypeOf(options)
  if (prototype !== Object.prototype && (!retained || prototype !== null) || entries.has(options) ||
      Object.getPrototypeOf(input) !== Object.prototype ||
      !['attach,revoke,schedule', 'attach,beforeAnnounce,revoke,schedule'].includes(Reflect.ownKeys(input).sort().join(','))) {
    throw new Error('invalid native Session construction binding')
  }
  const field = (name: keyof NativeSessionBinding) => {
    const d = Object.getOwnPropertyDescriptor(input, name)
    if (!d || !Object.hasOwn(d, 'value') || typeof d.value !== 'function' ||
        Object.getPrototypeOf(d.value) === Object.getPrototypeOf(async () => {})) throw new Error('invalid native Session binding function')
    const implementation = d.value
    return (...args: unknown[]) => {
      const result: unknown = implementation(...args)
      if (result !== undefined) {
        // A regular function may also return a promise. Native construction,
        // scheduling and revocation are synchronous void handshakes.
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') void Promise.resolve(result).catch(() => {})
        throw new Error('native Session binding must complete synchronously')
      }
    }
  }
  const cell = Object.freeze({ attach: field('attach'), schedule: field('schedule'), revoke: field('revoke'),
    beforeAnnounce: Object.hasOwn(input, 'beforeAnnounce') ? field('beforeAnnounce') : undefined }) as NativeSessionBinding
  const construction = Object.freeze({binding: cell, retained})
  entries.set(options, construction)
  return () => { if (entries.get(options) === construction) entries.delete(options) }
}
/** The literal first constructor action, before option access or callbacks. */
export function consumeNativeSessionConstruction(options: object): Readonly<NativeSessionConstruction> | undefined {
  const cell = entries.get(options)
  entries.delete(options)
  return cell
}
/** Compatibility observer for the legacy construction cell. Taking either
 * form spends the same exact-options registration. */
export function consumeNativeSessionBinding(options: object): Readonly<NativeSessionBinding> | undefined {
  return consumeNativeSessionConstruction(options)?.binding
}

interface ChatView { check(id: string): void; apply(credential: DeviceCredential): void }
const chats = new WeakMap<object, Readonly<ChatView>>()
/** Class-private implementations, never prototype-dispatchable setters. */
export function registerNativeChatView(chat: object, view: ChatView): void { chats.set(chat, Object.freeze(view)) }
export function nativeChatView(chat: object): Readonly<ChatView> {
  const view = chats.get(chat)
  if (!view) throw new Error('missing native conversation view')
  return view
}
