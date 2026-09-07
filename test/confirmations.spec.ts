import { test, expect } from '@playwright/test'
import { RoomAgent } from '../src/agent.js'
import { encodeRoomLink } from '../src/link.js'
import { generateRoomSecret } from '../src/room.js'
import { openRoomDetails } from './browser.js'

test('app confirmations keep messages flowing, preserve drafts on cancel and work with keyboard and large text', async ({ browser, baseURL }, testInfo) => {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1440, height: 900 } })
  await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Workshop', relays: [relay.href], iceUrls: [] })
  const writer = await RoomAgent.join({ link, relays: ['ws://127.0.0.1:7777'], name: 'Rowan' })
  const page = await context.newPage()
  const nativeDialogs: string[] = []
  page.on('dialog', dialog => { nativeDialogs.push(dialog.type()); void dialog.dismiss() })
  try {
    await page.goto(link)
    await page.locator('#displayName').fill('Ada')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.locator('#chatInput').fill('Keep this draft until I choose to discard it')
    await openRoomDetails(page)
    await page.locator('#discardDraft').focus()
    await page.locator('#discardDraft').press('Enter')
    const dialog = page.getByRole('alertdialog', { name: 'Discard this draft?', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('button', { name: 'Discard draft', exact: true })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    await writer.chat.send('The room continues while you decide.')
    await expect(page.locator('#chatLog')).toContainText('The room continues while you decide.')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('#discardDraft')).toBeFocused()
    await expect(page.locator('#chatInput')).toHaveValue('Keep this draft until I choose to discard it')
    await page.locator('#discardDraft').click()
    await page.mouse.click(1, 1)
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('#chatInput')).toHaveValue('Keep this draft until I choose to discard it')
    await page.locator('#discardDraft').click()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({ width, height: 740 })
        expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
        await page.screenshot({ path: testInfo.outputPath(`confirmation-${colorScheme}-${width}.png`) })
      }
    }
    await page.setViewportSize({ width: 320, height: 540 })
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await dialog.getByRole('button', { name: 'Discard draft', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('#chatInput')).toHaveValue('')
    expect(nativeDialogs).toEqual([])
  } finally { writer.leave(); await context.close() }
})

test('device pairing waits for an in-app approval and cancelling leaves the second device unpaired', async ({ browser, baseURL }) => {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' })))
  for (const context of contexts) {
    await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
    await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  }
  const [owner, secondary] = await Promise.all(contexts.map(context => context.newPage()))
  const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Workshop', relays: [relay.href], iceUrls: [] })
  try {
    await owner!.goto(link)
    await owner!.locator('#displayName').fill('Ada')
    await owner!.locator('#join').click()
    await openRoomDetails(owner!)
    await owner!.locator('#addDevice').click()
    await secondary!.goto(await owner!.locator('#pairUrl').inputValue())
    const dialog = owner!.getByRole('alertdialog', { name: 'Add this device?', exact: true })
    await expect(dialog).toBeVisible()
    await expect(secondary!.locator('#join')).toBeDisabled()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(secondary!.locator('#join')).toBeDisabled()
    // A fresh invitation starts a new decision, with the same second device.
    await owner!.locator('#addDevice').click()
    await secondary!.goto('about:blank')
    await secondary!.goto(await owner!.locator('#pairUrl').inputValue())
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Add device', exact: true }).click()
    await expect(secondary!.locator('#join')).toBeEnabled()
    await secondary!.locator('#join').click()
    await expect(secondary!.locator('#roomArea')).toBeVisible()
    await expect(owner!.locator('#roomArea')).toBeVisible()
  } finally { await Promise.all(contexts.map(context => context.close())) }
})
