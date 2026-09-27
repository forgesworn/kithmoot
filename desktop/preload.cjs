const { contextBridge, ipcRenderer } = require('electron')
// Sandboxed: nothing but electron can be required here (see main.mjs).
const areaSwitch = process.argv.find(arg => arg.startsWith('--kithmoot-share-area='))?.split('=')[1]
const shareAreaMode = ['frame', 'preview'].includes(areaSwitch) ? areaSwitch : null
contextBridge.exposeInMainWorld('kithmootDesktop', Object.freeze({
  supportsShareArea: shareAreaMode !== null,
  shareAreaMode,
  armShareArea() { return ipcRenderer.invoke('desktop:area-arm') },
  shareAreaState() { return ipcRenderer.invoke('desktop:area-state') },
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
  setUnread(count) {
    if (Number.isSafeInteger(count) && count >= 0) ipcRenderer.send('desktop:unread', count)
  },
  notify(content) { ipcRenderer.send('desktop:notify', content) },
  onOpenRoom(listener) {
    const handler = (_event, roomId) => listener(roomId)
    ipcRenderer.on('desktop:open-room', handler)
    return () => ipcRenderer.removeListener('desktop:open-room', handler)
  },
  setCallActive(active) {
    if (typeof active === 'boolean') ipcRenderer.send('desktop:call-state', active)
  },
  updateState() { return ipcRenderer.invoke('desktop:update-state') },
  installUpdate() { return ipcRenderer.invoke('desktop:update-install') },
  onUpdateState(listener) {
    const handler = (_event, state) => listener(state)
    ipcRenderer.on('desktop:update-state', handler)
    return () => ipcRenderer.removeListener('desktop:update-state', handler)
  },
}))
