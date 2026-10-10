import { describe, expect, it } from 'vitest'
import { activityAt, formatActivityTime, presenceText, previewLine, sortByActivity } from './room-row.js'

describe('activityAt / sortByActivity', () => {
  it('sorts by newest activity, newest first', () => {
    const rooms = [
      { roomId: 'a', openedAt: 100 },
      { roomId: 'b', openedAt: 300 },
      { roomId: 'c', openedAt: 200 },
    ]
    const messages = new Map([['a', [{ sentAt: 500 }]], ['b', []], ['c', [{ sentAt: 150 }]]])
    const activityOf = (room: typeof rooms[number]) => activityAt(room, messages.get(room.roomId) ?? [])
    expect(sortByActivity(rooms, activityOf).map((r) => r.roomId)).toEqual(['a', 'c', 'b'])
  })

  it('does not invent activity from opening a room with no readable history', () => {
    expect(activityAt({ openedAt: 42 }, [])).toBe(0)
    expect(formatActivityTime(0)).toBe('')
  })

  it('reading an older conversation changes neither its time nor its position', () => {
    const messages = new Map([['old', [{ sentAt: 100 }]], ['new', [{ sentAt: 200 }]]])
    const before = [{ roomId: 'old', openedAt: 80 }, { roomId: 'new', openedAt: 90 }]
    const after = before.map(room => room.roomId === 'old' ? { ...room, openedAt: 300 } : room)
    const activity = (room: typeof before[number]) => activityAt(room, messages.get(room.roomId)!)
    expect(sortByActivity(after, activity).map(room => room.roomId)).toEqual(sortByActivity(before, activity).map(room => room.roomId))
    expect(activity(after[0])).toBe(100)
    expect(sortByActivity(after, activity).map(room => room.roomId)).toEqual(['new', 'old'])
    messages.get('old')!.push({ sentAt: 400 })
    expect(sortByActivity(after, activity).map(room => room.roomId)).toEqual(['old', 'new'])
  })

  it('keeps equal or unknown activity stable when saved-room read order changes', () => {
    const rooms = [{ roomId: 'b', openedAt: 100 }, { roomId: 'a', openedAt: 200 }]
    expect(sortByActivity(rooms, room => activityAt(room, [])).map(room => room.roomId)).toEqual(['a', 'b'])
    expect(sortByActivity([...rooms].reverse(), room => activityAt(room, [])).map(room => room.roomId)).toEqual(['a', 'b'])
  })
})

describe('formatActivityTime', () => {
  // Local time throughout, since toLocaleTimeString/toLocaleDateString read
  // the machine's own zone - a Wednesday, well inside a month with a
  // short-form day.
  const local = (year: number, month: number, day: number, hour: number, minute: number, second: number) =>
    new Date(year, month, day, hour, minute, second).getTime() / 1000
  const now = local(2026, 8, 23, 15, 0, 0) // 23 Sept 2026, 15:00

  it('shows the clock time for today', () => {
    expect(formatActivityTime(local(2026, 8, 23, 14, 2, 0), now)).toBe('14:02')
  })

  it('shows Yesterday for one day back', () => {
    expect(formatActivityTime(local(2026, 8, 22, 9, 0, 0), now)).toBe('Yesterday')
  })

  it('shows a short weekday out to six days back', () => {
    expect(formatActivityTime(local(2026, 8, 20, 9, 0, 0), now)).toBe('Sun')
  })

  it('shows day and short month older than six days', () => {
    expect(formatActivityTime(local(2026, 7, 24, 9, 0, 0), now)).toBe('24 Aug')
  })
})

describe('previewLine', () => {
  const nameOf = (participant: string) => (participant === 'rowan' ? 'Rowan' : participant)

  it('reads "You: …" for your own message', () => {
    expect(previewLine({ participant: 'me', text: 'On my way' }, 'me', nameOf)).toBe('You: On my way')
  })

  it('reads "{Name}: …" for somebody else\'s message', () => {
    expect(previewLine({ participant: 'rowan', text: 'On my way, ten minutes' }, 'me', nameOf))
      .toBe('Rowan: On my way, ten minutes')
  })

  it('reads "{Name} sent a file" for a file with no caption', () => {
    expect(previewLine({ participant: 'rowan', text: '', attachments: [{}] }, 'me', nameOf))
      .toBe('Rowan sent a file')
  })

  it('is undefined with no message to preview', () => {
    expect(previewLine(undefined, 'me', nameOf)).toBeUndefined()
  })
})

describe('presenceText', () => {
  it('speaks one person', () => {
    expect(presenceText([{ agent: false }])).toEqual({ visible: '1 here', spoken: '1 person here' })
  })

  it('speaks people and agents together', () => {
    expect(presenceText([{ agent: false }, { agent: false }, { agent: true }]))
      .toEqual({ visible: '3 here', spoken: '2 people and 1 agent here' })
  })

  it('speaks nobody here for an empty room', () => {
    expect(presenceText([])).toEqual({ visible: '0 here', spoken: 'nobody here' })
  })
})
