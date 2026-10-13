import { describe, expect, it } from 'vitest'
import { memoryDeviceStore } from './device-store.js'
import { boardContextTitle, listBoardContexts, readBoardContext, saveBoardContext } from './board-context.js'

describe('board window context', () => {
  it('retains distinct stable project/chat bindings and readable window labels', () => {
    const store = memoryDeviceStore(), account = 'a'.repeat(64)
    const one = {boardId: 'board-1', boardName: 'Release', project: {id: 'shared:owner-1:project-1', name: 'Website'}, room: {id: 'chat-1', name: 'Design'}}
    const two = {...one, boardId: 'board-2', project: {id: 'shared:owner-2:project-1', name: 'Website'}, room: {id: 'chat-2', name: 'Research'}}
    saveBoardContext(store, account, one); saveBoardContext(store, account, two)
    expect(boardContextTitle(readBoardContext(store, account, one.boardId)!)).toBe('KithMoot · Website · Design · Release')
    expect(readBoardContext(store, account, two.boardId)?.room?.id).toBe('chat-2')
    expect(readBoardContext(store, 'b'.repeat(64), one.boardId)).toBeUndefined()
  })
  it('stores navigation metadata only and refuses malformed board identities', () => {
    const store = memoryDeviceStore(), account = 'a'.repeat(64)
    saveBoardContext(store, account, {boardId: 'board-1', boardName: 'Release', cardId: 'private-card', secret: 'private-key', link: 'bearer-invite'} as never)
    const raw = store.get(store.keys()[0]!)!
    expect(raw).not.toContain('private'); expect(raw).not.toContain('bearer')
    expect(() => saveBoardContext(store, account, {boardId: '../room', boardName: 'bad'})).toThrow()
  })
  it('lists only the current account’s saved boards and skips corrupt entries', () => {
    const store = memoryDeviceStore(), account = 'a'.repeat(64)
    saveBoardContext(store, account, {boardId: 'two', boardName: 'Zulu', room: {id: 'room', name: 'Chat'}})
    saveBoardContext(store, account, {boardId: 'one', boardName: 'Alpha'})
    saveBoardContext(store, 'b'.repeat(64), {boardId: 'private', boardName: 'Other account'})
    store.set(`kithmoot.board-context.v1.${account}.bad`, '{broken')
    expect(listBoardContexts(store, account).map(board => board.boardName)).toEqual(['Alpha', 'Zulu'])
    expect(listBoardContexts(store, 'invalid')).toEqual([])
  })
})
