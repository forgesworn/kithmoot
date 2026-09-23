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
