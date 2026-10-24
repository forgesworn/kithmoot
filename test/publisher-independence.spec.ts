import { test, expect } from '@playwright/test'
import { chooseCallMore, createRoom, inbound, join, newDeviceContext, open, openCall, SYNTHETIC_MIC, turnOnMedia } from './browser.js'
import { syntheticSource } from './browser-protected-share-fixture.js'

// Exercises real product UI and real local Nostr/WebRTC, not Internet NAT traversal.
test('fresh browser rooms chat, call, protect a share and reconnect with only independent local infrastructure', async ({ browser, baseURL }) => {
  const a = await newDeviceContext(browser, baseURL!), b = await newDeviceContext(browser, baseURL!)
  const externalRequests: string[] = [], externalSockets: string[] = []
  const callConsoleRecords: string[] = []
  for (const context of [a, b]) {
    // Cold contexts, installed before the first page or any room creation.
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        externalRequests.push(url.origin); return route.abort('blockedbyclient')
      }
      return route.continue()
    })
    await context.routeWebSocket(/.*/, socket => {
      const url = new URL(socket.url())
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        externalSockets.push(url.origin); socket.close(); return
      }
      socket.connectToServer()
    })
    await context.addInitScript(SYNTHETIC_MIC)
  }
  try {
    const ada = await a.newPage(), rowan = await b.newPage()
    for (const page of [ada, rowan]) page.on('console', message => {
      if (/\[kithmoot\] call-(declared|ring)/.test(message.text())) callConsoleRecords.push(message.text())
    })
    const link = await createRoom(ada, baseURL!)
    await open(ada, link, 'Ada'); await join(ada)
    await open(rowan, link, 'Rowan'); await join(rowan)
    await ada.locator('#chatInput').fill('Synthetic independent room canary')
    await ada.locator('#chatInput').press('Enter')
    await expect(rowan.locator('#chatLog')).toContainText('Synthetic independent room canary')
    await rowan.locator('#chatInput').fill('Synthetic reply without publisher permission')
    await rowan.locator('#chatInput').press('Enter')
    await expect(ada.locator('#chatLog')).toContainText('Synthetic reply without publisher permission')
    await turnOnMedia(ada); await turnOnMedia(rowan)
    for (const page of [ada, rowan]) {
      await expect.poll(async () => (await page.evaluate(inbound)).framesDecoded, { timeout: 60_000 }).toBeGreaterThan(5)
      await expect.poll(async () => (await page.evaluate(inbound)).audioEnergy, { timeout: 60_000 }).toBeGreaterThan(0)
      // The browser media stack uses no STUN/TURN network outside the fixture.
      const urls = await page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.flatMap(pc => pc.getConfiguration().iceServers ?? []))
      expect(urls).toEqual([])
      expect(await page.evaluate(() => '__kithmootCollectDiagnostics' in window)).toBe(false)
    }

    const pending = ada.waitForEvent('popup')
    await chooseCallMore(ada, 'Share with redaction')
    const popup = await pending; await syntheticSource(popup)
    await popup.getByRole('button', { name: 'Choose a window or tab' }).click()
    await expect(popup.getByRole('button', { name: 'Start protected sharing' })).toBeEnabled()
    await popup.getByRole('button', { name: 'Hide a region', exact: true }).click()
    await popup.getByRole('button', { name: 'Start protected sharing' }).click()
    await expect(ada.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
    await expect(rowan.getByRole('button', { name: 'Expand screen share from Ada' })).toBeVisible({ timeout: 60_000 })
    await expect.poll(async () => (await rowan.evaluate(inbound)).videoStreams).toBeGreaterThanOrEqual(2)
    const remoteShare = rowan.locator('video.screenPreview').first()
    const sharePixels = () => remoteShare.evaluate((element: HTMLVideoElement) => {
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 18
      const ctx = canvas.getContext('2d')!; ctx.drawImage(element, 0, 0, 32, 18)
      return { centre: [...ctx.getImageData(16, 9, 1, 1).data], edge: [...ctx.getImageData(2, 2, 1, 1).data] }
    })
    await expect.poll(async () => (await sharePixels()).edge[1]).toBeGreaterThan(130)
    expect((await sharePixels()).centre[0]).toBeLessThan(80)
    await ada.locator('#toggleScreen').click()
    await expect.poll(() => popup.isClosed()).toBe(true)
    await rowan.reload()
    await join(rowan)
    await expect(rowan.locator('#roomArea')).toBeVisible()
    await openCall(rowan)
    await rowan.locator('#toggleMic').click()
    await expect.poll(async () => (await rowan.evaluate(inbound)).framesDecoded, { timeout: 60_000 }).toBeGreaterThan(5)
    await expect.poll(async () => (await rowan.evaluate(inbound)).audioEnergy, { timeout: 60_000 }).toBeGreaterThan(0)
    await rowan.locator('#chatInput').fill('Synthetic reply after reconnect')
    await rowan.locator('#chatInput').press('Enter')
    await expect(ada.locator('#chatLog')).toContainText('Synthetic reply after reconnect')
    expect(externalRequests, 'the product attempted HTTP outside the independent fixture').toEqual([])
    expect(callConsoleRecords, 'ordinary builds must not print call timeline events').toEqual([])
    // Profile discovery currently tries these independent public relays at startup.
    // All were denied above; the journey must work without any of them. Keep this
    // explicit rather than presenting a pass as proof of no external attempts.
    expect([...new Set(externalSockets)].every(origin => [
      'wss://purplepag.es', 'wss://relay.damus.io', 'wss://relay.primal.net',
    ].includes(origin)), 'an unexpected external runtime dependency was attempted').toBe(true)
    await test.info().attach('bounded-independence-result', { contentType: 'application/json', body: JSON.stringify({
      scope: 'two fresh browser contexts on one local host; independent static assets and test Nostr relay',
      publisherRuntimeAvailable: false, externalHttpAttempts: externalRequests,
      deniedExternalWebSocketOrigins: [...new Set(externalSockets)],
      chat: true, twoWayAudioVideo: true, protectedSharePublished: true, protectedShareDecoded: true, reconnect: true,
      legacyCallEventConsoleRecords: callConsoleRecords.length, diagnosticExportHook: false,
      separateNetworks: false, realProviderSelection: false, noLoggingAudit: false, legalExemptionEstablished: false,
    }, null, 2) })
  } finally { await a.close(); await b.close() }
})
