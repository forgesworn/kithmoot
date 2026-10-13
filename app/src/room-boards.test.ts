import {describe, it, expect, vi} from 'vitest'
import {RoomBoards} from './room-boards.js'
import {memoryDeviceStore} from './device-store.js'
import {localSelfCrypt} from '../../src/read-position.js'
import {encodeRoomBoard, ROOM_BOARDS_CHANNEL} from '../../src/room-boards.js'
import type {RoomSession} from '../../src/session.js'
import type {ChatMessage} from '../../src/chat.js'

const board = {boardId: 'shared-board', name: 'Room delivery', invitation: `https://girnel.test/app/#${'a'.repeat(100)}`}
function fixture(store = memoryDeviceStore()) {
  let messages: ChatMessage[] = [], receive: (() => void) | undefined, admitted = true
  const sent: string[] = []
  const send = vi.fn(async (text: string) => {sent.push(text)})
  const chatSend = vi.fn(async (_text: string) => {})
  const s = {roomId: 'room-a', participant: 'a'.repeat(64), chat: {send: chatSend}, channel: (name: string) => {
    expect(name).toBe(ROOM_BOARDS_CHANNEL)
    return {send, messages: () => messages, onChange: (callback: () => void) => {receive = callback; return () => {receive = undefined}}}
  }} as unknown as RoomSession
  const catalog = new RoomBoards(s, {account: s.participant, store,
    crypt: localSelfCrypt(new Uint8Array(32).fill(1)), current: () => admitted, changed: vi.fn(), report: vi.fn()})
  return {catalog, sent, send, chatSend, store, revoke: () => {admitted = false}, receive: (text: string, peer = 'b'.repeat(64)) => {
    messages.push({id: String(messages.length), text, participant: peer, sentAt: Date.now() / 1000} as ChatMessage); receive?.()
  }}
}
describe('room board discovery', () => {
  it('retries the visible chat link after catalogue publication succeeded but the announcement failed', async () => {
    const f = fixture(); await f.catalog.open()
    f.chatSend.mockRejectedValueOnce(new Error('chat refused'))
    await expect(f.catalog.share(board)).rejects.toThrow('chat refused')
    f.receive(encodeRoomBoard(board))
    await f.catalog.share(board)
    expect(f.chatSend).toHaveBeenCalledTimes(2)
    expect(f.chatSend).toHaveBeenLastCalledWith(`Shared board: Room delivery\nhttps://girnel.app/app/#${'a'.repeat(100)}`)
    f.catalog.close()
  })
  it('retains an encrypted catalogue past chat retention and carries it to a late member', async () => {
    const first = fixture(); await first.catalog.open(); await first.catalog.share(board)
    await vi.waitFor(() => expect(first.store.keys()).toHaveLength(1))
    const encrypted = first.store.get(first.store.keys()[0]!)!
    expect(encrypted).not.toContain(board.invitation); expect(encrypted).not.toContain(board.name)
    first.catalog.close()
    const restored = fixture(first.store); await restored.catalog.open()
    expect(restored.catalog.boards).toEqual([board])
    restored.receive(encodeRoomBoard())
    await vi.waitFor(() => expect(restored.sent).toContain(encodeRoomBoard(board)))
    restored.catalog.close()
  })
  it('does not report sharing after a refused publication and stops acting after account change', async () => {
    const f = fixture(); await f.catalog.open(); f.send.mockRejectedValueOnce(new Error('refused'))
    await expect(f.catalog.share(board)).rejects.toThrow('refused')
    expect(f.catalog.boards).toEqual([])
    f.revoke(); f.receive(encodeRoomBoard(board))
    expect(f.catalog.boards).toEqual([])
    await expect(f.catalog.share(board)).rejects.toThrow('Join the linked chat')
    f.catalog.close()
  })
  it('ignores routes without a membership capability and isolates another room', async () => {
    const f = fixture(); await f.catalog.open()
    f.receive(JSON.stringify({type: 'kithmoot.boards.v1', op: 'share', board: {...board, invitation: 'https://girnel.test/app/#/b/shared-board'}}))
    expect(f.catalog.boards).toEqual([])
    f.receive(encodeRoomBoard(board)); expect(f.catalog.boards).toEqual([board])
    f.catalog.close()
  })
})
