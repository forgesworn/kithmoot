const { contextBridge, ipcRenderer } = require('electron')
// Sandboxed: nothing but electron can be required here (see main.mjs).
const areaSwitch = process.argv.find(arg => arg.startsWith('--kithmoot-share-area='))?.split('=')[1]
const shareAreaMode = ['frame', 'preview'].includes(areaSwitch) ? areaSwitch : null
// Set only on the main window when the main process applied an inset title bar.
const titleBarSwitch = process.argv.find(arg => arg.startsWith('--kithmoot-title-bar='))?.split('=')[1]
const attachmentWrites = new Map()
function writeAttachment(id, chunk, finish) {
  const previous = attachmentWrites.get(id) ?? Promise.resolve()
  const next = previous.catch(() => false)
    .then(() => ipcRenderer.invoke('desktop:attachment-write', id, chunk, finish))
    .catch(() => false)
  attachmentWrites.set(id, next)
  next.then(() => { if (attachmentWrites.get(id) === next) attachmentWrites.delete(id) })
  return next
}
function closeAttachment(id) {
  const previous = attachmentWrites.get(id) ?? Promise.resolve()
  attachmentWrites.delete(id)
  return previous.catch(() => false)
    .then(() => { ipcRenderer.send('desktop:attachment-close', id) })
    .catch(() => {})
}
function closeAttachments() {
  const previous = [...attachmentWrites.values()]
  attachmentWrites.clear()
  return Promise.allSettled(previous)
    .then(() => { ipcRenderer.send('desktop:attachment-close-all') })
    .catch(() => {})
}
contextBridge.exposeInMainWorld('kithmootDesktop', Object.freeze({
  titleBar: titleBarSwitch === 'inset' ? 'inset' : null,
  onWindowState(listener) {
    const handler = (_event, state) => { if (state && typeof state.fullScreen === 'boolean') listener({ fullScreen: state.fullScreen }) }
    ipcRenderer.on('desktop:window-state', handler)
    return () => ipcRenderer.removeListener('desktop:window-state', handler)
  },
  supportsShareArea: shareAreaMode !== null,
  shareAreaMode,
  armShareArea() { return ipcRenderer.invoke('desktop:area-arm') },
  shareAreaState() { return ipcRenderer.invoke('desktop:area-state') },
  shareAreaCheck() { return ipcRenderer.invoke('desktop:area-check') },
  screenAccess() { return ipcRenderer.invoke('desktop:screen-access') },
  ownCaptureIds() { return ipcRenderer.invoke('desktop:own-capture-ids') },
  shareAreaAction(action, value) { ipcRenderer.send('desktop:area-action', action, value) },
  // Boxes are placed on the real screen, which only the frame mode can do.
  supportsRedaction: shareAreaMode === 'frame',
  redactionBegin() { return ipcRenderer.invoke('desktop:redaction-begin') },
  redactionState() { return ipcRenderer.invoke('desktop:redaction-state') },
  redactionAction(id, action, value) { ipcRenderer.send('desktop:redaction-action', id, action, value) },
  onRedactionState(listener) {
    const handler = (_event, state) => listener(state)
    ipcRenderer.on('desktop:redaction-state', handler)
    return () => ipcRenderer.removeListener('desktop:redaction-state', handler)
  },
  onShareAreaState(listener) {
    const handler = (_event, state) => listener(state)
    ipcRenderer.on('desktop:area-state', handler)
    return () => ipcRenderer.removeListener('desktop:area-state', handler)
  },
  onShareAreaCheck(listener) {
    const handler = (_event, check) => listener(check)
    ipcRenderer.on('desktop:area-check', handler)
    return () => ipcRenderer.removeListener('desktop:area-check', handler)
  },
  setUnread(count) {
    if (Number.isSafeInteger(count) && count >= 0) ipcRenderer.send('desktop:unread', count)
  },
  notify(content) { ipcRenderer.send('desktop:notify', content) },
  clearRoomNotices(roomId) { if (typeof roomId === 'string') ipcRenderer.send('desktop:notify-clear-room', roomId) },
  onOpenRoom(listener) {
    const handler = (_event, roomId) => listener(roomId)
    ipcRenderer.on('desktop:open-room', handler)
    return () => ipcRenderer.removeListener('desktop:open-room', handler)
  },
  // What the room on screen allows, for the Room menu's items; and the name of
  // the menu item the person chose, from the fixed list in app-menu.mjs.
  setRoomMenuState(state) { if (typeof state === 'object' && state !== null) ipcRenderer.send('desktop:room-menu-state', state) },
  onMenuCommand(listener) {
    const handler = (_event, command) => { if (typeof command === 'string') listener(command) }
    ipcRenderer.on('desktop:menu-command', handler)
    return () => ipcRenderer.removeListener('desktop:menu-command', handler)
  },
  setCallActive(active) {
    if (typeof active === 'boolean') ipcRenderer.send('desktop:call-state', active)
  },
  // The built-in call relay: the page says which account is on screen and
  // which relays it uses; the main process answers with the relay's state and,
  // while it runs, this computer's own pairing.
  setRelayContext(context) { if (typeof context === 'object' && context !== null) ipcRenderer.send('desktop:spry-relay-context', context) },
  relayState() { return ipcRenderer.invoke('desktop:spry-relay-state') },
  // The relay page's own controls. The main process checks the sender and every
  // argument again; the answer says only whether it was accepted.
  relayStart() { return ipcRenderer.invoke('desktop:spry-relay-start').catch(() => false) },
  relayStop() { return ipcRenderer.invoke('desktop:spry-relay-stop').catch(() => false) },
  relaySetStartOnOpen(on) { return typeof on === 'boolean' ? ipcRenderer.invoke('desktop:spry-relay-start-on-open', on).catch(() => false) : Promise.resolve(false) },
  relayRemoveKeys() { return ipcRenderer.invoke('desktop:spry-relay-remove-keys').catch(() => false) },
  onRelayState(listener) {
    const handler = (_event, value) => listener(value)
    ipcRenderer.on('desktop:spry-relay-state', handler)
    return () => ipcRenderer.removeListener('desktop:spry-relay-state', handler)
  },
  updateState() { return ipcRenderer.invoke('desktop:update-state') },
  installUpdate() { return ipcRenderer.invoke('desktop:update-install') },
  onUpdateState(listener) {
    const handler = (_event, state) => listener(state)
    ipcRenderer.on('desktop:update-state', handler)
    return () => ipcRenderer.removeListener('desktop:update-state', handler)
  },
  beginAttachment(metadata) { return ipcRenderer.invoke('desktop:attachment-begin', metadata).catch(() => null) },
  writeAttachment,
  closeAttachment,
  closeAttachments,
}))
