import { sanitiseDisplayName } from './display-name.js'
import { MAX_CHAT_TEXT_LENGTH } from './chat.js'

/** Authenticated, room-encrypted catalogue. Its invitations confer board
 * membership, so never place them in public URLs or navigation storage. Agents
 * may read this channel on the same terms as other admitted room members. */
export const ROOM_BOARDS_CHANNEL = 'boards'
export interface RoomBoard { boardId: string; name: string; invitation: string }
export type RoomBoardMessage = {type: 'kithmoot.boards.v1'; op: 'list'} |
  {type: 'kithmoot.boards.v1'; op: 'share'; board: RoomBoard}
export function decodeRoomBoard(text: string): RoomBoardMessage | undefined {
  if (text.length > MAX_CHAT_TEXT_LENGTH) return
  try {
    const value = JSON.parse(text)
    if (value.type !== 'kithmoot.boards.v1') return
    if (value.op === 'list') return {type: value.type, op: 'list'}
    const board = value.board
    if (value.op !== 'share' || !board || typeof board.boardId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,160}$/.test(board.boardId) || typeof board.name !== 'string' ||
      typeof board.invitation !== 'string') return
    const url = new URL(board.invitation)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      !/^#[A-Za-z0-9_-]{40,}$/.test(url.hash)) return
    return {type: value.type, op: 'share', board: {boardId: board.boardId,
      name: sanitiseDisplayName(board.name) ?? 'Untitled board', invitation: url.href}}
  } catch {return}
}
export function encodeRoomBoard(board?: RoomBoard): string {
  const text = JSON.stringify(board ? {type: 'kithmoot.boards.v1', op: 'share', board} : {type: 'kithmoot.boards.v1', op: 'list'})
  if (!decodeRoomBoard(text)) throw new Error('The board invitation cannot be shared in this chat.')
  return text
}
