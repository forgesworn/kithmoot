import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { getPublicKey } from 'nostr-tools/pure'
import { hexEquals, normaliseHex } from './hex.js'
import { sanitiseDisplayName } from './display-name.js'
import type { AgentOwnership } from './types.js'

/**
 * Whose agent is this.
 *
 * The roster's `agent` flag is self-declared: it says what a participant
 * claims to be, and nothing checks it. What a person in a room wants to
 * know next is who the agent acts for, and that is not something the agent
 * can claim about itself - it is something its principal has to say. So an
 * ownership proof is signed by the principal, over the agent's key, its
 * own, when it said so, until when, and what it calls the agent.
 *
 * Room-independent on purpose. A kindred proof binds to a room because it
 * is an admission grant, and a grant that worked everywhere would be a
 * bearer token. Ownership is a fact about two keys, not about a room, and
 * a principal should be able to attest to it once and have every room the
 * agent walks into read it. The cost, stated plainly: it cannot be revoked
 * except by expiry, so a principal that may change its mind sets one.
 *
 * Verification is the whole of the trust here. A client renders "agent of"
 * only for a proof it has verified itself, and the codecs drop a proof that
 * does not verify before it reaches anybody, so a claim that cannot be
 * checked is never shown as one that was.
 */

const HEX64 = /^[0-9a-f]{64}$/i
/** How far ahead of the verifier's clock a proof may claim to have been
 *  issued. Real clocks disagree by seconds; a proof from next year is a
 *  proof somebody made up. */
const MAX_ISSUED_AHEAD_SECONDS = 300

function message(agent: string, principal: string, issuedAt: number, expiresAt: number | undefined, label: string | undefined): Uint8Array {
  return sha256(
    new TextEncoder().encode(`kithmoot/v1/agent-owner:${agent}:${principal}:${issuedAt}:${expiresAt ?? ''}:${label ?? ''}`),
  )
}

function requireHex32(value: string, what: string): string {
  if (!HEX64.test(value)) throw new Error(`${what} must be 32-byte hex`)
  return normaliseHex(value)
}

export interface IssueAgentOwnershipOptions {
  /** The principal's secret key. The one signature this makes is the only
   *  thing the key is used for here. */
  principalSk: Uint8Array
  /** The agent's participant pubkey. */
  agent: string
  /** Unix seconds. */
  issuedAt: number
  /** Unix seconds. Omit for a proof that stands until the principal makes
   *  a new agent key; set one if you may want it to stop standing. */
  expiresAt?: number
  /** What the principal calls the agent. Sanitised like a display name. */
  label?: string
}

/** Say, as a principal, that an agent is yours. */
export function issueAgentOwnership(opts: IssueAgentOwnershipOptions): AgentOwnership {
  if (opts.principalSk.length !== 32) throw new Error('principal secret key must be 32 bytes')
  const agent = requireHex32(opts.agent, 'agent pubkey')
  const principal = getPublicKey(opts.principalSk)
  if (hexEquals(agent, principal)) throw new Error('an agent cannot be its own principal')
  if (!Number.isSafeInteger(opts.issuedAt) || opts.issuedAt <= 0) throw new Error('issuedAt must be unix seconds')
  if (opts.expiresAt !== undefined) {
    if (!Number.isSafeInteger(opts.expiresAt) || opts.expiresAt <= opts.issuedAt) throw new Error('expiresAt must be unix seconds after issuedAt')
  }
  const label = sanitiseDisplayName(opts.label)
  const sig = bytesToHex(schnorr.sign(message(agent, principal, opts.issuedAt, opts.expiresAt, label), opts.principalSk))
  return {
    agent,
    principal,
    issuedAt: opts.issuedAt,
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
    ...(label !== undefined ? { label } : {}),
    sig,
  }
}

/**
 * The one honest shape of a proof, or null. Shape only: nothing here is
 * verified, and a caller that stops at this has learned nothing about
 * whose agent anything is. Canonicalises the keys, like every boundary.
 */
export function normaliseAgentOwnership(raw: unknown): AgentOwnership | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.agent !== 'string' || !HEX64.test(o.agent)) return null
  if (typeof o.principal !== 'string' || !HEX64.test(o.principal)) return null
  if (typeof o.sig !== 'string' || !/^[0-9a-f]{128}$/i.test(o.sig)) return null
  if (!Number.isSafeInteger(o.issuedAt) || (o.issuedAt as number) <= 0) return null
  const out: AgentOwnership = {
    agent: normaliseHex(o.agent),
    principal: normaliseHex(o.principal),
    issuedAt: o.issuedAt as number,
    sig: normaliseHex(o.sig),
  }
  if (o.expiresAt !== undefined) {
    if (!Number.isSafeInteger(o.expiresAt) || (o.expiresAt as number) <= 0) return null
    out.expiresAt = o.expiresAt as number
  }
  if (o.label !== undefined) {
    // The label is signed as carried, so it is not sanitised here; a label
    // that would need sanitising is refused by `verifyAgentOwnership`.
    if (typeof o.label !== 'string') return null
    out.label = o.label
  }
  return out
}

export type OwnershipVerdict =
  | { ok: true; principal: string; label?: string }
  | { ok: false; reason: string }

export interface VerifyAgentOwnershipOptions {
  /** The participant the proof must name as the agent. */
  agent: string
  /** Unix seconds. */
  now: number
}

/**
 * Check a proof. Cheapest first, signature last, and never throws. A label
 * is required to be already in its sanitised form: the signature covers
 * the bytes as carried, so a label a renderer would have to change is a
 * label the principal did not sign as shown, and is refused rather than
 * shown differently.
 */
export function verifyAgentOwnership(raw: AgentOwnership, opts: VerifyAgentOwnershipOptions): OwnershipVerdict {
  const proof = normaliseAgentOwnership(raw)
  if (!proof) return { ok: false, reason: 'malformed' }
  if (!hexEquals(proof.agent, opts.agent)) return { ok: false, reason: 'names another agent' }
  if (hexEquals(proof.agent, proof.principal)) return { ok: false, reason: 'an agent cannot be its own principal' }
  if (proof.issuedAt > opts.now + MAX_ISSUED_AHEAD_SECONDS) return { ok: false, reason: 'issued in the future' }
  if (proof.expiresAt !== undefined) {
    if (proof.expiresAt <= proof.issuedAt) return { ok: false, reason: 'expires before issued' }
    if (proof.expiresAt <= opts.now) return { ok: false, reason: 'expired' }
  }
  if (proof.label !== undefined && sanitiseDisplayName(proof.label) !== proof.label) return { ok: false, reason: 'label is not as signed' }
  try {
    const ok = schnorr.verify(
      hexToBytes(proof.sig),
      message(proof.agent, proof.principal, proof.issuedAt, proof.expiresAt, proof.label),
      hexToBytes(proof.principal),
    )
    if (!ok) return { ok: false, reason: 'bad signature' }
  } catch {
    return { ok: false, reason: 'bad signature' }
  }
  return { ok: true, principal: proof.principal, ...(proof.label !== undefined ? { label: proof.label } : {}) }
}
