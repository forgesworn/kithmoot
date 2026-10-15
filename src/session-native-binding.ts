/** @internal Package construction plumbing. This is deliberately absent from
 * the public entry point and package exports. An exports fence governs API
 * resolution, not trusted code or absolute filesystem imports. */
import type { DeviceCredential } from './types.js'
import type { ProtocolExecution } from './protocol-execution.js'

declare const planBrand: unique symbol
export interface NativeSessionPlan { readonly [planBrand]: true }
export interface NativeSessionSnapshot {
  readonly credential: DeviceCredential
  readonly epoch: number
  readonly epochId: string
  readonly seals: readonly string[]
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
}
const entries = new WeakMap<object, Readonly<NativeSessionBinding>>()
/** Only the actual native bootstrap factory imports this registrar. The exact
 * options object is unshared, and registration cannot replace another cell. */
export function registerNativeSessionBinding(options: object, input: NativeSessionBinding): () => void {
  if (Object.getPrototypeOf(options) !== Object.prototype || entries.has(options) ||
      Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).sort().join(',') !== 'attach,revoke,schedule') {
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
  const cell = Object.freeze({ attach: field('attach'), schedule: field('schedule'), revoke: field('revoke') }) as NativeSessionBinding
  entries.set(options, cell)
  return () => { if (entries.get(options) === cell) entries.delete(options) }
}
/** The literal first constructor action, before option access or callbacks. */
export function consumeNativeSessionBinding(options: object): Readonly<NativeSessionBinding> | undefined {
  const cell = entries.get(options)
  entries.delete(options)
  return cell
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
