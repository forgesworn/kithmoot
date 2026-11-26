import type { RoomBoardStatus } from './room-board-sync.js'

/** Where the board stands, in the words the room shows beside it, and as one
 *  of three states: on the web, the line over the board; on a page with no
 *  bar of the room's around it, the view's own. */
export function roomBoardStatusWords(status: RoomBoardStatus): { state: 'held' | 'busy' | 'shared'; words: string } {
  if (status.error) return { state: 'held', words: `${status.error}. Your changes are kept on this device and sent when they can be.` }
  if (!status.ready) return { state: 'busy', words: 'Reading the room’s board…' }
  if (status.pending) return { state: 'busy', words: 'Sending your changes to the room…' }
  return { state: 'shared', words: 'Shared with everyone in this room.' }
}
