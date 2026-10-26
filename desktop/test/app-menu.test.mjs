import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAppMenuTemplate, sanitiseRoomMenuState, MENU_COMMANDS, EMPTY_STATE } from '../app-menu.mjs'

const build = (platform, state = EMPTY_STATE, run = () => {}) => buildAppMenuTemplate({
  platform, appName: 'KithMoot', state: sanitiseRoomMenuState(state), run, about: () => {}, reportAbuse: () => {},
})
const top = template => template.map(menu => menu.label ?? menu.role)
const find = (template, menu, label) => template.find(m => (m.label ?? m.role) === menu).submenu.find(i => i.label === label)
const flat = template => template.flatMap(menu => menu.submenu ?? []).flatMap(item => item.submenu ? [item, ...item.submenu] : [item])

test('the menus run File, Edit, View, Room, Window, Help, with an app menu first on a Mac', () => {
  assert.deepEqual(top(build('linux')), ['File', 'Edit', 'View', 'Room', 'Window', 'Help'])
  assert.deepEqual(top(build('darwin')), ['KithMoot', 'File', 'Edit', 'View', 'Room', 'Window', 'Help'])
})

test('Windows labels carry access keys and the other platforms show none', () => {
  assert.deepEqual(top(build('win32')), ['&File', '&Edit', '&View', '&Room', '&Window', '&Help'])
  assert.ok(!top(build('linux')).some(label => label.includes('&')))
})

test('Settings is Cmd+, in the Mac app menu and Ctrl+, in File elsewhere, and never both', () => {
  const mac = build('darwin')
  assert.equal(find(mac, 'KithMoot', 'Settings…').accelerator, 'Cmd+,')
  assert.equal(find(mac, 'File', 'Settings…'), undefined)
  assert.equal(find(build('linux'), 'File', 'Settings…').accelerator, 'Ctrl+,')
  assert.equal(find(build('win32'), '&File', 'Settings…').accelerator, 'Ctrl+,')
})

test('the Room items are disabled with no room open, whatever the page says about them', () => {
  const closed = build('linux', { room: false, invite: true, agent: true, search: true, pinned: true, notify: 'all' })
  const room = closed.find(menu => menu.label === 'Room').submenu
  for (const item of room.filter(i => i.type !== 'separator')) assert.equal(item.enabled, false, item.label)
  assert.equal(find(closed, 'View', 'Room info').enabled, false)
})

test('the Room items follow what the page allows for the room open', () => {
  const state = { room: true, call: 'Join call', search: true, invite: false, agent: true, pinned: true, notify: 'off', leaveLabel: 'Leave private chat…' }
  const menu = build('linux', state)
  assert.equal(find(menu, 'Room', 'Join call').enabled, true)
  assert.equal(find(menu, 'Room', 'Search in room').accelerator, 'CmdOrCtrl+F')
  assert.equal(find(menu, 'Room', 'Invite people…').enabled, false)
  assert.equal(find(menu, 'Room', 'Add an agent…').enabled, true)
  assert.ok(find(menu, 'Room', 'Unpin'))
  assert.ok(find(menu, 'Room', 'Leave private chat…'))
  const notifications = find(menu, 'Room', 'Notifications').submenu
  assert.deepEqual(notifications.map(i => [i.label, i.checked]), [['Every message', false], ['Only mentions and replies', false], ['Nothing', true], ['Use my default', false]])
})

test('the Notifications submenu offers four durations, or Unmute while one runs, and nothing under Nothing', () => {
  const submenu = state => find(build('linux', { room: true, ...state }), 'Room', 'Notifications').submenu
  const labels = items => items.map(i => i.type === 'separator' ? '-' : i.label)
  assert.deepEqual(labels(submenu({ notify: 'all', muted: false })), ['Every message', 'Only mentions and replies', 'Nothing', 'Use my default', '-', 'Mute for 1 hour', 'Mute for 8 hours', 'Mute for 1 day', 'Mute for 1 week'])
  assert.deepEqual(labels(submenu({ notify: 'inherit', muted: true })), ['Every message', 'Only mentions and replies', 'Nothing', 'Use my default', '-', 'Unmute'])
  assert.deepEqual(labels(submenu({ notify: 'off', muted: false })), ['Every message', 'Only mentions and replies', 'Nothing', 'Use my default'])
  assert.equal(submenu({ notify: 'mentions' }).find(i => i.label === 'Only mentions and replies').checked, true)
  assert.equal(sanitiseRoomMenuState({ room: false, muted: true }).muted, false)
  assert.equal(sanitiseRoomMenuState({ room: true, muted: 'yes' }).muted, false)
  assert.equal(sanitiseRoomMenuState({ room: true, muted: true }).muted, true)
  for (const command of ['notify-mentions', 'mute-1h', 'mute-8h', 'mute-1d', 'mute-1w', 'unmute']) assert.ok(MENU_COMMANDS.includes(command), command)
})

test('People is only offered to a Nostr sign-in', () => {
  assert.equal(find(build('linux'), 'View', 'People'), undefined)
  assert.equal(find(build('linux', { people: true }), 'View', 'People').accelerator, 'CmdOrCtrl+2')
})

test('the View menu has the three destinations, find, room info and a text size with the chosen one ticked', () => {
  const menu = build('linux', { room: true, textSize: 'large' })
  for (const [label, key] of [['Chats', 'CmdOrCtrl+1'], ['Boards', 'CmdOrCtrl+3'], ['Find a chat or room', 'CmdOrCtrl+K'], ['Room info', 'CmdOrCtrl+I']]) assert.equal(find(menu, 'View', label).accelerator, key, label)
  assert.deepEqual(find(menu, 'View', 'Text size').submenu.map(i => [i.label, i.checked]), [['Standard', false], ['Large', true], ['Huge', false]])
})

test('every item that sends a command sends a name from the fixed list, and clicking says it', () => {
  const sent = []
  const menu = build('darwin', { room: true, people: true, invite: true, agent: true, search: true, notify: 'all' }, command => sent.push(command))
  for (const item of flat(menu).filter(item => item.click && !item.role && item.label !== 'Report abuse' && !item.label?.startsWith('About'))) item.click()
  assert.ok(sent.length >= 18, `only ${sent.length} commands`)
  for (const command of sent) assert.ok(MENU_COMMANDS.includes(command), command)
})

test('nonsense from the page gives the empty state, not an error, and unknown values are dropped', () => {
  for (const value of [undefined, null, 5, 'room', []]) assert.deepEqual(sanitiseRoomMenuState(value), EMPTY_STATE)
  const state = sanitiseRoomMenuState({ room: true, call: 'Do something else', notify: 'sometimes', textSize: 'giant', leaveLabel: 'Burn it', extra: 1 })
  assert.equal(state.call, 'Start call')
  assert.equal(state.notify, undefined)
  assert.equal(state.textSize, 'standard')
  assert.equal(state.leaveLabel, 'Leave room…')
  assert.ok(!('extra' in state))
})

test('native hosting controls use main-owned state and callbacks outside renderer commands', () => {
  for (const status of ['off', 'starting', 'running', 'stopping', 'failed']) {
    let shown = 0
    let stopped = 0
    const template = buildAppMenuTemplate({ platform: 'linux', appName: 'KithMoot', state: EMPTY_STATE,
      run: () => assert.fail('hosting must not dispatch to the renderer'), about() {}, reportAbuse() {},
      hostingState: { available: true, status }, hostingControls: () => shown++, hostingStop: () => stopped++ })
    const controls = template[0].submenu.find(item => item.label?.startsWith('Local call relay:'))
    assert.match(controls.label, status === 'running' ? /Running \(local bind\)/ : new RegExp(status[0].toUpperCase() + status.slice(1)))
    controls.click()
    assert.equal(shown, 1)
    const stop = find(template, 'File', 'Stop local call relay')
    assert.equal(stop.enabled, status !== 'off')
    stop.click()
    assert.equal(stopped, 1)
  }
  const template = buildAppMenuTemplate({ platform: 'darwin', appName: 'KithMoot', state: EMPTY_STATE,
    run() {}, about() {}, reportAbuse() {}, hostingState: { available: false, status: 'off' }, hostingControls() {}, hostingStop() {} })
  assert.equal(template.find(menu => menu.label === 'File').submenu.some(item => item.label?.includes('local call relay') || item.label?.includes('Local call relay')), false)
  assert.equal(MENU_COMMANDS.some(command => command.includes('hosting') || command.includes('relay')), false)
})
