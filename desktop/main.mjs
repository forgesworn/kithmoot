import { ShareArea, AREA_URL } from './share-area.mjs'
import { Redaction, BOX_WINDOW, boxId } from './redaction.mjs'
import { MarksOverlay, MARKS_URL, MARKS_WINDOW } from './marks-overlay.mjs'
import { createDesktopUpdater } from './updater.mjs'
import { createPackageUpdater, packageVersionFile, readPackageVersion } from './package-updater.mjs'
import { createArchiveUpdater } from './archive-updater.mjs'
import { buildContextMenuTemplate } from './context-menu.mjs'
import { app, autoUpdater, BrowserWindow, session, net, Menu, dialog, shell, systemPreferences, desktopCapturer, ipcMain, powerSaveBlocker, Notification, clipboard, nativeTheme } from 'electron'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DesktopNotices } from './notifications.mjs'
import { HOME, ORIGIN, CSP, isAppUrl, isExternalUrl, localAsset, allowedPermissions, windowOpenAction } from './policy.mjs'
import { SCREEN_SETTINGS_URL, answerDisplayRequest, displayChoice, screenAccessGranted, refuse } from './screen-share.mjs'
import platformFeatures from './platform-features.cjs'

const here = fileURLToPath(new URL('.', import.meta.url))
// A sandboxed preload can require only electron, so the platform decision
// is made here and handed over as a switch.
// Unpackaged runs may force the Wayland preview so it can be exercised off Linux.
const forcedAreaMode = !app.isPackaged && ['frame', 'preview'].includes(process.env.KITHMOOT_DESKTOP_AREA_MODE) && process.env.KITHMOOT_DESKTOP_AREA_MODE
const areaMode = forcedAreaMode || platformFeatures.shareAreaMode()
const preloadArguments = areaMode ? [`${platformFeatures.SHARE_AREA_SWITCH}=${areaMode}`] : []
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
  open: roomId => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); win.webContents.send('desktop:open-room', roomId) } },
})
let win
const updateNotify = state => { if (win && !win.isDestroyed()) win.webContents.send('desktop:update-state', state) }
const updateLog = error => console.warn('Desktop update failed:', error?.message ?? 'Unknown error')
// Installed from the Debian package, apt upgrades this copy in place; the
// app only notices and offers the restart.
const versionStamp = app.isPackaged && process.platform === 'linux' ? packageVersionFile(process.resourcesPath) : undefined
const packageManaged = versionStamp !== undefined && readPackageVersion(versionStamp) !== undefined
const updates = packageManaged
  ? createPackageUpdater({
    currentVersion: app.getVersion(), installedVersion: () => readPackageVersion(versionStamp),
    relaunch: () => { app.relaunch(); app.quit() }, notify: updateNotify, log: updateLog,
  })
  : process.platform === 'darwin'
    ? createDesktopUpdater({
      autoUpdater, platform: process.platform, arch: process.arch, packaged: app.isPackaged,
      notify: updateNotify, log: updateLog,
    })
    // The Windows ZIP and the Linux tarball: a signed manifest, a verified
    // download, and a swap on restart.
    : createArchiveUpdater({
      platform: process.platform, arch: process.arch, packaged: app.isPackaged,
      currentVersion: app.getVersion(), installDir: dirname(process.execPath),
      updatesDir: join(app.getPath('userData'), 'updates'),
      fetch: url => net.fetch(url, { cache: 'no-store' }),
      quit: () => app.quit(),
      // Given an execPath, Electron starts it with no arguments unless told:
      // keep the flags this copy was started with, such as --ozone-platform.
      relaunch: execPath => { app.relaunch({ execPath, args: process.argv.slice(1) }); app.quit() },
      notify: updateNotify, log: updateLog,
    })
const shareArea = new ShareArea(() => win, areaMode)
// Redaction boxes need a window placed on the real screen, which Wayland
// forbids: there the preview area share is the way to keep things private.
const redaction = areaMode === 'frame' ? new Redaction(() => win) : undefined
// Marks drawn on a whole-screen share, shown over that screen. It goes where
// the capture the redaction boxes are mapped onto is, so it needs the same mode.
const marksOverlay = redaction ? new MarksOverlay(() => redaction.capture) : undefined
// Unpackaged automation stands in for the capture source, which a synthetic
// presentation never asks the main process to choose.
if (testProfile) globalThis.kithmootTest = { redaction, shareArea, marksOverlay }
let configureDisplayCapture
let callActive = false
let powerBlock
let localNetworkAllowed = false
const networkPermissions = new Set(['local-network', 'loopback-network', 'local-network-access'])
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' }
const trusted = (contents) => contents && contents === win?.webContents && isAppUrl(contents.getURL())

function releaseCall() {
  shareArea.close()
  redaction?.closeAll()
  marksOverlay?.close()
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

// Electron builds no right-click menu of its own; every window gets the
// standard editing menu, wired to that window's own webContents so a
// spelling fix or a paste lands where the click happened. The main window's
// contents reach both callers: `web-contents-created` fires inside
// `new BrowserWindow()`, before `win` is assigned, so its guard cannot tell.
const withContextMenu = new WeakSet()
function attachContextMenu(contents) {
  if (withContextMenu.has(contents)) return
  withContextMenu.add(contents)
  contents.on('context-menu', (_event, params) => {
    const template = buildContextMenuTemplate(params, {
      replaceMisspelling: word => contents.replaceMisspelling(word),
      copyLink: url => clipboard.writeText(url),
      openLink: url => void external(url),
    })
    if (template.length) Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(contents) })
  })
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
      if (contents === shareArea.window?.webContents && ['media', 'display-capture'].includes(permission) && details.isMainFrame !== false) return true
      try { origin = new URL(origin).origin } catch { return false }
      if (permission === 'notifications') return origin === ORIGIN && (!contents || trusted(contents))
      if (origin !== ORIGIN || !trusted(contents) || details.isMainFrame === false) return false
      if (networkPermissions.has(permission)) return Boolean(testProfile) || localNetworkAllowed
      // Media requests go through macOS consent below. Clipboard reads remain denied.
      return allowedPermissions.has(permission)
    })
    ses.setPermissionRequestHandler(async (contents, permission, callback, details) => {
      if (contents === shareArea.window?.webContents && ['media', 'display-capture'].includes(permission) && details.isMainFrame !== false) return callback(true)
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
    const hasScreenAccess = () => screenAccessGranted({
        platform: testProfile ? 'test' : process.platform,
        status: () => systemPreferences.getMediaAccessStatus('screen'),
        listSources: () => desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }),
        askToOpenSettings: async () => (await dialog.showMessageBox(win, {
          type: 'info', message: 'Let KithMoot share your screen',
          detail: 'macOS has not allowed KithMoot to record the screen. In System Settings, open Privacy & Security, then Screen & System Audio Recording, and turn KithMoot on. Quit and reopen KithMoot afterwards.',
          buttons: ['Not now', 'Open System Settings'], defaultId: 1, cancelId: 0,
        })).response === 1,
        openSettings: () => shell.openExternal(SCREEN_SETTINGS_URL),
      })
    configureDisplayCapture = (area = false) => ses.setDisplayMediaRequestHandler(async (request, callback) => {
      const areaFrame = area && request.frame === shareArea.window?.webContents.mainFrame
      const mainFrame = request.frame === win?.webContents.mainFrame && isAppUrl(request.frame?.url ?? '')
      if (!request.frame || !(areaFrame || mainFrame) || !request.userGesture) return refuse(callback)
      if (area) {
        configureDisplayCapture()
        try {
          if (!await hasScreenAccess()) return refuse(callback)
          // The area's own monitor is what the page crops, and so what any
          // redaction box has to be mapped onto.
          await shareArea.capture(request, selection => {
            if (selection?.video) redaction?.capturedDisplay(shareArea.display)
            callback(selection)
          })
        } catch { refuse(callback) }
        return
      }
      await answerDisplayRequest(request, callback, displayChoice({
        request, platform: process.platform, areaMode, redaction,
        screenAccessGranted: hasScreenAccess,
        listSources: () => desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 120, height: 75 } }),
        showMenu: (items, cancel) => Menu.buildFromTemplate([
          ...items.map(({ source, ...item }) => source ? { ...item, icon: source.thumbnail.resize({ width: 80 }) } : item),
          { type: 'separator' }, { label: 'Cancel', click: cancel },
        ]).popup({ window: win, callback: () => setTimeout(cancel, 250) }),
      }))
    // The system picker never tells us what was chosen, so it is used only
    // while no redaction box exists; a box then shows black, not a guess.
    }, { useSystemPicker: !area && !(redaction?.boxes.size) })
    configureDisplayCapture()
    ses.on('will-download', (_event, item) => {
      // Chromium's save dialog provides a destination for attachments.
      item.setSaveDialogOptions({ title: 'Save attachment' })
    })
  }
  win = new BrowserWindow({
    title: 'KithMoot', width: 1320, height: 880, minWidth: 900, minHeight: 640,
    icon: join(here, 'web/pwa-512x512.png'),
    // Follows the OS rather than always dark: the two --bg values from
    // app/src/style.css, so a light-mode launch shows no dark flash before
    // the first paint (finding 17).
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#101114' : '#faf8f3', show: !testProfile,
    webPreferences: {
      session: ses, preload: join(here, 'preload.cjs'), additionalArguments: preloadArguments,
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      backgroundThrottling: false, spellcheck: true,
    },
  })
  // A link goes to the person's browser, never to a window of ours. The one
  // exception is the app opening an empty window and writing the share
  // viewer into it itself (app/src/share-viewer.ts's "Pop out"): there is no
  // address to hand over, so denying it left the button doing nothing at all
  // in the packaged app while it worked in a tab. An empty window inherits
  // this window's own sandbox and preload, and carries no remote content.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (redaction && boxId(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...BOX_WINDOW, title: 'Hidden from share',
          webPreferences: {
            session: ses, preload: join(here, 'preload.cjs'), additionalArguments: preloadArguments,
            nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
            backgroundThrottling: false,
          },
        },
      }
    }
    if (marksOverlay && url === MARKS_URL) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...MARKS_WINDOW, title: 'Marks on your screen',
          webPreferences: {
            session: ses, preload: join(here, 'preload.cjs'), additionalArguments: preloadArguments,
            nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
            backgroundThrottling: false,
          },
        },
      }
    }
    if (url === AREA_URL || windowOpenAction(url) === 'own-window') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          title: 'KithMoot', backgroundColor: '#101114', autoHideMenuBar: true,
          ...(url === AREA_URL && areaMode === 'preview' ? { title: 'Share an area', minWidth: 460, minHeight: 320 } : {}),
          ...(url === AREA_URL && areaMode !== 'preview' ? { transparent: true, backgroundColor: '#00000000', frame: false, alwaysOnTop: true, hasShadow: false, resizable: false, minWidth: 460, minHeight: 200 } : {}),
          webPreferences: {
            session: ses, preload: join(here, 'preload.cjs'), additionalArguments: preloadArguments,
            nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
            backgroundThrottling: false,
          },
        },
      }
    }
    void external(url)
    return { action: 'deny' }
  })
  win.webContents.on('did-create-window', (child, details) => {
    if (details.url === AREA_URL) shareArea.attach(child)
    const id = boxId(details.url)
    if (id && redaction) redaction.attach(child, id)
    if (details.url === MARKS_URL && marksOverlay) marksOverlay.attach(child)
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) { event.preventDefault(); void external(url) }
  })
  win.webContents.on('will-redirect', (event, url) => { if (!isAppUrl(url)) event.preventDefault() })
  win.webContents.on('will-attach-webview', event => event.preventDefault())
  attachContextMenu(win.webContents)
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
    ipcMain.handle('desktop:area-arm', event => { if (!trusted(event.sender) || !shareArea.window) return false; configureDisplayCapture(true); return true })
    ipcMain.handle('desktop:area-state', event => trusted(event.sender) ? shareArea.state() : null)
    ipcMain.handle('desktop:area-check', event => trusted(event.sender) ? shareArea.check() : null)
    // A refused share reads the same to the page whether macOS withheld
    // Screen Recording or the person cancelled the picker, so the page asks.
    // Every capture id a window of this app answers to, so the page can tell a
    // share of KithMoot itself, which would film its own preview, from a share
    // of somebody else's window. See mayShowItself in app/src/self-mirror-guard.ts.
    ipcMain.handle('desktop:own-capture-ids', event => trusted(event.sender)
      ? BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).map(window => window.getMediaSourceId())
      : [])
    ipcMain.handle('desktop:screen-access', event => !trusted(event.sender) ? 'unknown' : process.platform === 'darwin' && !testProfile ? systemPreferences.getMediaAccessStatus('screen') : 'granted')
    ipcMain.handle('desktop:update-state', event => trusted(event.sender) && event.senderFrame === win.webContents.mainFrame ? updates.state() : { phase: 'disabled' })
    ipcMain.handle('desktop:update-install', event => trusted(event.sender) && event.senderFrame === win.webContents.mainFrame && !callActive ? updates.install() : false)
    ipcMain.handle('desktop:redaction-begin', event => {
      if (!trusted(event.sender) || !redaction) return null
      redaction.begin()
      configureDisplayCapture()
      return redaction.state()
    })
    ipcMain.handle('desktop:redaction-state', event => trusted(event.sender) && redaction ? redaction.state() : null)
    ipcMain.on('desktop:redaction-action', (event, id, action, value) => {
      if (!trusted(event.sender) || !redaction || typeof action !== 'string' || (id !== null && typeof id !== 'string')) return
      redaction.action(id, action, value)
    })
    ipcMain.on('desktop:area-action', (event, action, value) => { if (trusted(event.sender)) { shareArea.action(action, value); if (action === 'close') configureDisplayCapture() } })
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
        message: `KithMoot desktop ${app.getVersion()}`, detail: 'Desktop preview. Signed Mac updates download quietly and wait for you to approve a safe restart. On Debian and Ubuntu, updates arrive with your system updates and wait for the same restart; other Linux installs update by hand. Sign in here using your Nostr account or remote signer; browser extensions are not available. Calls, messages and room sync use the same KithMoot protocol.',
      }) }] },
    ]))
    // The share pop-out is a window of ours the app writes into, so it never
    // navigates anywhere. Every other window inherits the same rules as the
    // main one: a link leaves for the person's browser, nothing else opens a
    // window, and nothing here may be navigated to remote content.
    app.on('web-contents-created', (_event, contents) => {
      if (contents === win?.webContents) return
      contents.setWindowOpenHandler(({ url }) => { void external(url); return { action: 'deny' } })
      attachContextMenu(contents)
      contents.on('will-navigate', (event, url) => {
        if (!isAppUrl(url)) { event.preventDefault(); void external(url) }
      })
      contents.on('will-redirect', (event, url) => { if (!isAppUrl(url)) event.preventDefault() })
      contents.on('will-attach-webview', event => event.preventDefault())
    })
    await createWindow()
    updates.start()
    app.on('activate', () => { if (!win) void createWindow() })
  }).catch(error => { console.error('Desktop startup failed:', error.message); app.exit(1) })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
}
