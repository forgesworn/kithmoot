import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { DesktopNotices } from '../notifications.mjs'
const content = { title: 'Workshop', body: 'Alex said something', tag: 'chat', roomId: 'a'.repeat(64), silent: true }
test('private banners group bursts, open only the room id and clear', () => {
  const shown = []; const opened = []
  const notices = new DesktopNotices({ supported: () => true, create: options => {
    const notice = new EventEmitter()
    notice.show = () => shown.push(options)
    notice.close = () => notice.emit('close')
    shown.notice = notice
    return notice
  }, open: id => opened.push(id) })
  assert.equal(notices.show(content), true)
  assert.equal(notices.show(content), false)
  assert.deepEqual(shown[0], { title: content.title, body: content.body, silent: true })
  shown.notice.emit('click')
  assert.deepEqual(opened, [content.roomId])
  notices.clear()
  assert.equal(notices.show(content), true)
})
test('invalid IPC, unsupported OS and failed banners cannot escape to native operations', () => {
  let created = 0
  const notices = new DesktopNotices({ supported: () => true, create: () => { created++; const n = new EventEmitter(); n.show = () => n.emit('failed'); n.close = () => {}; return n } })
  for (const invalid of [null, {}, { ...content, roomId: 'https://example.org/#secret' }, { ...content, title: 'x'.repeat(161) }, { ...content, silent: 'yes' }]) assert.equal(notices.show(invalid), false)
  assert.equal(created, 0)
  assert.equal(notices.show(content), true)
  notices.clear()
  const unsupported = new DesktopNotices({ supported: () => false })
  assert.equal(unsupported.show(content), false)
})


test('badge is refreshed after the OS shows a banner, using current unread state', () => {
  let notice
  let unread = 3
  const badges = []
  const notices = new DesktopNotices({ supported: () => true, shown: () => badges.push(unread), create: () => {
    notice = new EventEmitter()
    notice.show = () => {}
    notice.close = () => {}
    return notice
  } })
  notices.show(content)
  assert.deepEqual(badges, [])
  // Permission and OS delivery can resolve after further messages arrive.
  unread = 5
  notice.emit('show')
  assert.deepEqual(badges, [5])
  unread = 0
  notice.emit('show')
  assert.deepEqual(badges, [5, 0])
})

test('a self-destructed room takes only its own banners with it', () => {
  const closed = []
  const notices = new DesktopNotices({ supported: () => true, create: options => {
    const notice = new EventEmitter()
    notice.show = () => {}
    notice.close = () => { closed.push(options.title); notice.emit('close') }
    return notice
  } })
  const a = 'a'.repeat(64), b = 'b'.repeat(64)
  assert.equal(notices.show({ ...content, title: 'A', roomId: a, tag: `kithmoot:${a}:chat` }), true)
  assert.equal(notices.show({ ...content, title: 'B', roomId: b, tag: `kithmoot:${b}:chat` }), true)
  notices.clearRoom('not a room')
  notices.clearRoom(a)
  assert.deepEqual(closed, ['A'])
  // The room's rate limit goes with it.
  assert.equal(notices.show({ ...content, title: 'A', roomId: a, tag: `kithmoot:${a}:chat` }), true)
})
test('one banner closes by its tag, and nothing else does', () => {
  const closed = []
  const notices = new DesktopNotices({ supported: () => true, create: options => {
    const notice = new EventEmitter()
    notice.show = () => {}
    notice.close = () => { closed.push(options.title); notice.emit('close') }
    return notice
  } })
  const room = 'a'.repeat(64)
  const ring = `kithmoot:${room}:call:${'c'.repeat(32)}`
  assert.equal(notices.show({ ...content, title: 'Ring', roomId: room, tag: ring }), true)
  assert.equal(notices.show({ ...content, title: 'Chat', roomId: room, tag: `kithmoot:${room}:chat` }), true)
  for (const invalid of [null, 42, 'chat', `kithmoot:${room}`, 'x'.repeat(201)]) notices.clearTag(invalid)
  assert.deepEqual(closed, [])
  notices.clearTag(ring)
  assert.deepEqual(closed, ['Ring'])
  // Its rate limit goes with it, so the next call can ring at once.
  assert.equal(notices.show({ ...content, title: 'Ring', roomId: room, tag: ring }), true)
})
