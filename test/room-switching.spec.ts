import { test, expect, type Browser } from '@playwright/test'
import { deriveRoom, generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'

async function setup(browser: Browser, base: string) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  const relay = new URL('/__test-relay', base); relay.protocol = 'wss:'
  await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  const rooms = ['Town hall', 'Project room'].map(name => {
    const secret = generateRoomSecret()
    return { roomId: deriveRoom(secret).roomId, name, link: encodeRoomLink(base, { secret, name, relays: [relay.href], iceUrls: [] }), openedAt: Math.floor(Date.now() / 1000), readAt: 0 }
  })
  await context.addInitScript(rooms => {
    for (const room of rooms) localStorage.setItem('kithmoot.room.' + room.roomId, JSON.stringify(room))
  }, rooms)
  const page = await context.newPage()
  await page.goto(rooms[0].link)
  await page.locator('#displayName').fill('Ada')
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  return { context, page, rooms }
}

test('the in-room picker preserves the current conversation and switches directly without a home-screen detour', async ({ browser, baseURL }) => {
  const { context, page, rooms } = await setup(browser, baseURL!)
  try {
    const original = page.url()
    await page.locator('#backToRooms').click()
    await expect(page.getByRole('dialog', { name: 'Switch rooms' })).toBeVisible()
    await expect(page.locator('#roomSwitcherList [aria-current="true"]')).toContainText('Town hall')
    expect(page.url()).toBe(original)
    await page.locator('#roomSearch').fill('project')
    await expect(page.locator('#roomSwitcherList .roomRow')).toHaveCount(1)
    await page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Project room', exact: true }).click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#roomTitle')).toHaveText('Project room')
    expect(new URL(page.url()).hash).toBe(new URL(rooms[1].link).hash)
    await expect(page.locator('#join')).toBeHidden()
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'false')
    await page.locator('#backToRooms').click()
    await page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Town hall', exact: true }).click()
    await expect(page.locator('#roomTitle')).toHaveText('Town hall')
    await expect(page.locator('#roomArea')).toBeVisible()
  } finally { await context.close() }
})

test('unfinished messages stay in their original tab while another room opens separately', async ({ browser, baseURL }) => {
  const { context, page } = await setup(browser, baseURL!)
  try {
    await page.locator('#chatInput').fill('Keep this unfinished message')
    const original = page.url()
    await page.locator('#backToRooms').click()
    await expect(page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Project room', exact: true })).toBeDisabled()
    await expect(page.locator('#roomSwitcherHome')).toBeDisabled()
    await expect(page.locator('#roomSwitcherNote')).toContainText('unfinished')
    const opened = context.waitForEvent('page')
    await page.getByRole('link', { name: 'Open Project room in a new tab' }).click()
    const other = await opened
    await expect(other.locator('#join')).toBeVisible()
    expect(await other.evaluate(() => window.opener === null)).toBe(true)
    await page.locator('#roomSwitcherClose').click()
    await expect(page.locator('#chatInput')).toHaveValue('Keep this unfinished message')
    expect(page.url()).toBe(original)
    await expect(page.locator('#backToRooms')).toBeFocused()
    await page.locator('#backToRooms').click()
    await page.keyboard.press('Escape')
    await expect(page.locator('#roomSwitcher')).not.toBeVisible()
    await expect(page.locator('#chatInput')).toHaveValue('Keep this unfinished message')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally { await context.close() }
})

test('browsing rooms keeps a live call; cancelling a switch leaves the microphone on', async ({ browser, baseURL }) => {
  test.skip(test.info().project.name !== 'chromium', 'Chromium supplies the synthetic microphone')
  const { context, page } = await setup(browser, baseURL!)
  try {
    await page.locator('#callToggle').click()
    await page.locator('#toggleMic').click()
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await page.locator('#backToRooms').click()
    page.once('dialog', dialog => dialog.dismiss())
    await page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Project room', exact: true }).click()
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await expect(page.locator('#roomTitle')).toHaveText('Town hall')
    await page.screenshot({ path: '/tmp/kithmoot-room-switcher.png' })
    page.once('dialog', dialog => dialog.accept())
    await page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Project room', exact: true }).click()
    await expect(page.locator('#roomTitle')).toHaveText('Project room')
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'false')
  } finally { await context.close() }
})

test('a switch never auto-enters as a guest after an account mismatch or an expired intent', async ({ browser, baseURL }) => {
  const { context, page, rooms } = await setup(browser, baseURL!)
  try {
    for (const intent of [
      { account: 'a'.repeat(64), at: Date.now() },
      { account: null, at: Date.now() - 121_000 },
    ]) {
      await page.evaluate(({ value, link }) => {
        sessionStorage.setItem('kithmoot.room-switch.v1', JSON.stringify(value))
        history.replaceState(null, '', link)
      }, { value: { ...intent, hash: new URL(rooms[1].link).hash }, link: rooms[1].link })
      await page.reload()
      await expect(page.locator('#join')).toBeVisible()
      await expect(page.locator('#roomArea')).toBeHidden()
      expect(await page.evaluate(() => sessionStorage.getItem('kithmoot.room-switch.v1'))).toBeNull()
    }
  } finally { await context.close() }
})
