import { afterEach, describe, expect, it } from 'vitest'
import { RoomTabs } from './room-tabs.js'

const ROOM = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const open: RoomTabs[] = []
afterEach(() => { for (const tabs of open.splice(0)) tabs.close() })

function tab(room: string | undefined, leave: (roomId: string) => Promise<void> = async () => {}) {
  let current = room
  const tabs = new RoomTabs(() => current, async roomId => { await leave(roomId); current = undefined }, new BroadcastChannel('kithmoot.room-tabs.test'))
  open.push(tabs)
  return { tabs, current: () => current }
}

describe('other tabs in the same room', () => {
  it('with no other tab in the room there is nothing to wait for', async () => {
    const me = tab(ROOM)
    tab(OTHER)
    expect(await me.tabs.leaveOthers(ROOM, 50, 200)).toBe(true)
  })

  it('every other tab in the room leaves and says so; tabs elsewhere stay', async () => {
    const me = tab(ROOM)
    const second = tab(ROOM)
    const third = tab(ROOM)
    const elsewhere = tab(OTHER)
    expect(await me.tabs.leaveOthers(ROOM, 50, 500)).toBe(true)
    expect(second.current()).toBeUndefined()
    expect(third.current()).toBeUndefined()
    expect(elsewhere.current()).toBe(OTHER)
    expect(me.current()).toBe(ROOM)
  })

  it('a tab that answers but does not finish leaving in time makes it refuse', async () => {
    const me = tab(ROOM)
    tab(ROOM, () => new Promise(resolve => setTimeout(resolve, 400)))
    expect(await me.tabs.leaveOthers(ROOM, 50, 100)).toBe(false)
  })
})
