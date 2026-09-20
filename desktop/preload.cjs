const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('kithmootDesktop', Object.freeze({
  supportsShareArea: ['darwin', 'win32'].includes(process.platform),
  armShareArea() { return ipcRenderer.invoke('desktop:area-arm') },
  shareAreaState() { return ipcRenderer.invoke('desktop:area-state') },
  shareAreaAction(action, value) { ipcRenderer.send('desktop:area-action', action, value) },
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
