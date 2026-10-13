import {test, expect} from '@playwright/test'
import {RoomAgent} from '../src/agent.js'
import {agentRelaysFor} from './relays.js'

test('room entry and re-entry show the latest chat, and sending follows the new post', async ({browser, baseURL}, info) => {
  const context = await browser.newContext({ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: {width: 1024, height: 700}})
  const relay = new URL('/__test-relay', baseURL!); relay.protocol = 'wss:'
  await context.routeWebSocket(url => url.protocol === 'wss:' && url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({status: 503, body: ''}))
  let sentAt = Math.floor(Date.now() / 1000) - 100
  const keeper = await RoomAgent.create({base: baseURL!, roomName: 'Chat position', name: 'Keeper', agent: false, ...agentRelaysFor(baseURL!), now: () => sentAt})
  try {
    for (let i = 0; i < 24; i++) {sentAt++; await keeper.chat.send(`Earlier note ${i}. ` + 'Enough chat history to fill the window. '.repeat(5))}
    const page = await context.newPage(); await page.goto(keeper.url)
    await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    const log = page.locator('#chatLog')
    await expect(log.locator('.msg')).toHaveCount(24)
    const gap = () => log.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
    await expect.poll(gap).toBeLessThan(5)
    await log.evaluate(el => {el.scrollTop = 100})
    await expect.poll(gap).toBeGreaterThan(100)
    await page.locator('#backToRooms').click()
    await page.getByRole('button', {name: 'Switch to Chat position', exact: true}).click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(log.locator('.msg')).toHaveCount(24)
    await expect.poll(gap).toBeLessThan(5)
    await log.evaluate(el => {el.scrollTop = 100})
    await page.locator('#chatInput').fill('My new post\n' + 'A longer draft to resize the composer. '.repeat(12))
    await page.locator('#chatInput').press('Enter')
    await expect(log).toContainText('My new post')
    await expect.poll(gap).toBeLessThan(5)
    await expect(log.locator('.msg').last()).toBeInViewport()
    await page.setViewportSize({width: 390, height: 740})
    await expect.poll(gap).toBeLessThan(5)
    await page.screenshot({path: info.outputPath('latest-chat.png')})
  } finally {await keeper.leave(); await context.close()}
})
