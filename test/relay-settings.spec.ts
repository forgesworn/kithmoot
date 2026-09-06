import { test, expect } from '@playwright/test'
import { encodeJoinUrl, generateRoomSecret } from '../src/room.js'

test('relay settings enforce read-only traffic, show health and persist additions and removals', async ({ browser, baseURL }) => {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const readRelay = 'wss://read-only.example/'
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  await context.routeWebSocket(url => url.href !== relay.href && url.href !== readRelay, ws => ws.close())
  const readFrames: unknown[][] = []
  let closedReads = 0
  await context.routeWebSocket(readRelay, ws => {
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw)) as unknown[]; readFrames.push(frame)
      if (frame[0] === 'REQ') ws.send(JSON.stringify(['EOSE', frame[1]]))
    })
    ws.onClose(() => { closedReads++ })
  })
  try {
    const page = await context.newPage()
    await page.goto(encodeJoinUrl(baseURL!, generateRoomSecret(), [relay.href]))
    await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    const open = async () => { await page.locator('#roomMenu').click(); await page.locator('#roomRelaySettings').click() }
    await open()
    await expect(page.locator('#relayList .relayHealth')).toContainText('Connected')
    await page.locator('#relayUrl').fill(readRelay)
    await page.locator('#relayMode').selectOption('read')
    await page.getByRole('button', { name: 'Add relay', exact: true }).click()
    await page.locator('#relaySave').click()
    await expect(page.locator('#relaySettingsStatus')).toContainText('Saved on this device')
    const readRow = page.locator('#relayList .relayRow').filter({ hasText: readRelay })
    await expect(readRow.locator('.relayHealth')).toContainText('Connected')
    await expect.poll(() => readFrames.some(frame => frame[0] === 'REQ')).toBe(true)
    await page.setViewportSize({ width: 320, height: 700 })
    expect(await page.locator('#relaySettings').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/kithmoot-relays-320-${test.info().project.name}.png` })
    await page.locator('#relaySettingsClose').click()
    await page.locator('#chatInput').fill('Only write to the writable relay')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('Only write to the writable relay')
    expect(readFrames.filter(frame => frame[0] === 'EVENT')).toEqual([])
    await open()
    await expect(page.locator('#relayList .relayRow').filter({ hasText: relay.href }).locator('.relayHealth')).toContainText('Last accepted write')
    await page.locator('#relayReconnect').click()
    await expect(readRow.locator('.relayHealth')).toContainText('Connected')
    await page.reload(); await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await open()
    await expect(readRow.locator('select')).toHaveValue('read')
    const beforeRemove = closedReads
    await readRow.getByRole('button', { name: `Remove ${readRelay}`, exact: true }).click()
    await page.locator('#relaySave').click()
    await expect(page.locator('#relayList .relayRow')).toHaveCount(1)
    await expect.poll(() => closedReads).toBeGreaterThan(beforeRemove)
    await page.reload(); await page.locator('#join').click(); await open()
    await expect(page.locator('#relayList .relayRow')).toHaveCount(1)
    expect(readFrames.filter(frame => frame[0] === 'EVENT')).toEqual([])
  } finally { await context.close() }
})
