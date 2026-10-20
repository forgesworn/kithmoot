/**
 * What a room switch does to the call this device is on.
 *
 * Nothing a person navigates to ends a call: pressing Leave does. A switch
 * away from the call's room docks it, and the room on screen is then only
 * for reading and writing. Coming back to the call's room undocks it, with
 * no rejoin.
 *
 * - `plain`: no call; the old room closes and the new one opens.
 * - `dock`: on a call in the room on screen, going elsewhere.
 * - `hop`: already docked, from one other room to another.
 * - `undock`: already docked, back to the call's own room.
 */
export type SwitchIntent = 'plain' | 'dock' | 'hop' | 'undock'

export function switchIntent(opts: { onCall: boolean; dockedRoomId?: string; destination: string }): SwitchIntent {
  if (opts.dockedRoomId !== undefined) return opts.destination === opts.dockedRoomId ? 'undock' : 'hop'
  return opts.onCall ? 'dock' : 'plain'
}

/** The dock's one line: where the call is and who is on it with you. */
export function dockSummary(room: string, others: string[]): string {
  if (others.length === 0) return `On a call in ${room}. Just you.`
  const named = others.slice(0, 3).join(', ')
  return `On a call in ${room} with ${named}${others.length > 3 ? ` and ${others.length - 3} more` : ''}.`
}

/** The dock's line: where the call is. The time on it is `callElapsed`, in
 *  its own element so it can change every second without being read out. */
export function dockLabel(room: string): string {
  return `On a call in ${room}`
}

/** How long a call has been going, as a clock: 12:03, or 1:02:03 past the
 *  hour. Never negative, so a clock that is a little behind a call's own
 *  start reads 0:00 rather than a minus sign. */
export function callElapsed(startedAt: number, now: number): string {
  const total = Math.max(0, Math.floor(now - startedAt))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const two = (n: number): string => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${two(minutes)}:${two(seconds)}`
}
