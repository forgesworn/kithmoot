import { test, expect } from '@playwright/test'
import { RoomAgent } from '../src/agent.js'
import { AgentRuntime } from '../src/node/runtime.js'
import { encodeRoomLink, parseRoomLink } from '../src/link.js'
import { goToConversation, open, openRoomDetails } from './browser.js'

test('an agent acknowledges a mention in a named conversation with a visible received time', async ({ browser, baseURL }) => {
  test.setTimeout(45000)
  // WebKit refuses a cleartext WebSocket from this HTTPS page. Both sides
  // use the same local relay through the browser's existing secure proxy.
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const tally = await RoomAgent.create({ base: baseURL!, name: 'Tally', relays: ['ws://127.0.0.1:7777'] })
  const browserLink = encodeRoomLink(baseURL!, { ...parseRoomLink(tally.url), relays: [relay.href] })
  const runtime = new AgentRuntime(tally, { persona: { name: 'Tally', system: '' } }).start()
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' })
  const failures: string[] = []
  const off = runtime.on(event => {
    if (event.type !== 'channel' || !event.addressed || event.message.participant === tally.participant) return
    // The receipt path works without starting a model or finishing another job.
    void runtime.acknowledge(event.channel, event.message.id).catch(err => failures.push(String(err)))
  })
  try {
    await tally.setChannel('security', true)
    const page = await context.newPage()
    await open(page, browserLink, 'Ada')
    await page.locator('#join').click()
    await goToConversation(page, 'security')
    await page.locator('#chatInput').fill('@Tally can you look at this?')
    await page.locator('#chatForm button[type=submit]').click()
    const receipt = page.locator('#chatLog .msg').filter({ hasText: 'can you look at this?' }).getByRole('button', { name: 'Add 👍 reaction, 1', exact: true })
    await expect(receipt).toBeVisible()
    await receipt.hover()
    const details = page.locator('.reactionDetails:popover-open')
    await expect(details).toContainText('Tally')
    await expect(details).toContainText(/Received.*reply may still be pending/)
    expect(failures).toEqual([])
    await goToConversation(page, 'Chat')
    await expect(page.locator('#chatLog .msg')).toHaveCount(0)
  } finally { off(); await context.close(); await runtime.close() }
})


test('Chip completes by name and @all receives acknowledgements from both agents in the same conversation', async ({ browser, baseURL }) => {
  test.setTimeout(60000)
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const tally = await RoomAgent.create({ base: baseURL!, name: 'Tally', relays: ['ws://127.0.0.1:7777'] })
  const chip = await RoomAgent.join({ link: tally.url, name: 'Chip' })
  const browserLink = encodeRoomLink(baseURL!, { ...parseRoomLink(tally.url), relays: [relay.href] })
  const runtimes = [tally, chip].map(agent => new AgentRuntime(agent, { persona: { name: agent === chip ? 'Chip' : 'Tally', system: '' } }).start())
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  const failures: string[] = []
  const addressed: string[][] = [[], []]
  const offs = runtimes.map((runtime, index) => runtime.on(event => {
    if (event.type !== 'channel' || !event.addressed || event.message.reaction || event.message.participant === [tally, chip][index]!.participant) return
    addressed[index]!.push(event.message.text)
    void runtime.acknowledge(event.channel, event.message.id).catch(err => failures.push(String(err)))
  }))
  try {
    await tally.setChannel('workshop', true)
    const page = await context.newPage()
    await open(page, browserLink, 'Ada'); await page.locator('#join').click()
    await goToConversation(page, 'workshop')
    // Explicit recipient keys can name only participants already known to
    // this browser. Wait for both signed roster entries before exercising
    // the compatibility expansion; the everyone sentinel itself reaches both
    // agents even when their presence arrives later.
    await openRoomDetails(page)
    for (const name of ['Tally', 'Chip']) await expect(page.locator('#sheetRoster .rosterRow').filter({ hasText: name })).toBeVisible()
    await page.locator('#roomSheetClose').click()
    const input = page.locator('#chatInput')
    await input.fill('extract these numbers: 3, 7 @Ch please')
    await input.evaluate((el: HTMLTextAreaElement) => {
      const caret = el.value.indexOf(' please'); el.setSelectionRange(caret, caret)
      el.dispatchEvent(new Event('select'))
    })
    await expect(page.locator('#mentions [role=option]')).toHaveCount(1)
    await expect(page.locator('#mentions [role=option]')).toContainText('Chip')
    await input.press('Tab'); await expect(input).toHaveValue('extract these numbers: 3, 7 @Chip please')
    await page.locator('#chatForm button[type=submit]').click()
    await expect.poll(() => addressed[1]).toContain('extract these numbers: 3, 7 @Chip please')
    expect(addressed[0]).toEqual([])
    await input.fill('morning @al')
    const all = page.locator('#mentions [role=option]').filter({ hasText: 'Everyone in this room, including agents' })
    await expect(all).toHaveCount(1)
    await all.dispatchEvent('pointerdown')
    await expect(input).toHaveValue('morning @all ')
    // Keyup/select events after choosing must not reopen the completed name.
    await input.press('ArrowRight')
    await expect(page.locator('#mentions')).toBeHidden()
    await input.press('Enter')
    await expect(input).toHaveValue('')
    const row = page.locator('#chatLog .msg').filter({ hasText: 'morning @all' })
    const receipt = row.getByRole('button', { name: 'Add 👍 reaction, 2', exact: true })
    await expect(receipt).toBeVisible()
    await receipt.hover()
    const details = row.locator('.reactionDetails:popover-open')
    await expect(details.locator('.reactionPerson')).toHaveCount(2)
    // Another room event redraws the log while these details are being read.
    // Keep the same popover open with the refreshed receipt data.
    await tally.channel('workshop').send('Receipt details stay readable')
    await expect(page.locator('#chatLog .msg').filter({ hasText: 'Receipt details stay readable' })).toBeVisible()
    for (const name of ['Chip', 'Tally']) await expect(details.locator('.reactionPerson').filter({ hasText: name })).toContainText('Received')
    await expect(row.locator('.mention.me')).toHaveText('@all')
    for (const agent of [tally, chip]) {
      // Explicit keys also address an older agent whose runtime still
      // interprets the room sentinel as a call for people only.
      expect(agent.channel('workshop').messages().find(m => m.text === 'morning @all')?.mentions?.sort())
        .toEqual(['everyone', tally.participant, chip.participant].sort())
    }
    await tally.channel('workshop').send('@all fixture received', { mentions: ['everyone'] })
    await expect(page.locator('#chatLog .msg').filter({ hasText: '@all fixture received' })).toHaveClass(/mentionsMe/)
    expect(failures).toEqual([])
    await goToConversation(page, 'Chat')
    await expect(page.locator('#chatLog .msg')).toHaveCount(0)
  } finally {
    offs.forEach(off => off()); await context.close()
    await Promise.all(runtimes.map(runtime => runtime.close()))
  }
})
