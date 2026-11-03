import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { nodeBrowserFixture } from '../../test/node-browser-fixture.js'
import { stopIsolatedApp } from './isolated-app.mjs'
import { HOME, ORIGIN } from '../policy.mjs'

const desktop = fileURLToPath(new URL('../', import.meta.url))
test('the actual desktop HTTPS renderer pairs and creates a node room with pinned custom ports', async () => {
  test.skip(!process.env.E2E_NODE_SPRY_BINARY || !process.env.E2E_NODE_SHELTER_BINARY, 'requires checked private backend candidates')
  const origins: string[] = []
  const fixture = await nodeBrowserFixture(ORIGIN, { turnPorts: { udpTcp: 34790, tls: 53499 },
    onRequest: request => { if (request.method === 'POST') origins.push(request.origin ?? '') } })
  const profile = await mkdtemp(join(tmpdir(), 'kithmoot-node-desktop-'))
  const modulePath = join(desktop, 'web/node-qualification.js')
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined, written = false
  try {
    // Test-only bundle in the ignored renderer build. It uses the actual app
    // room runtime and SDK; it does not supply an alternate fetch or signer.
    const output = await build({ stdin: { contents: `
      import { generateSecretKey } from 'nostr-tools/pure'
      import { localIdentity } from './src/identity.js'
      import { claimKithmootNode, parseKithmootNodePairingLink, queryKithmootNodeStatus } from './src/kithmoot-node.js'
      import { memoryDeviceStore } from './app/src/device-store.js'
      import { createBrowserNodeRoom } from './app/src/node-room-runtime.js'
      export async function qualify(link) {
        const owner = localIdentity(generateSecretKey())
        const pair = await claimKithmootNode(parseKithmootNodePairingLink(link), owner)
        const room = await createBrowserNodeRoom(memoryDeviceStore(), pair, owner)
        const status = await queryKithmootNodeStatus(pair, owner)
        return { origin: location.origin, pairedPorts: pair.turnPorts, roomPorts: room.node.turnPorts, phase: room.phase, rooms: status.rooms, ready: status.ready }
      }`, resolveDir: fileURLToPath(new URL('../../', import.meta.url)), sourcefile: 'node-desktop-qualification.mjs' },
      bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022' })
    await writeFile(modulePath, output.outputFiles[0]!.contents, { flag: 'wx' }); written = true
    app = await electron.launch({ executablePath: join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      // This fixture alone uses a self-signed loopback WSS bridge. Production
      // desktop security settings and its allowed HTTPS origin remain intact.
      args: ['--ignore-certificate-errors', `--host-resolver-rules=MAP node.example 127.0.0.1:${fixture.native.port}`, desktop],
      env: { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile } })
    const context = app.context()
    await context.addInitScript(({ websocket }) => {
      const Native = window.WebSocket
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) { super(String(url) === 'wss://node.example/events' ? websocket : url, protocols) }
      }
    }, { websocket: fixture.websocket })
    await context.routeWebSocket(url => !['node.example', 'localhost'].includes(url.hostname), socket => socket.close())
    const page = await app.firstWindow()
    await page.goto(HOME)
    expect(await page.evaluate(() => location.origin)).toBe(ORIGIN)
    const result = await page.evaluate(async link => {
      const module = await import('/j/node-qualification.js')
      return module.qualify(link)
    }, fixture.pairing())
    expect(result).toMatchObject({ origin: ORIGIN, pairedPorts: { udpTcp: 34790, tls: 53499 }, roomPorts: { udpTcp: 34790, tls: 53499 }, phase: 'active', rooms: 1, ready: true })
    expect(origins.length).toBeGreaterThanOrEqual(3)
    // Electron's main-process net.fetch can omit Origin when servicing its
    // HTTPS protocol. The node still requires the exact body-bound signature.
    expect(origins.every(origin => origin === '' || origin === ORIGIN)).toBe(true)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getLastWebPreferences().webSecurity)).toBe(true)
    const version = (await readFile(join(desktop, 'node_modules/electron/dist/version'), 'utf8')).trim()
    console.log(JSON.stringify({ schema: 'kithmoot-node-desktop-origin/1', passed: true, electron: version, ...result, webSecurity: true,
      observedPostOrigins: [...new Set(origins)], actualRenderer: true, actualRoomRuntime: true,
      fixtureNetworkRouting: true, fixtureCertificateException: true, actualDesktopSignInUi: false }))
  } finally {
    await stopIsolatedApp(app, profile)
    if (written) await rm(modulePath)
    await fixture.close(); await rm(profile, { recursive: true, force: true })
  }
})
