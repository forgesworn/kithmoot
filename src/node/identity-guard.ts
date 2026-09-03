import { nip19 } from 'nostr-tools'
import { normaliseHex } from '../hex.js'

/**
 * Refuse to run as the wrong key.
 *
 * An agent's identity is decided by a file path, an environment variable and
 * a default that quietly mints a fresh key when the file is missing. Every
 * one of those can be wrong in a way that *works*: the process starts, joins,
 * chats, and signs - as somebody else. Nothing downstream notices, because
 * from the protocol's side a key is a key.
 *
 * On 3 September 2026 that cost a day. An agent ran with a correct room key
 * while its separately-configured tooling was authenticated as its owner's
 * *principal* key, and the only way anybody found out was by asking the agent
 * in chat what its own npub was - which it answered wrongly and with
 * complete confidence, because its tool told it so.
 *
 * So there are two assertions here, and they are cheap:
 *
 *   expect  - this had better be the key I think it is.
 *   forbid  - this had better not be one of these keys, ever.
 *
 * `forbid` is the important one. `clerks/secrets/README.md` has a rule -
 * "Never a principal's key, in any form" - which until now was enforced by
 * nothing but care. A principal's key on an agent collapses the whole
 * ownership model: an agent that *is* its principal can attest that it
 * belongs to itself, and can approve its own requests, because the approval
 * rule counts "the agent's verified principal" and that is now the same key.
 *
 * Both take an npub or hex, because an operator has whichever is to hand and
 * making them convert it by eye is how the wrong 64 characters get pasted.
 */

/**
 * An npub or 64-hex pubkey, as lowercase hex.
 *
 * Throws with the offending value rather than returning undefined: every
 * caller here is validating an operator's input at startup, and the only
 * useful response to a malformed key is to stop and say which one.
 */
export function resolveKeyRef(ref: string, what = 'key'): string {
  const trimmed = ref.trim()
  if (!trimmed) throw new Error(`${what} is empty`)

  // An nsec where a pubkey belongs is worth its own message. It is a
  // plausible slip - they sit next to each other in a config - and the
  // generic "not 64 hex" would send somebody looking for a typo instead of
  // for the secret they have just put on a command line.
  if (trimmed.toLowerCase().startsWith('nsec1')) {
    throw new Error(
      `${what} looks like an nsec. This wants a PUBLIC key: an npub or 64 hex characters. ` +
        'Treat that secret as exposed - it has been on a command line, and probably in a shell history.',
    )
  }

  // Hex is tested BEFORE bech32, not after. The bech32 data charset and hex
  // overlap enough that a string like "deadface1ccc..." satisfies a
  // bech32-shaped pattern, and testing that first would reject a perfectly
  // good pubkey as an undecodable npub.
  const hex = normaliseHex(trimmed)
  if (/^[0-9a-f]{64}$/.test(hex)) return hex

  // Any nip19 entity, so an operator who pastes an nprofile or a note is
  // told what they actually pasted rather than "not 64 hex characters".
  if (/^[a-z]{1,10}1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/.test(trimmed.toLowerCase())) {
    let decoded
    try {
      decoded = nip19.decode(trimmed)
    } catch {
      throw new Error(`${what} "${trimmed}" is not a decodable npub`)
    }
    if (decoded.type === 'npub') return decoded.data
    throw new Error(`${what} "${trimmed}" is a ${decoded.type}, not an npub`)
  }

  throw new Error(`${what} "${trimmed}" is neither an npub nor 64 hex characters`)
}

export interface IdentityCheck {
  /** The key this process has actually resolved for itself, as hex. */
  pubkey: string
  /** Refuse unless the key is this one. npub or hex. */
  expect?: string | undefined
  /** Refuse if the key is any of these. npub or hex. */
  forbid?: readonly string[] | undefined
}

/**
 * Throws unless the resolved key is allowed to run.
 *
 * Ordered so the most alarming answer comes first: being a forbidden key is a
 * different kind of problem from being the wrong one, and an operator who
 * has hit both wants to hear about the principal key.
 */
export function checkIdentity({ pubkey, expect, forbid }: IdentityCheck): void {
  const mine = resolveKeyRef(pubkey, 'resolved identity')

  for (const ref of forbid ?? []) {
    if (resolveKeyRef(ref, '--forbid-pubkey') !== mine) continue
    throw new Error(
      `refusing to run: this agent resolved to ${nip19.npubEncode(mine)}, which is on its own ` +
        'forbidden list. That list is for principals - a person\'s key, never an agent\'s. An agent ' +
        'holding it can attest that it belongs to itself and approve its own requests, because it *is* ' +
        'the principal those checks look for. Point --identity at the agent\'s own key.',
    )
  }

  if (expect === undefined) return
  const wanted = resolveKeyRef(expect, '--expect-pubkey')
  if (wanted === mine) return
  throw new Error(
    `refusing to run: expected ${nip19.npubEncode(wanted)} but resolved ${nip19.npubEncode(mine)}. ` +
      'The identity this process loaded is not the one it was told to be. Check --identity and ' +
      'KITHMOOT_IDENTITY: a named key file that does not exist is created with a FRESH key rather ' +
      'than failing, which is the usual way this happens.',
  )
}

/** `npub…` for logging. Never throws - a banner must not be the thing that
 *  takes a process down. */
export function npubOrHex(pubkey: string): string {
  try {
    return nip19.npubEncode(resolveKeyRef(pubkey))
  } catch {
    return pubkey
  }
}
