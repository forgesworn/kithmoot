import { ASSIGNMENT_CHANNEL } from './assignments.js'
import { CONTROL_CHANNEL } from './control.js'
import { ROOM_BOARD_CHANNEL } from './room-board-wire.js'
import { ROOM_BOARDS_CHANNEL } from './room-boards.js'

/**
 * Streams the room already keeps under a channel name of its own: its
 * control messages, its tasks, its board and the list of boards shared with
 * it before 25 November 2026.
 *
 * A channel is derived from its name and nothing else, so a channel opened
 * with one of these names would be the same stream, read as conversation.
 * Fold-kit's `RESERVED_CHANNELS` (agents, minutes, transcript) are refused
 * everywhere, a signed list included. These are refused only when somebody
 * asks to open one: a room whose list already holds one keeps loading it,
 * and it can still be closed.
 */
export const ROOM_STREAMS: readonly string[] = [CONTROL_CHANNEL, ASSIGNMENT_CHANNEL, ROOM_BOARD_CHANNEL, ROOM_BOARDS_CHANNEL]

/** Whether a channel of this name may not be opened, because the room already keeps a stream under it. */
export function roomStreamName(name: string): boolean {
  return ROOM_STREAMS.includes(name.trim().toLowerCase())
}
