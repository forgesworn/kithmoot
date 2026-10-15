/** @internal One fixed ordinary-P extension restore capture. This is resource
 * ownership and selection only, never ordinary custody or phase permission. */
import type { ProtocolExecution } from '../../src/protocol-execution.js'
import type { OrdinaryStateOwner } from './ordinary-state-owner.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { verifyOrdinaryLifecycleRoot, verifyOrdinaryLifecyclePromise } from './ordinary-protocol-work.js'

declare const coldExtensionBrand: unique symbol
export interface OrdinaryColdExtensionFactory { readonly [coldExtensionBrand]: true }
export interface OrdinaryColdExtensionCapture {
  readonly browser: OrdinaryStateOwner
  readonly tab: OrdinaryStateOwner
  readonly account: string
  readonly invitationId: string
  readonly link: string
  readonly keep: boolean
  readonly bootstrapCredentialExpiresAt: number
  readonly live: () => boolean
  readonly checkClients: () => Promise<void>
}
const factories = new WeakSet<object>()
const captures = new WeakMap<object, { binding: Readonly<OrdinaryColdExtensionCapture>; root?: ProtocolExecution }>()
function hold(): never { throw new OrdinaryStateHold() }
/** Sole production caller is the private extension-startup owner. No store,
 * desired intent, expiry rewrite, provider or callback executor is accepted. */
export function registerOrdinaryColdExtensionFactory(factory: object, input: OrdinaryColdExtensionCapture): OrdinaryColdExtensionFactory {
  if (!factory || factories.has(factory) || !/^[0-9a-f]{64}$/.test(input.account) ||
      !/^[0-9a-f]{64}$/.test(input.invitationId) || typeof input.keep !== 'boolean' ||
      typeof input.link !== 'string' || !Number.isSafeInteger(input.bootstrapCredentialExpiresAt) || input.bootstrapCredentialExpiresAt <= 0 ||
      typeof input.live !== 'function' || typeof input.checkClients !== 'function') hold()
  factories.add(factory)
  const token = Object.freeze({}) as OrdinaryColdExtensionFactory
  captures.set(token, { binding: Object.freeze({ ...input }) })
  return token
}
export function takeOrdinaryColdExtensionFactory(token: OrdinaryColdExtensionFactory, root: ProtocolExecution): Readonly<OrdinaryColdExtensionCapture> {
  verifyOrdinaryLifecycleRoot(root)
  const value = captures.get(token)
  if (!value || value.root || value.binding.live() !== true) hold()
  value.root = root; return value.binding
}
export function checkOrdinaryColdExtensionPromise(token: OrdinaryColdExtensionFactory, root: ProtocolExecution, pending: Promise<unknown>): void {
  const value = captures.get(token)
  if (!value || value.root !== root) hold()
  verifyOrdinaryLifecyclePromise(root, pending)
  if (value.binding.live() !== true) hold()
  verifyOrdinaryLifecyclePromise(root, pending)
}
