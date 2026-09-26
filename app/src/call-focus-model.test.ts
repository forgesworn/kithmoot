import { describe, expect, test } from 'vitest'
import {
  CALL_FIRST_MIN_HEIGHT, CALL_FIRST_MIN_WIDTH, CHAT_DIVIDER_KEY, CHAT_OPEN_MIN_WIDTH, CHAT_PANEL_KEY, UnreadCounter,
  callFirst, chatPanelOpen, clearChatDividerFraction, loadChatDividerFraction, loadChatPanel,
  saveChatDividerFraction, saveChatPanel, toolbarMove, unreadAnnouncement,
  type CallFirstInput,
} from './call-focus-model.js'

const onALaptop: CallFirstInput = { width: 1440, height: 900, onCall: true, docked: false, pane: 'live' }

describe('callFirst', () => {
  test('a wide window on a call with pictures puts the call first', () => {
    expect(callFirst(onALaptop)).toBe(true)
    expect(callFirst({ ...onALaptop, width: CALL_FIRST_MIN_WIDTH, height: CALL_FIRST_MIN_HEIGHT })).toBe(true)
  })

  test('not while this device is off the call, even with a call on in the room', () => {
    expect(callFirst({ ...onALaptop, onCall: false })).toBe(false)
  })

  test('not while the call is docked and another room is on screen', () => {
    expect(callFirst({ ...onALaptop, docked: true })).toBe(false)
  })

  test('a voice call keeps its strip, and no call keeps the resting pane', () => {
    expect(callFirst({ ...onALaptop, pane: 'controls' })).toBe(false)
    expect(callFirst({ ...onALaptop, pane: 'resting' })).toBe(false)
    expect(callFirst({ ...onALaptop, pane: undefined })).toBe(false)
  })

  test('phones and short landscape windows keep their own layout', () => {
    expect(callFirst({ ...onALaptop, width: CALL_FIRST_MIN_WIDTH - 1 })).toBe(false)
    expect(callFirst({ ...onALaptop, width: 390, height: 844 })).toBe(false)
    expect(callFirst({ ...onALaptop, width: 1000, height: 500 })).toBe(false)
    expect(callFirst({ ...onALaptop, height: CALL_FIRST_MIN_HEIGHT - 1 })).toBe(false)
  })
})

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) },
  }
}

describe('the chat panel, remembered', () => {
  test('open by default from 1280px, closed below', () => {
    expect(chatPanelOpen(undefined, CHAT_OPEN_MIN_WIDTH)).toBe(true)
    expect(chatPanelOpen(undefined, 1440)).toBe(true)
    expect(chatPanelOpen(undefined, CHAT_OPEN_MIN_WIDTH - 1)).toBe(false)
    expect(chatPanelOpen(undefined, 1000)).toBe(false)
  })

  test("this device's own answer wins at any width", () => {
    expect(chatPanelOpen(false, 1920)).toBe(false)
    expect(chatPanelOpen(true, 960)).toBe(true)
  })

  test('saved and read back under a kithmoot.call- key', () => {
    const storage = memory()
    expect(loadChatPanel(storage)).toBeUndefined()
    saveChatPanel(storage, false)
    expect(CHAT_PANEL_KEY.startsWith('kithmoot.call-')).toBe(true)
    expect(storage.data.get(CHAT_PANEL_KEY)).toBe('closed')
    expect(loadChatPanel(storage)).toBe(false)
    saveChatPanel(storage, true)
    expect(loadChatPanel(storage)).toBe(true)
  })

  test('nonsense or a storage that throws reads as never said', () => {
    expect(loadChatPanel(memory({ [CHAT_PANEL_KEY]: 'maybe' }))).toBeUndefined()
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('full') } }
    expect(loadChatPanel(broken)).toBeUndefined()
    expect(() => saveChatPanel(broken, true)).not.toThrow()
  })
})

describe('the divider between the call and the conversation, remembered', () => {
  test('nothing stored until this device drags it', () => {
    expect(loadChatDividerFraction(memory())).toBeUndefined()
  })

  test('saved and read back as a fraction, under a kithmoot.call- key', () => {
    const storage = memory()
    saveChatDividerFraction(storage, 0.4)
    expect(CHAT_DIVIDER_KEY.startsWith('kithmoot.call-')).toBe(true)
    expect(storage.data.get(CHAT_DIVIDER_KEY)).toBe('0.4')
    expect(loadChatDividerFraction(storage)).toBe(0.4)
  })

  test('a reset forgets it', () => {
    const storage = memory({ [CHAT_DIVIDER_KEY]: '0.4' })
    clearChatDividerFraction(storage)
    expect(storage.data.has(CHAT_DIVIDER_KEY)).toBe(false)
  })

  test('nonsense, an out-of-range value, or a storage that throws reads as never dragged', () => {
    expect(loadChatDividerFraction(memory({ [CHAT_DIVIDER_KEY]: 'plenty' }))).toBeUndefined()
    expect(loadChatDividerFraction(memory({ [CHAT_DIVIDER_KEY]: '0' }))).toBeUndefined()
    expect(loadChatDividerFraction(memory({ [CHAT_DIVIDER_KEY]: '1' }))).toBeUndefined()
    expect(loadChatDividerFraction(memory({ [CHAT_DIVIDER_KEY]: '1.5' }))).toBeUndefined()
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('full') }, removeItem: () => { throw new Error('denied') } }
    expect(loadChatDividerFraction(broken)).toBeUndefined()
    expect(() => saveChatDividerFraction(broken, 0.3)).not.toThrow()
    expect(() => clearChatDividerFraction(broken)).not.toThrow()
  })
})

describe('UnreadCounter', () => {
  test('what was already there is not news', () => {
    const unread = new UnreadCounter()
    expect(unread.update('room|main', ['a', 'b', 'c'], false)).toBe(0)
  })

  test('counts new messages while the panel is closed, once each', () => {
    const unread = new UnreadCounter()
    unread.update('room|main', ['a'], false)
    expect(unread.update('room|main', ['a', 'b'], false)).toBe(1)
    // A redraw with the same messages is not another message.
    expect(unread.update('room|main', ['a', 'b'], false)).toBe(1)
    expect(unread.update('room|main', ['a', 'b', 'c', 'd'], false)).toBe(3)
    expect(unread.count).toBe(3)
  })

  test('nothing is unread while the panel is open, and opening it reads everything', () => {
    const unread = new UnreadCounter()
    unread.update('room|main', ['a'], true)
    expect(unread.update('room|main', ['a', 'b'], true)).toBe(0)
    expect(unread.update('room|main', ['a', 'b', 'c'], false)).toBe(1)
    expect(unread.read()).toBe(0)
    expect(unread.update('room|main', ['a', 'b', 'c'], false)).toBe(0)
    expect(unread.update('room|main', ['a', 'b', 'c', 'd'], false)).toBe(1)
  })

  test('a message that scrolled out of the history and back is not counted twice', () => {
    const unread = new UnreadCounter()
    unread.update('room|main', ['a', 'b'], false)
    unread.update('room|main', ['b'], false)
    expect(unread.update('room|main', ['a', 'b'], false)).toBe(0)
  })

  test('another room or conversation starts again from what it already holds', () => {
    const unread = new UnreadCounter()
    unread.update('room|main', ['a'], false)
    unread.update('room|main', ['a', 'b'], false)
    expect(unread.update('other|main', ['x', 'y'], false)).toBe(0)
    unread.reset()
    expect(unread.update('other|main', ['x', 'y', 'z'], false)).toBe(0)
  })

  test('splits how many of the count are an agent’s, for the badge beside the people one', () => {
    const unread = new UnreadCounter()
    unread.update('room|main', ['a'], false)
    expect(unread.update('room|main', ['a', 'b', 'c'], false, ['b'])).toBe(2)
    expect(unread.agents).toBe(1)
    // Opening the panel reads both.
    expect(unread.read()).toBe(0)
    expect(unread.agents).toBe(0)
  })
})

describe('unreadAnnouncement', () => {
  test('says nothing for nothing, and counts in words a person would say', () => {
    expect(unreadAnnouncement(0)).toBe('')
    expect(unreadAnnouncement(1)).toBe('1 new message in the chat')
    expect(unreadAnnouncement(4)).toBe('4 new messages in the chat')
  })
})

describe('toolbarMove', () => {
  test('arrows move one along and wrap at both ends', () => {
    expect(toolbarMove('ArrowRight', 0, 4)).toBe(1)
    expect(toolbarMove('ArrowRight', 3, 4)).toBe(0)
    expect(toolbarMove('ArrowLeft', 0, 4)).toBe(3)
    expect(toolbarMove('ArrowLeft', 2, 4)).toBe(1)
  })

  test('Home and End go to the ends', () => {
    expect(toolbarMove('Home', 2, 4)).toBe(0)
    expect(toolbarMove('End', 0, 4)).toBe(3)
  })

  test('other keys, and an empty bar, are left alone', () => {
    expect(toolbarMove('ArrowUp', 1, 4)).toBeUndefined()
    expect(toolbarMove('Enter', 1, 4)).toBeUndefined()
    expect(toolbarMove('ArrowRight', 0, 0)).toBeUndefined()
  })
})
