import { deriveDirectionalPair } from 'spoken-token'

/**
 * "Is this really them", asked in the one place it can be answered well.
 *
 * A display name is a claim and nothing checks it - the README says so, and
 * a short pubkey renders beside every name because of it. That is honest but
 * it is not much help: nobody remembers 8 hex characters, and on
 * 3 September 2026 a room watched three participants claim names belonging
 * to somebody else while everybody present read the pubkeys and could not
 * tell.
 *
 * A call is the strongest out-of-band channel anybody gets. You can see the
 * person and hear their voice. So the ritual is Signal's safety numbers,
 * moved into the moment when checking is easy: each side is shown three
 * words, they say them aloud, and they agree or they do not.
 *
 * There are two halves and they defend against different things. Be precise
 * about which is which, because a verification story that overclaims is
 * worse than none.
 *
 *   The words   prove that both clients are looking at the same pair of
 *               participant keys under the same room key. That rules out a
 *               relay or a forwarder having substituted a key on the way
 *               through. It does NOT rule out somebody in the room, who
 *               holds the room key and can compute any pair's words -
 *               including yours. The words are a channel check, not a
 *               secret.
 *
 *   The memory  is what actually catches an impostor. Once you have said
 *               "yes, that is them" while looking at them, the key is
 *               remembered against the name. A later call where a familiar
 *               name arrives on a different key is the attack, and it is
 *               the one thing here that is loud about it.
 *
 * The words are stable rather than time-rotating, deliberately. A ritual
 * whose words change halfway through fails confusingly, and "the same words
 * as last time" is itself worth something. They do move when the room does:
 * they are derived from the room key, so an epoch rekey changes them, which
 * is correct - that is a different room key and a different set of people.
 */

/** HKDF-style namespace, distinct from every other `kithmoot/v1/*` label. */
export const VERIFY_NAMESPACE = 'kithmoot/v1/verify'

/**
 * Stable counter. See the note above on why this does not rotate: the room
 * key already moves on an epoch, which is the rotation that means something.
 */
const VERIFY_COUNTER = 0

/**
 * Three words, not one.
 *
 * The wordlist is 2048 entries, so a word carries 11 bits. One word means a
 * substituted key has a 1-in-2048 chance of producing the same sound, which
 * is not a check - it is a coin toss somebody would go on to describe as
 * "verified". Three words is 33 bits, about one in eight billion, and is
 * still a thing two people can say to each other without losing their place.
 */
const VERIFY_WORDS = 3

export interface VerificationWords {
  /** The words that participant says, space-separated. */
  [pubkey: string]: string
}

/**
 * The words each of two participants says, to check they are looking at the
 * same pair of keys.
 *
 * Directional: the two words differ, so the second speaker cannot pass by
 * repeating what they just heard. Roles are the two pubkeys sorted, so both
 * clients derive the same pair without having to agree who goes first.
 *
 * Throws on a pair that is not two distinct participants - deriving a word
 * for somebody against themselves is meaningless, and returning something
 * plausible for it would put a word on screen that proves nothing.
 */
export function verificationWords(roomKey: Uint8Array, a: string, b: string): VerificationWords {
  if (roomKey.length !== 32) throw new Error('verification needs the 32-byte room key')
  const first = a.toLowerCase()
  const second = b.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(first) || !/^[0-9a-f]{64}$/.test(second)) {
    throw new Error('verification needs two 64-hex participant keys')
  }
  if (first === second) throw new Error('a participant cannot verify against itself')

  const [lo, hi] = first < second ? [first, second] : [second, first]
  // The PAIR goes in the namespace, not just the roles. deriveDirectionalPair
  // builds each token's context from the namespace and that token's role
  // alone, so a namespace naming only the room would give a participant the
  // same word against everybody - "Ada's word", which says nothing about who
  // she is checking against, and would pass against an impostor standing in
  // for anyone. The roles still differ, which is what stops the second
  // speaker parroting the first.
  const namespace = `${VERIFY_NAMESPACE}:${lo}:${hi}`
  const pair = deriveDirectionalPair(roomKey, namespace, [lo, hi], VERIFY_COUNTER, {
    format: 'words',
    count: VERIFY_WORDS,
  })
  return { [lo]: pair[lo]!, [hi]: pair[hi]! }
}

/** What this device remembers about a participant it has verified before. */
export interface KnownParticipant {
  participant: string
  /** The name they were using when verified. Compared case-insensitively,
   *  after the same sanitising every other name goes through. */
  name: string
  /** Unix seconds. Shown to a person, never used for a decision. */
  verifiedAt: number
}

export type VerificationStatus =
  /** Never verified, and no verified key claims this name. */
  | 'unknown'
  /** This exact participant key was verified before. */
  | 'verified'
  /** A key you verified uses this name - and this is not that key. */
  | 'key-changed'

export interface VerificationView {
  status: VerificationStatus
  /** For `verified`, when. For `key-changed`, when the *other* key was
   *  verified, because that is the fact a person needs. */
  verifiedAt?: number
  /** For `key-changed`, the key that was verified under this name. */
  expected?: string
}

/**
 * Judge a participant against what this device has verified before.
 *
 * `key-changed` is the whole point of the function. Everything else is a
 * label; this one is an accusation, and it is the shape the September
 * incident took - a familiar name arriving on an unfamiliar key, in a room
 * where nobody could tell.
 *
 * Name matching is deliberately loose (case-insensitive, trimmed) because an
 * impostor will not reproduce capitalisation exactly and a false "changed"
 * costs a question, while a missed one costs the whole point of the feature.
 */
export function verificationStatus(
  known: readonly KnownParticipant[],
  participant: string,
  name: string,
): VerificationView {
  const key = participant.toLowerCase()
  const mine = known.find((k) => k.participant.toLowerCase() === key)
  if (mine) return { status: 'verified', verifiedAt: mine.verifiedAt }

  const label = name.trim().toLowerCase()
  if (!label) return { status: 'unknown' }

  // The most recently verified holder of this name is the one worth naming:
  // if somebody has legitimately rotated, the newest is what a person
  // remembers agreeing to.
  const claimant = known
    .filter((k) => k.name.trim().toLowerCase() === label)
    .sort((x, y) => y.verifiedAt - x.verifiedAt)[0]

  if (!claimant) return { status: 'unknown' }
  return { status: 'key-changed', verifiedAt: claimant.verifiedAt, expected: claimant.participant }
}
