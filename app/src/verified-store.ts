/**
 * Who this browser has looked at, listened to, and agreed is themselves.
 *
 * `src/verification.ts` says what the words are and how a participant is
 * judged; this is the memory that judgement reads. It is per browser and
 * per person, never published and never sent anywhere: verifying somebody
 * is a statement about what you saw, and it is not evidence to anybody else.
 *
 * Kept deliberately small. A participant key, the name they were using, and
 * when. No room id: a person you verified in one room is the same person in
 * another, and scoping this per room would make the check useless exactly
 * where it matters - the first time somebody turns up somewhere new.
 *
 * Pure functions over the same injected `DeviceStore` the rooms list uses,
 * so the rules are tested with no browser.
 */
import { sanitiseDisplayName } from '../../src/display-name.js'
import { verificationStatus, type KnownParticipant, type VerificationView } from '../../src/verification.js'
import type { DeviceStore } from './device-store.js'

export const VERIFIED_PREFIX = 'kithmoot.verified.'

/**
 * How many verifications this browser keeps.
 *
 * A cap so a long-lived browser does not grow this without bound, and a
 * generous one because forgetting a verification silently downgrades
 * somebody to "unknown" - which reads as "new person" rather than
 * "I have forgotten", and is the wrong way for this to fail.
 */
export const MAX_VERIFIED = 500

function keyFor(participant: string): string {
  return VERIFIED_PREFIX + participant.toLowerCase()
}

/** Everything this browser has verified, newest first. */
export function verifiedParticipants(store: DeviceStore): KnownParticipant[] {
  const out: KnownParticipant[] = []
  for (const key of store.keys()) {
    if (!key.startsWith(VERIFIED_PREFIX)) continue
    const raw = store.get(key)
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw) as Partial<KnownParticipant>
      // A hand-edited or half-written entry is dropped rather than trusted:
      // this decides whether somebody is shown as verified, and a malformed
      // record must never be the reason a stranger looks familiar.
      if (typeof parsed.participant !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.participant)) continue
      if (typeof parsed.name !== 'string') continue
      if (typeof parsed.verifiedAt !== 'number' || !Number.isFinite(parsed.verifiedAt)) continue
      out.push({ participant: parsed.participant, name: parsed.name, verifiedAt: parsed.verifiedAt })
    } catch {
      // Same reasoning: unreadable is not verified.
    }
  }
  return out.sort((a, b) => b.verifiedAt - a.verifiedAt)
}

/**
 * Remember that this person is who they say they are.
 *
 * The name is sanitised on the way in, like every other name this app
 * touches, so a hostile one cannot be smuggled in through a record the
 * browser wrote itself.
 */
export function rememberVerified(
  store: DeviceStore,
  participant: string,
  name: string,
  now: number,
): void {
  const key = participant.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('a participant key is 64 hex characters')

  store.set(
    keyFor(key),
    JSON.stringify({
      participant: key,
      // Empty when they typed nothing. verificationStatus never matches on
      // an empty name, so an unnamed person is remembered by key alone
      // rather than colliding with every other unnamed person.
      name: sanitiseDisplayName(name) ?? '',
      verifiedAt: Math.floor(now / 1000),
    } satisfies KnownParticipant),
  )
  prune(store)
}

/** Forget one, for a person who no longer stands behind the check. */
export function forgetVerified(store: DeviceStore, participant: string): void {
  store.remove(keyFor(participant))
}

/** How this participant should be shown, given what this browser remembers. */
export function participantVerification(
  store: DeviceStore,
  participant: string,
  name: string,
): VerificationView {
  return verificationStatus(verifiedParticipants(store), participant, name)
}

/** Drop the oldest once past the cap. */
function prune(store: DeviceStore, max = MAX_VERIFIED): void {
  const all = verifiedParticipants(store)
  for (const entry of all.slice(max)) store.remove(keyFor(entry.participant))
}
