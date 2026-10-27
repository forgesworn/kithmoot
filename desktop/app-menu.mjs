/**
 * The desktop window's application menu (design-calm-shell 9.3).
 *
 * A pure template builder, like `context-menu.mjs`: nothing here touches
 * `electron`, so `node:test` covers it, and `main.mjs` is the one place that
 * turns the template into a real `Menu`.
 *
 * The menu and the page talk in a closed vocabulary. The page says what the
 * room on screen allows (`sanitiseRoomMenuState` keeps only what it knows how
 * to use); an item the person chooses sends one name from `MENU_COMMANDS` back,
 * and the page maps that name onto the function the same control already runs.
 * No string the page supplies is ever turned into code or a command here.
 */

/** Every command a menu item can send. The page lists the same names. */
export const MENU_COMMANDS = Object.freeze([
  'new-room', 'open-link', 'join-code', 'settings',
  'show-chats', 'show-people', 'show-boards', 'find', 'room-info',
  'text-size-standard', 'text-size-large', 'text-size-huge',
  'call', 'search', 'invite', 'agent',
  'notify-all', 'notify-mentions', 'notify-off', 'notify-inherit',
  'mute-1h', 'mute-8h', 'mute-1d', 'mute-1w', 'unmute',
  'pin', 'leave',
  'shortcuts',
])

const TEXT_SIZES = ['standard', 'large', 'huge']
const NOTIFY_MODES = ['all', 'mentions', 'off', 'inherit']
const CALL_LABELS = ['Start call', 'Join call', 'Leave call']

/** What the menu knows when nothing has been said: no room, nobody signed in. */
export const EMPTY_STATE = Object.freeze({
  room: false, people: false, call: 'Start call', search: false, invite: false, agent: false,
  pinned: false, notify: undefined, muted: false, textSize: 'standard', leaveLabel: 'Leave room…',
})

const bool = value => value === true

/**
 * Whatever the page sent, reduced to the fields and values the menu uses.
 * Unknown keys are dropped and every value is checked, so a page that sends
 * rubbish gets the empty menu, not an error.
 * @param {unknown} value
 */
export function sanitiseRoomMenuState(value) {
  if (typeof value !== 'object' || value === null) return { ...EMPTY_STATE }
  const state = /** @type {Record<string, unknown>} */ (value)
  const room = bool(state.room)
  return {
    room,
    people: bool(state.people),
    // The room items follow the same rules as the ⋯ menu; with no room open
    // none of them applies, whatever else was said.
    call: CALL_LABELS.includes(/** @type {string} */ (state.call)) ? /** @type {string} */ (state.call) : 'Start call',
    search: room && bool(state.search),
    invite: room && bool(state.invite),
    agent: room && bool(state.agent),
    pinned: room && bool(state.pinned),
    notify: room && NOTIFY_MODES.includes(/** @type {string} */ (state.notify)) ? /** @type {string} */ (state.notify) : undefined,
    // Whether a timed mute is running: a boolean, never a label, so the words stay ours.
    muted: room && bool(state.muted),
    textSize: TEXT_SIZES.includes(/** @type {string} */ (state.textSize)) ? /** @type {string} */ (state.textSize) : 'standard',
    leaveLabel: state.leaveLabel === 'Leave private chat…' ? 'Leave private chat…' : 'Leave room…',
  }
}

/**
 * @param {{
 *   platform: NodeJS.Platform,
 *   appName: string,
 *   state: ReturnType<typeof sanitiseRoomMenuState>,
 *   run: (command: string) => void,
 *   about: () => void,
 *   reportAbuse: () => void,
 *   hostingState?: { available: boolean, status: string },
 *   hostingControls?: () => void,
 *   hostingStop?: () => void,
 * }} options
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
export function buildAppMenuTemplate({ platform, appName, state, run, about, reportAbuse, hostingState, hostingControls, hostingStop }) {
  const mac = platform === 'darwin'
  // Access keys are a Windows habit; elsewhere an ampersand would show.
  const name = (text, key) => platform === 'win32' ? text.replace(key, `&${key}`) : text
  const send = command => () => run(command)
  const item = (label, command, extra = {}) => ({ label, click: send(command), ...extra })
  const inRoom = (enabled = true) => ({ enabled: state.room && enabled })
  const radios = (choices, current, prefix, extra = {}) => choices.map(([value, label]) => ({
    label, type: 'radio', checked: current === value, click: send(`${prefix}-${value}`), ...extra,
  }))
  const settings = accelerator => item('Settings…', 'settings', { accelerator })

  return [
    ...(mac ? [{
      label: appName,
      submenu: [
        { label: `About ${appName}`, click: about },
        { type: 'separator' },
        settings('Cmd+,'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: name('File', 'F'),
      submenu: [
        item('New room', 'new-room', { accelerator: 'CmdOrCtrl+N' }),
        item('Open an invite link…', 'open-link'),
        item('Join with a code…', 'join-code'),
        ...(hostingState?.available === true && hostingControls ? [{ label: `Local call relay: ${!hostingState?.available ? 'Unavailable' : ({ off: 'Off', starting: 'Starting', running: 'Running (local bind)', stopping: 'Stopping', failed: 'Failed' }[hostingState.status] ?? 'Off')}…`, click: hostingControls }] : []),
        ...(hostingState?.available === true && hostingStop ? [{ label: 'Stop local call relay', enabled: hostingState?.available === true && hostingState.status !== 'off', click: hostingStop }] : []),
        ...(mac ? [] : [{ type: 'separator' }, settings('Ctrl+,')]),
        { type: 'separator' },
        { role: 'close', label: 'Close window' },
      ],
    },
    { role: 'editMenu', label: name('Edit', 'E') },
    {
      label: name('View', 'V'),
      submenu: [
        item('Chats', 'show-chats', { accelerator: 'CmdOrCtrl+1' }),
        // People is for a Nostr sign-in and nobody else.
        ...(state.people ? [item('People', 'show-people', { accelerator: 'CmdOrCtrl+2' })] : []),
        item('Boards', 'show-boards', { accelerator: 'CmdOrCtrl+3' }),
        { type: 'separator' },
        item('Find a chat or room', 'find', { accelerator: 'CmdOrCtrl+K' }),
        item('Room info', 'room-info', { accelerator: 'CmdOrCtrl+I', ...inRoom() }),
        { type: 'separator' },
        { label: 'Text size', submenu: radios([['standard', 'Standard'], ['large', 'Large'], ['huge', 'Huge']], state.textSize, 'text-size') },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: name('Room', 'R'),
      submenu: [
        item(state.call, 'call', inRoom()),
        item('Search in room', 'search', { accelerator: 'CmdOrCtrl+F', ...inRoom(state.search) }),
        item('Invite people…', 'invite', inRoom(state.invite)),
        item('Add an agent…', 'agent', inRoom(state.agent)),
        { type: 'separator' },
        {
          label: 'Notifications', enabled: state.room,
          submenu: [
            ...radios([['all', 'Every message'], ['mentions', 'Only mentions and replies'], ['off', 'Nothing'], ['inherit', 'Use my default']], state.notify, 'notify', { enabled: state.room }),
            // A room set to Nothing has no sound left to take away, so no durations.
            ...(state.notify === 'off' ? [] : [
              { type: 'separator' },
              ...(state.muted
                ? [item('Unmute', 'unmute', inRoom())]
                : [['Mute for 1 hour', 'mute-1h'], ['Mute for 8 hours', 'mute-8h'], ['Mute for 1 day', 'mute-1d'], ['Mute for 1 week', 'mute-1w']].map(([label, command]) => item(label, command, inRoom()))),
            ]),
          ],
        },
        item(state.pinned ? 'Unpin' : 'Pin', 'pin', inRoom()),
        { type: 'separator' },
        item(state.leaveLabel, 'leave', inRoom()),
      ],
    },
    { role: 'windowMenu', label: name('Window', 'W') },
    {
      label: name('Help', 'H'),
      submenu: [
        item('Keyboard shortcuts', 'shortcuts', { accelerator: 'CmdOrCtrl+/' }),
        { label: 'Report abuse', click: reportAbuse },
        { label: 'About this preview', click: about },
      ],
    },
  ]
}
