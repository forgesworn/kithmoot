const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('kithmootDesktop', Object.freeze({
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
}))
