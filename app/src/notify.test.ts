import { describe, it, expect } from 'vitest'
import { memoryDeviceStore } from './device-store.js'
import {
  HISTORY_GRACE_SECONDS,
  Notifier,
  PREVIEW_LENGTH,
  notificationContent,
  notifySettings,
  setNotifySettings,
  shouldNotify,
  titleWithCount,
} from './notify.js'
import type { NotificationContent } from './notify.js'
import type { ChatMessage } from '../../src/chat.js'

const NOW = 1_800_000_000
const ROOM_A = 'a'.repeat(64)
const ROOM_B = 'b'.repeat(64)
const ME = 'me'.repeat(32)
const ADA = 'ad'.repeat(32)

function message(id: string, participant: string, sentAt: number, text = 'hello'): ChatMessage {
  return { id, participant, device: 'd'.repeat(64), credential: {} as ChatMessage['credential'], name: 'Ada', text, sentAt }
}

describe('when a message is worth a notification', () => {
  const context = { hidden: false, shownRoomId: ROOM_A, self: ME, followedSince: NOW }

  it('never for history: what was said before this device followed the room', () => {
    const old = { roomId: ROOM_A, message: message('1', ADA, NOW - HISTORY_GRACE_SECONDS - 1) }
    expect(shouldNotify(old, { ...context, hidden: true })).toBe(false)
    // Inside the grace it is news: a relay is slow, not the sender.
    const recent = { roomId: ROOM_A, message: message('2', ADA, NOW - HISTORY_GRACE_SECONDS) }
    expect(shouldNotify(recent, { ...context, hidden: true })).toBe(true)
  })

  it('never for our own, from any of our devices', () => {
    const mine = { roomId: ROOM_B, message: message('1', ME, NOW) }
    expect(shouldNotify(mine, { ...context, hidden: true })).toBe(false)
  })

  it('not for the room on screen while the person is looking at it', () => {
    const here = { roomId: ROOM_A, message: message('1', ADA, NOW) }
    expect(shouldNotify(here, context)).toBe(false)
  })

  it('for the room on screen once the document is hidden', () => {
    const here = { roomId: ROOM_A, message: message('1', ADA, NOW) }
    expect(shouldNotify(here, { ...context, hidden: true })).toBe(true)
  })

  it('for another room whether or not the document is hidden, and for every room from the list', () => {
    const elsewhere = { roomId: ROOM_B, message: message('1', ADA, NOW) }
    expect(shouldNotify(elsewhere, context)).toBe(true)
    expect(shouldNotify(elsewhere, { ...context, shownRoomId: undefined })).toBe(true)
  })
})

describe('what the notification says', () => {
  it('names the room and the sender, and keeps the text in the app unless told otherwise', () => {
    const closed = notificationContent({ roomId: ROOM_A, room: 'Town hall', sender: 'Ada (adadadadadad…)', channel: 'chat', text: 'the secret plan', showText: false })
    expect(closed.title).toBe('Town hall')
    expect(closed.body).toBe('Ada (adadadadadad…) said something')
    expect(closed.body).not.toContain('secret')
    const open = notificationContent({ roomId: ROOM_A, room: 'Town hall', sender: 'Ada (adadadadadad…)', channel: 'chat', text: 'the secret plan', showText: true })
    expect(open.body).toBe('Ada (adadadadadad…): the secret plan')
  })

  it('says which conversation, and replaces itself per room and conversation', () => {
    const agents = notificationContent({ roomId: ROOM_A, room: 'Bench', sender: 'Tally', channel: 'agents', text: 'x', showText: false })
    const minutes = notificationContent({ roomId: ROOM_A, room: 'Bench', sender: 'Scribe', channel: 'minutes', text: 'x', showText: false })
    expect(agents.body).toContain('agents channel')
    expect(minutes.body).toContain('wrote minutes')
    expect(agents.tag).not.toBe(minutes.tag)
    expect(agents.tag).toBe(notificationContent({ roomId: ROOM_A, room: 'Bench', sender: 'Quill', channel: 'agents', text: 'y', showText: true }).tag)
  })

  it('cuts a long message short and flattens its lines', () => {
    const long = notificationContent({ roomId: ROOM_A, room: 'r', sender: 's', channel: 'chat', text: 'a\n\nb ' + 'c'.repeat(500), showText: true })
    expect(long.body.startsWith('s: a b ccc')).toBe(true)
    expect([...long.body].length).toBeLessThanOrEqual(PREVIEW_LENGTH + 3)
    expect(long.body.endsWith('…')).toBe(true)
  })

  it('puts a count in the title while there is one', () => {
    expect(titleWithCount('KithMoot', 0)).toBe('KithMoot')
    expect(titleWithCount('KithMoot', 3)).toBe('(3) KithMoot')
  })
})

describe('the per-device switches', () => {
  it('are off until asked for, and the text switch is separate', () => {
    const store = memoryDeviceStore()
    expect(notifySettings(store)).toEqual({ enabled: false, showText: false })
    expect(setNotifySettings(store, { enabled: true })).toEqual({ enabled: true, showText: false })
    expect(setNotifySettings(store, { showText: true })).toEqual({ enabled: true, showText: true })
    expect(setNotifySettings(store, { enabled: false })).toEqual({ enabled: false, showText: true })
  })
})

describe('the notifier over changing logs', () => {
  function harness(opts: { hidden?: boolean; shown?: string; enabled?: boolean; showText?: boolean } = {}) {
    const store = memoryDeviceStore()
    setNotifySettings(store, { enabled: opts.enabled ?? true, showText: opts.showText ?? false })
    const delivered: NotificationContent[] = []
    const counts: number[] = []
    let hidden = opts.hidden ?? true
    const notifier = new Notifier({
      settings: () => notifySettings(store),
      hidden: () => hidden,
      shownRoomId: () => opts.shown,
      self: () => ME,
      deliver: (content) => void delivered.push(content),
      onPending: (count) => void counts.push(count),
      now: () => NOW,
    })
    return { notifier, delivered, counts, setHidden: (h: boolean) => void (hidden = h) }
  }

  it('notifies once per new message, never for the history a log replays first, and counts while hidden', () => {
    const { notifier, delivered, counts } = harness({ shown: ROOM_A })
    const ingest = notifier.follow({ roomId: ROOM_A, channel: 'chat', room: () => 'Town hall', sender: (m) => m.name ?? '?' })
    const history = [message('h1', ADA, NOW - 3600), message('h2', ME, NOW - 60)]
    ingest(history)
    expect(delivered).toEqual([])
    const fresh = message('n1', ADA, NOW + 1, 'anyone there?')
    ingest([...history, fresh])
    ingest([...history, fresh])
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.title).toBe('Town hall')
    expect(delivered[0]!.body).toBe('Ada said something')
    expect(counts).toEqual([1])
    expect(notifier.pending).toBe(1)
    notifier.seen()
    expect(notifier.pending).toBe(0)
    expect(counts).toEqual([1, 0])
  })

  it('does nothing when the switch is off, and includes the text only when the second one is on', () => {
    const off = harness({ enabled: false })
    off.notifier.follow({ roomId: ROOM_A, channel: 'chat', room: () => 'r', sender: () => 's' })([message('1', ADA, NOW)])
    expect(off.delivered).toEqual([])
    const withText = harness({ showText: true })
    withText.notifier.follow({ roomId: ROOM_A, channel: 'chat', room: () => 'r', sender: () => 'Ada' })([message('1', ADA, NOW, 'tea?')])
    expect(withText.delivered[0]!.body).toBe('Ada: tea?')
  })

  it('leaves the room on screen alone while it is being looked at, and counts nothing then', () => {
    const { notifier, delivered, counts, setHidden } = harness({ hidden: false, shown: ROOM_A })
    const here = notifier.follow({ roomId: ROOM_A, channel: 'chat', room: () => 'r', sender: () => 's' })
    const elsewhere = notifier.follow({ roomId: ROOM_B, channel: 'chat', room: () => 'other', sender: () => 's' })
    here([message('1', ADA, NOW)])
    elsewhere([message('2', ADA, NOW)])
    expect(delivered.map((d) => d.title)).toEqual(['other'])
    // Visible, so nothing is unseen: the notification was a glance away.
    expect(counts).toEqual([])
    setHidden(true)
    here([message('1', ADA, NOW), message('3', ADA, NOW + 1)])
    expect(delivered).toHaveLength(2)
    expect(counts).toEqual([1])
  })

  it('survives a delivery that throws or rejects', () => {
    const store = memoryDeviceStore()
    setNotifySettings(store, { enabled: true })
    let calls = 0
    const notifier = new Notifier({
      settings: () => notifySettings(store),
      hidden: () => true,
      shownRoomId: () => undefined,
      self: () => ME,
      deliver: () => {
        calls++
        if (calls === 1) throw new Error('no')
        return Promise.reject(new Error('no'))
      },
      now: () => NOW,
    })
    const ingest = notifier.follow({ roomId: ROOM_A, channel: 'chat', room: () => 'r', sender: () => 's' })
    expect(() => ingest([message('1', ADA, NOW), message('2', ADA, NOW)])).not.toThrow()
    expect(calls).toBe(2)
  })
})
