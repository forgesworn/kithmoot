import { describe, expect, it } from 'vitest'
import { arrangeRooms, loadPins, setPinned } from './room-pins.js'

function memory(): Pick<Storage, 'getItem' | 'setItem'> {
  const data = new Map<string, string>()
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) } }
}

const id = (n: number): string => n.toString(16).padStart(64, '0')
const room = (n: number, at: number) => ({ roomId: id(n), at })
const activity = (r: { at: number }): number => r.at

describe('pinned rooms', () => {
  it('remembers pins on this device, and forgets them on unpinning', () => {
    const storage = memory()
    expect(loadPins(storage).size).toBe(0)
    setPinned(storage, id(1), true)
    setPinned(storage, id(2), true)
    expect([...loadPins(storage)].sort()).toEqual([id(1), id(2)])
    setPinned(storage, id(1), false)
    expect([...loadPins(storage)]).toEqual([id(2)])
  })

  it('pins nothing from storage it cannot read', () => {
    expect(loadPins({ getItem: () => '{not json' }).size).toBe(0)
    expect(loadPins({ getItem: () => JSON.stringify(['short', 7, id(3)]) })).toEqual(new Set([id(3)]))
    expect(loadPins({ getItem: () => { throw new Error('denied') } }).size).toBe(0)
  })

  it('puts pinned rooms first, each section newest first', () => {
    const rooms = [room(1, 10), room(2, 50), room(3, 30), room(4, 40), room(5, 20)]
    const { pinned, rest } = arrangeRooms(rooms, new Set([id(1), id(3), id(5)]), activity)
    expect(pinned.map(r => r.roomId)).toEqual([id(3), id(5), id(1)])
    expect(rest.map(r => r.roomId)).toEqual([id(2), id(4)])
  })

  it('reorders pinned rooms by activity rather than freezing them', () => {
    const pins = new Set([id(1), id(2)])
    expect(arrangeRooms([room(1, 10), room(2, 20)], pins, activity).pinned.map(r => r.roomId)).toEqual([id(2), id(1)])
    expect(arrangeRooms([room(1, 30), room(2, 20)], pins, activity).pinned.map(r => r.roomId)).toEqual([id(1), id(2)])
  })

  it('holds the shown order while the person is in the rail, newcomers after', () => {
    const held = [id(1), id(2)]
    const { rest } = arrangeRooms([room(1, 10), room(2, 50), room(3, 90)], new Set(), activity, held)
    expect(rest.map(r => r.roomId)).toEqual([id(1), id(2), id(3)])
  })

  it('moves a room between sections at once, held or not', () => {
    const held = [id(1), id(2)]
    const { pinned, rest } = arrangeRooms([room(1, 10), room(2, 50)], new Set([id(2)]), activity, held)
    expect(pinned.map(r => r.roomId)).toEqual([id(2)])
    expect(rest.map(r => r.roomId)).toEqual([id(1)])
  })
})
