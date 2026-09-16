import { app, BrowserWindow, session, net, Menu, dialog, shell, systemPreferences, desktopCapturer, ipcMain, powerSaveBlocker, Notification } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DesktopNotices } from './notifications.mjs'
import { HOME, ORIGIN, CSP, isAppUrl, isExternalUrl, localAsset, allowedPermissions } from './policy.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
// Automation always uses a disposable profile, never the user's account.
const testProfile = !app.isPackaged && process.env.KITHMOOT_DESKTOP_TEST_PROFILE
const profileArgument = app.commandLine.getSwitchValue('user-data-dir')
if (profileArgument && isAbsolute(profileArgument)) app.setPath('userData', profileArgument)
if (testProfile) app.setPath('userData', testProfile)
app.setName('KithMoot')
if (process.platform === 'linux') app.setDesktopName('dev.forgesworn.kithmoot.desktop')
let unreadCount = 0
const applyUnreadBadge = () => app.setBadgeCount(unreadCount)
const notices = new DesktopNotices({
  supported: () => Notification.isSupported(),
  shown: applyUnreadBadge,
  create: options => new Notification({ ...options, icon: join(here, 'web/pwa-512x512.png') }),
  open: roomId => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); win.webContents.send('desktop:open-room', roomId) } },
})
let win
let callActive = false
let powerBlock
let localNetworkAllowed = false
const networkPermissions = new Set(['local-network', 'loopback-network', 'local-network-access'])
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' }
const trusted = (contents) => contents && contents === win?.webContents && isAppUrl(contents.getURL())

function releaseCall() {
  callActive = false
  if (powerBlock !== undefined) powerSaveBlocker.stop(powerBlock)
  powerBlock = undefined
}
async function external(url) {
  if (!isExternalUrl(url) || !win) return
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', message: 'Open this link in your browser?', detail: url,
    buttons: ['Cancel', 'Open link'], defaultId: 0, cancelId: 0,
  })
  if (response === 1) await shell.openExternal(url)
}
function confirmClose(message, detail) {
  return dialog.showMessageBoxSync(win, {
    type: 'question', message, detail, buttons: ['Stay', 'Close KithMoot'], defaultId: 0, cancelId: 0,
  }) === 1
}

async function createWindow() {
  const ses = session.fromPartition('persist:kithmoot-desktop-v1')
  if (!ses.__kithmootConfigured) {
    ses.__kithmootConfigured = true
    ses.protocol.handle('https', async request => {
      const file = localAsset(request.url, join(here, 'web'))
      if (file === undefined) return net.fetch(request, { bypassCustomProtocolHandlers: true })
      if (file === null || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 })
      try {
        const body = await readFile(file)
        return new Response(request.method === 'HEAD' ? null : body, { headers: {
          'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
          'Content-Security-Policy': testProfile ? CSP.replace("connect-src 'self'", "connect-src ws://127.0.0.1:* 'self'") : CSP,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        } })
      } catch { return new Response('Not found', { status: 404 }) }
    })
    ses.setPermissionCheckHandler((contents, permission, origin, details) => {
      try { origin = new URL(origin).origin } catch { return false }
      if (permission === 'notifications') return origin === ORIGIN && (!contents || trusted(contents))
      if (origin !== ORIGIN || !trusted(contents) || details.isMainFrame === false) return false
      if (networkPermissions.has(permission)) return Boolean(testProfile) || localNetworkAllowed
      // Media requests go through macOS consent below. Clipboard reads remain denied.
      return allowedPermissions.has(permission)
    })
    ses.setPermissionRequestHandler(async (contents, permission, callback, details) => {
      if (!trusted(contents) || !isAppUrl(details.requestingUrl) || details.isMainFrame === false || (!allowedPermissions.has(permission) && !networkPermissions.has(permission))) return callback(false)
      try {
        if (permission === 'media' && process.platform === 'darwin' && !testProfile) {
          for (const type of details.mediaTypes ?? []) {
            const device = type === 'audio' ? 'microphone' : type === 'video' ? 'camera' : undefined
            if (!device || !await systemPreferences.askForMediaAccess(device)) return callback(false)
          }
        }
        if (networkPermissions.has(permission)) {
          if (testProfile || localNetworkAllowed) return callback(true)
          const { response } = await dialog.showMessageBox(win, {
            message: 'Allow connections on your local network?',
            detail: 'This lets KithMoot connect to relays and services on this network.',
            buttons: ['Not now', 'Allow'], defaultId: 0, cancelId: 0,
          })
          localNetworkAllowed = response === 1
          return callback(localNetworkAllowed)
        }
        callback(true)
      } catch { callback(false) }
    })
    ses.setDisplayMediaRequestHandler(async (request, callback) => {
      if (!request.frame || request.frame !== win?.webContents.mainFrame || !isAppUrl(request.frame.url) || !request.userGesture) return callback({})
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 120, height: 75 } })
        let answered = false
        const finish = (selection) => { if (!answered) { answered = true; callback(selection) } }
        const menu = Menu.buildFromTemplate([
          { label: 'Choose what to share', enabled: false },
          ...sources.map(source => ({ label: source.name, icon: source.thumbnail.resize({ width: 80 }), click: () => finish({ video: source }) })),
          { type: 'separator' }, { label: 'Cancel', click: () => finish({}) },
        ])
        menu.popup({ window: win, callback: () => finish({}) })
      } catch { callback({}) }
    }, { useSystemPicker: true })
    ses.on('will-download', (_event, item) => {
      // Chromium's save dialog provides a destination for attachments.
      item.setSaveDialogOptions({ title: 'Save attachment' })
    })
  }
  win = new BrowserWindow({
    title: 'KithMoot', width: 1320, height: 880, minWidth: 900, minHeight: 640,
    icon: join(here, 'web/pwa-512x512.png'),
    backgroundColor: '#101114', show: !testProfile,
    webPreferences: {
      session: ses, preload: join(here, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      backgroundThrottling: false, spellcheck: true,
    },
  })
  win.webContents.setWindowOpenHandler(({ url }) => { void external(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) { event.preventDefault(); void external(url) }
  })
  win.webContents.on('will-redirect', (event, url) => { if (!isAppUrl(url)) event.preventDefault() })
  win.webContents.on('will-attach-webview', event => event.preventDefault())
  win.webContents.on('will-prevent-unload', event => {
    if (confirmClose('Close with unsent work?', 'Your current draft or unfinished work may be lost.')) event.preventDefault()
  })
  win.on('close', event => {
    if (callActive) {
      if (!confirmClose('Leave the call and close KithMoot?', 'The call on this device will end. Your other devices and everyone else stay connected.')) { event.preventDefault(); return }
    }
  })
  win.on('focus', applyUnreadBadge)
  win.on('show', applyUnreadBadge)
  win.on('closed', () => { releaseCall(); notices.clear(); unreadCount = 0; applyUnreadBadge(); win = undefined })
  win.webContents.on('render-process-gone', () => releaseCall())
  await win.loadURL(HOME)
}

if (!testProfile && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { if (win) { win.restore(); win.show(); win.focus() } })
  app.whenReady().then(async () => {
    ipcMain.on('desktop:unread', (event, count) => {
      if (!trusted(event.sender) || event.senderFrame !== win.webContents.mainFrame || !Number.isSafeInteger(count) || count < 0 || count > 1_000_000) return
      unreadCount = count
      applyUnreadBadge()
      if (count === 0) notices.clear()
    })
    ipcMain.on('desktop:notify', (event, content) => {
      if (!trusted(event.sender) || event.senderFrame !== win.webContents.mainFrame) return
      notices.show(content)
    })
    ipcMain.on('desktop:call-state', (event, active) => {
      if (!trusted(event.sender) || event.senderFrame !== win.webContents.mainFrame || typeof active !== 'boolean') return
      callActive = active
      if (active && powerBlock === undefined) powerBlock = powerSaveBlocker.start('prevent-app-suspension')
      if (!active) releaseCall()
    })
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { label: 'File', submenu: [{ role: 'close' }] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
      { label: 'Help', submenu: [{ label: 'About this preview', click: () => dialog.showMessageBox(win, {
        message: `KithMoot desktop ${app.getVersion()}`, detail: 'Desktop preview. Updates are installed manually. Sign in here using your Nostr account or remote signer; browser extensions are not available. Calls, messages and room sync use the same KithMoot protocol.',
      }) }] },
    ]))
    await createWindow()
    app.on('activate', () => { if (!win) void createWindow() })
  }).catch(error => { console.error('Desktop startup failed:', error.message); app.exit(1) })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
}
