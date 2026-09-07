/** KithMoot integration for the portable context package. Existing imports and
 * v1 signed/encrypted data remain supported. KithMoot ownership verification
 * stays in this adapter. */
import { ContextVault as PortableContextVault, type ContextVaultOptions as PortableOptions,
  type ContextGrant as PortableGrant, type ContextPolicy as PortablePolicy, type VerifyDelegation } from '@forgesworn/context'
import { verifyAgentOwnership } from './ownership.js'
import type { AgentOwnership } from './types.js'

export type { ContextScope, ContextRole, ContextIdentity, ContextRecord,
  ContextPointer, ContextView } from '@forgesworn/context'
export interface ContextGrant extends Omit<PortableGrant, 'agent'> { agent?: AgentOwnership }
export interface ContextPolicy extends Omit<PortablePolicy, 'grants'> { grants: ContextGrant[] }
export type ContextVaultOptions = Omit<PortableOptions, 'verifyDelegation'>

const verifyDelegation: VerifyDelegation = (proof, options) => {
  if (!proof || typeof proof !== 'object' || (proof as AgentOwnership).agent !== options.agent) return { ok: false }
  return verifyAgentOwnership(proof as AgentOwnership, options)
}

/** Always install the KithMoot verifier; callers cannot replace the room's trust policy. */
export function kithmootContextOptions(options: ContextVaultOptions): PortableOptions {
  return { ...options, verifyDelegation }
}
export class ContextVault extends PortableContextVault {
  constructor(options: ContextVaultOptions) { super(kithmootContextOptions(options)) }
  override grants(collection: string): ContextGrant[] { return super.grants(collection) as ContextGrant[] }
}
