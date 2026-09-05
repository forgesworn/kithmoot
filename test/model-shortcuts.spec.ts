import { test, expect } from '@playwright/test'
import { generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { RoomAgent } from '../src/agent.js'
import type { ModelShortcut } from '../src/control.js'

test('model menu supports keyboard and touch, sends the selector and rejects stale choices', async ({ browser, baseURL }) => {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Model workshop', relays: [relay.href], iceUrls: [] })
  const clerk = await RoomAgent.join({ link, relays: ['ws://127.0.0.1:7777'], name: 'Tally' })
  let models: ModelShortcut[] = [
    { id: 'astra', label: 'Astra' }, { id: 'opus5', label: 'Opus 5' }, { id: 'fable5', label: 'Fable 5' },
  ]
  const announce = () => clerk.sendControl({
    op: 'catalogue', host: clerk.participant, name: 'Tally',
    agents: [{ id: 'tally', name: 'Tally', models }],
    running: [{ id: 'tally', name: 'Tally', participant: clerk.participant, since: 1 }],
  })
  const off = clerk.onPresenceRequest(request => { if (request.op === 'catalogue?') void announce() })
  try {
    const page = await context.newPage(); await page.goto(link)
    await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await announce()
    const input = page.locator('#chatInput')
    await input.fill('^')
    await expect(page.locator('#mentions [role=option]')).toHaveCount(3)
    await page.setViewportSize({ width: 320, height: 700 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/kithmoot-model-shortcuts-320-${test.info().project.name}.png` })
    await input.press('ArrowDown'); await input.press('Tab')
    await expect(input).toHaveValue('@Tally ^fable5 ')
    await input.fill('@Tally ^as')
    await expect(page.locator('#mentions [role=option]')).toHaveCount(1)
    await input.press('Escape'); await expect(page.locator('#mentions')).toBeHidden()
    await input.fill('@Tally ^op')
    await input.press('Enter')
    await expect(input).toHaveValue('@Tally ^opus5 ')
    await expect(page.locator('#chatLog .mine')).toHaveCount(0)
    await input.pressSequentially('review the fixture')
    await input.press('Enter')
    await expect.poll(() => clerk.chat.messages().some(m => m.text === '@Tally ^opus5 review the fixture')).toBe(true)
    await input.fill('^as')
    await page.locator('#mentions [role=option]').click()
    await expect(input).toHaveValue('@Tally ^astra ')
    await input.fill('@Tally ^astra review another fixture')
    models = models.filter(m => m.id !== 'astra')
    await announce()
    await input.fill('^')
    await expect(page.locator('#mentions [role=option]')).toHaveCount(2)
    await input.fill('@Tally ^astra review another fixture')
    await input.press('Enter')
    await expect(input).toHaveValue('@Tally ^astra review another fixture')
    await expect(page.getByText(/\^astra is not available here/)).toBeVisible()
    await input.fill('^')
    await expect(page.locator('#mentions [role=option]')).toHaveCount(2)
    await page.setViewportSize({ width: 320, height: 700 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/kithmoot-model-shortcuts-withdrawn-${test.info().project.name}.png` })
  } finally { off(); await clerk.leave(); await context.close() }
})
