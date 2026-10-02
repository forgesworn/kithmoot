// A conference room: a group room that ends on a fixed date and is wiped
// from relays when it does. Its end rides in the group invitation (`ends`,
// with a NIP-40 expiration) and on every event a member signs for the room;
// see docs/persistent-groups.md. This module is what the app decides about
// one: the choices offered at creation, how the end reads, and when it has
// come.

/** The choices "Ends" offers when a group room is made, in days. Zero is
 *  "Never": an ordinary group that runs until somebody ends it. */
export const CONFERENCE_END_CHOICES: readonly { days: number; label: string }[] = [
  { days: 0, label: 'Never' },
  { days: 1, label: 'After 1 day' },
  { days: 3, label: 'After 3 days' },
  { days: 7, label: 'After 7 days' },
]

/** When a room made now with this choice ends, in unix seconds, or
 *  undefined for "Never" and for anything that is not one of the choices. */
export function conferenceEndsAt(days: number, now: number): number | undefined {
  if (!CONFERENCE_END_CHOICES.some((choice) => choice.days === days && days > 0)) return undefined
  return Math.floor(now) + days * 86_400
}

/** True once a conference room's end has come. Never for a room with no end. */
export function conferenceEnded(endsAt: number | undefined, now: number): boolean {
  return endsAt !== undefined && now >= endsAt
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The end as a person reads it, in this device's local time:
 *  `Sat 4 Oct, 18:00`. Spelt out rather than left to `Intl`, so it reads the
 *  same in every browser and in the Android app. */
export function formatConferenceEnd(endsAt: number): string {
  const at = new Date(endsAt * 1000)
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  return `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}, ${hh}:${mm}`
}

/** The room header's line for a conference room. */
export function conferenceEndsLine(endsAt: number): string {
  return `Ends ${formatConferenceEnd(endsAt)}`
}

/** What a join link says once its conference room has ended. */
export function conferenceEndedMessage(endsAt: number): string {
  return `This conference room ended on ${formatConferenceEnd(endsAt)}.`
}

/** Prefix of `conferenceEndedMessage`, for recognising one as it comes back
 *  through an error. */
export const CONFERENCE_ENDED_PREFIX = 'This conference room ended on '
