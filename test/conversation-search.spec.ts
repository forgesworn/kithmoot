import { test, expect, type Browser, type Page } from '@playwright/test'
import { generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { RoomAgent } from '../src/agent.js'
import { goToConversation, openRoomDetails } from './browser.js'
import { withRelays } from './relays.js'

async function setup(browser: Browser, baseURL: string, namedConversations = false) {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  const requests: string[] = []
  context.on('request', request => requests.push(request.url()))
  let link = encodeRoomLink(baseURL, { secret: generateRoomSecret(), name: 'Workshop', relays: [relay.href], iceUrls: [] })
  const writer = namedConversations
    ? await RoomAgent.create({ base: baseURL, roomName: 'Workshop', relays: ['ws://127.0.0.1:7777'], name: 'Rowan' })
    : await RoomAgent.join({ link, relays: ['ws://127.0.0.1:7777'], name: 'Rowan' })
  if (namedConversations) link = withRelays(writer.url, [relay.href])
  const page = await context.newPage()
  await page.goto(link)
  await page.locator('#displayName').fill('Ada')
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  return { page, writer, context, requests }
}

async function search(page: Page, query: string) {
  await openRoomDetails(page)
  await page.getByRole('button', { name: 'Search this conversation', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Search messages' })).toBeVisible()
  await expect(page.locator('#messageSearchQuery')).toBeFocused()
  await page.locator('#messageSearchQuery').fill(query)
}

test('search finds literal text and people, jumps to context and preserves a draft and reading position', async ({ browser, baseURL }) => {
  const { page, writer, context } = await setup(browser, baseURL!)
  try {
    await writer.chat.send('Bring the blue toolbox <img src=x onerror=alert(1)> [.*]')
    // Wire timestamps have one-second resolution. Make this genuinely
    // older than the following messages, rather than relying on id order.
    await page.waitForTimeout(1100)
    for (let i = 0; i < 10; i++) await writer.chat.send(`Workshop note ${i}. ` + 'Give this message room on the screen. '.repeat(6))
    await expect(page.locator('#chatLog .msg')).toHaveCount(11)
    await page.locator('#chatInput').fill('Keep this draft here')
    const originalURL = page.url()
    await search(page, 'TOOLBOX')
    await expect(page.locator('#messageSearchResults li')).toHaveCount(1)
    await expect(page.locator('#messageSearchResults')).toContainText('<img src=x onerror=alert(1)>')
    await expect(page.locator('#messageSearchResults img')).toHaveCount(0)
    await page.locator('#messageSearchQuery').fill('[.*]')
    await expect(page.locator('#messageSearchResults li')).toHaveCount(1)
    await page.locator('#messageSearchQuery').fill('Rowan')
    await expect(page.locator('#messageSearchResults li')).toHaveCount(11)
    await page.locator('#messageSearchQuery').fill('toolbox')
    const selected = page.locator('#messageSearchResults button')
    await selected.focus()
    await selected.press('Enter')
    await expect(page.locator('#conversationSearch')).not.toBeVisible()
    await expect(page.locator('#chatLog .searchTarget')).toBeFocused()
    await expect(page.locator('#chatInput')).toHaveValue('Keep this draft here')
    expect(page.url()).toBe(originalURL)
    const top = await page.locator('#chatLog').evaluate(el => el.scrollTop)
    await writer.chat.send('A new message while you read the old one')
    await expect(page.locator('#chatLog .msg')).toHaveCount(12)
    await expect(page.locator('#chatLog .searchTarget')).toBeFocused({ timeout: 5000 })
    expect(Math.abs(await page.locator('#chatLog').evaluate(el => el.scrollTop) - top)).toBeLessThan(5)
    await expect(page.locator('#newMessages')).toBeVisible()
    await search(page, 'unfindable')
    await expect(page.locator('#messageSearchStatus')).toContainText('No matching messages')
    await page.keyboard.press('Escape')
    await expect(page.locator('#roomMenu')).toBeFocused()
    await expect(page.locator('#chatInput')).toHaveValue('Keep this draft here')
    expect(await page.locator('#messageSearchQuery').inputValue()).toBe('')
    await openRoomDetails(page)
    const agents = page.locator('#channelBar button[data-channel="agents"]')
    await agents.focus()
    await writer.chat.send('One more message while the conversation picker has focus')
    await expect(page.locator('#chatLog .msg')).toHaveCount(13)
    await expect(agents).toBeFocused()
    await page.locator('#roomSheetClose').click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally { await writer.leave(); await context.close() }
})

test('file discovery makes no download requests and search stays in its conversation as messages arrive', async ({ browser, baseURL }) => {
  const { page, writer, context, requests } = await setup(browser, baseURL!)
  try {
    await writer.chat.send('The plan for Saturday', { attachments: [{
      event: '01'.repeat(32), url: `https://files.example/${'ab'.repeat(32)}`, sha256: 'ab'.repeat(32),
      key: 'cd'.repeat(32), name: 'Workshop plans.pdf', size: 65608, type: 'application/pdf',
    }] })
    await expect(page.locator('#chatLog')).toContainText('Workshop plans.pdf')
    await search(page, 'plans.pdf')
    await expect(page.locator('#messageSearchResults li')).toHaveCount(1)
    await page.locator('#messageSearchQuery').fill('')
    await page.getByLabel('Files only').check()
    await expect(page.locator('#messageSearchResults li')).toHaveCount(1)
    expect(requests.filter(url => url.includes('files.example'))).toEqual([])
    await page.locator('#messageSearchClose').click()
    await goToConversation(page, 'Agents')
    await writer.channel('agents').send('An agent conversation about tools')
    await expect(page.locator('#chatLog')).toContainText('An agent conversation about tools')
    await search(page, 'plans.pdf')
    await expect(page.locator('#messageSearchResults li')).toHaveCount(0)
    await expect(page.locator('#messageSearchScope')).toContainText('Agents')
    await page.locator('#messageSearchQuery').fill('tools')
    await expect(page.locator('#messageSearchResults li')).toHaveCount(1)
    await writer.chat.send('tools in another conversation')
    await writer.channel('agents').send('More tools in this conversation')
    await expect(page.locator('#messageSearchResults li')).toHaveCount(2)
    await expect(page.locator('#messageSearchQuery')).toBeFocused()
    await expect(page.locator('#messageSearchResults')).not.toContainText('tools in another conversation')
    expect(requests.filter(url => url.includes('files.example'))).toEqual([])
    await page.locator('#messageSearchClose').click()
    await goToConversation(page, 'Chat')
    await search(page, 'plans.pdf')
    await expect(page.locator('#messageSearchResults li')).toHaveCount(1)
  } finally { await writer.leave(); await context.close() }
})

test('room search finds unvisited conversations, edited replies and files, and returns to results with drafts intact', async ({ browser, baseURL }, testInfo) => {
  const { page, writer, context, requests } = await setup(browser, baseURL!, true)
  try {
    await writer.setChannel('release-notes', true)
    await expect(page.locator('#conversationNav [data-channel=release-notes]')).toBeVisible()
    await writer.chat.send('The blue toolbox is ready for Saturday.')
    await writer.channel('agents').send('A working draft of the plan.')
    const original = writer.channel('agents').messages().find(message => message.text === 'A working draft of the plan.')!
    await writer.channel('agents').send('The blue toolbox belongs upstairs.', { replaces: original.id })
    await writer.channel('agents').send('The blue toolbox reply.', { replyTo: original })
    await writer.channel('release-notes').send('Shared reference', { attachments: [{
      event: '01'.repeat(32), url: `https://files.example/${'ab'.repeat(32)}`, sha256: 'ab'.repeat(32),
      key: 'cd'.repeat(32), name: 'blue-toolbox.pdf', size: 65608, type: 'application/pdf',
    }] })
    await page.locator('#chatInput').fill('Keep my Chat draft')
    await page.locator('#chatSearch').click()
    await expect(page.locator('#messageSearchConversation')).toHaveValue('*')
    await page.locator('#messageSearchQuery').fill('toolbox')
    const results = page.locator('#messageSearchResults')
    await expect(results.locator('li')).toHaveCount(4)
    expect((await results.locator('.searchConversation').allTextContents()).sort()).toEqual(['Chat', 'Agents', 'Agents', 'release-notes'].sort())
    // Filter changes neither the selected conversation nor its draft.
    await page.locator('#messageSearchConversation').selectOption('agents')
    await expect(results.locator('li')).toHaveCount(2)
    await expect(page.locator('#conversationNav [data-channel=""]')).toHaveAttribute('aria-pressed', 'true')
    await page.locator('#messageSearchConversation').selectOption('*')
    const edited = results.locator('button').filter({ hasText: 'The blue toolbox belongs upstairs.' })
    await edited.focus()
    // A background update must refresh results without losing keyboard focus.
    await writer.channel('release-notes').send('A blue toolbox update from the release conversation.')
    await expect(results.locator('li')).toHaveCount(5)
    await expect(edited).toBeFocused()
    await edited.press('Enter')
    await expect(page.locator('#chatLog .searchTarget')).toContainText('The blue toolbox belongs upstairs.')
    await expect(page.locator('#chatLog .searchTarget')).toHaveAttribute('data-message-id', original.id)
    await expect(page.locator('#chatLog .searchTarget')).toBeFocused()
    await expect(page.locator('#conversationNav [data-channel=agents]')).toHaveAttribute('aria-pressed', 'true')
    await page.locator('#chatInput').fill('Keep my Agents draft too')
    await page.locator('#backToSearch').click()
    await expect(page.locator('#messageSearchQuery')).toHaveValue('toolbox')
    await expect(page.locator('#messageSearchConversation')).toHaveValue('*')
    await expect(edited).toBeFocused()
    const reply = results.locator('button').filter({ hasText: 'The blue toolbox reply.' })
    await reply.click()
    await expect(page.locator('#chatLog .thread .searchTarget')).toBeFocused()
    await page.locator('#backToSearch').click()
    await page.locator('#messageSearchFiles').check()
    await expect(results.locator('li')).toHaveCount(1)
    await expect(results).toContainText('blue-toolbox.pdf')
    expect(requests.filter(url => url.includes('files.example'))).toEqual([])
    await results.locator('button').click()
    await expect(page.locator('#conversationNav [data-channel=release-notes]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#chatLog .searchTarget')).toContainText('blue-toolbox.pdf')
    expect(requests.filter(url => url.includes('files.example'))).toEqual([])
    await page.locator('#backToSearch').click()
    await expect(page.locator('#messageSearchFiles')).toBeChecked()
    await page.locator('#messageSearchFiles').uncheck()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({ width, height: 740 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        expect(await page.locator('#conversationSearch').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
        await page.screenshot({ path: testInfo.outputPath(`room-search-${colorScheme}-${width}.png`) })
      }
    }
    await page.setViewportSize({ width: 320, height: 540 })
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    expect(await page.locator('#conversationSearch').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.locator('#messageSearchClose').click()
    await expect(page.locator('#chatSearch')).toBeFocused()
    await expect(page.locator('#messageSearchQuery')).toHaveValue('')
    await page.evaluate(() => { document.documentElement.style.fontSize = '' })
    await page.locator('#conversationNav [data-channel=""]').click()
    await expect(page.locator('#chatInput')).toHaveValue('Keep my Chat draft')
    await page.locator('#conversationNav [data-channel=agents]').click()
    await expect(page.locator('#chatInput')).toHaveValue('Keep my Agents draft too')
  } finally { await writer.leave(); await context.close() }
})

test('search jumps preserve unread activity and focused retractions return to the query', async ({ browser, baseURL }) => {
  const { page, writer, context } = await setup(browser, baseURL!, true)
  try {
    await writer.setChannel('design-review', true)
    await expect(page.locator('#conversationNav [data-channel=design-review]')).toBeVisible()
    await writer.channel('design-review').send('The original compass proposal. ' + 'Make this easy to read. '.repeat(8))
    const original = writer.channel('design-review').messages()[0]!
    // Keep the proposal before the later backlog, regardless of id ordering.
    await page.waitForTimeout(1100)
    for (let i = 0; i < 8; i++) await writer.channel('design-review').send(`Follow-up ${i}. ` + 'Plenty of detail to scroll through. '.repeat(8))
    await expect(page.locator('#conversationNav [data-channel=design-review] .conversationUnread')).toHaveText('9')
    await page.locator('#chatSearch').click()
    await page.locator('#messageSearchQuery').fill('compass')
    const results = page.locator('#messageSearchResults')
    await expect(results.locator('li')).toHaveCount(1)
    await results.locator('button').click()
    await expect(page.locator('#chatLog .searchTarget')).toBeFocused()
    await expect(page.locator('#conversationNav [data-channel=design-review] .conversationUnread')).toHaveText('9')
    await expect(page.locator('#newMessages')).toBeVisible()
    await page.locator('#backToSearch').click()
    await expect(results.locator('button')).toBeFocused()
    await writer.channel('design-review').send('Retracted a message', { retracts: original.id })
    await expect(results.locator('li')).toHaveCount(0)
    await expect(page.locator('#messageSearchQuery')).toBeFocused()
    await expect(page.locator('#messageSearchStatus')).toContainText('No matching messages')
    await page.locator('#messageSearchConversation').selectOption('design-review')
    await page.locator('#messageSearchQuery').fill('Follow-up')
    await expect(results.locator('li')).toHaveCount(8)
    await writer.setChannel('a-new-conversation', true)
    await expect(page.locator('#messageSearchConversation option[value=a-new-conversation]')).toHaveCount(1)
    await expect(page.locator('#messageSearchConversation')).toHaveValue('design-review')
    await expect(results.locator('li')).toHaveCount(8)
    await page.locator('#messageSearchConversation').selectOption('*')
    await writer.channel('a-new-conversation').send('Follow-up from the new conversation.')
    await expect(results.locator('li')).toHaveCount(9)
    await page.keyboard.press('Escape')
    await expect(page.locator('#chatSearch')).toBeFocused()
  } finally { await writer.leave(); await context.close() }
})

test('large room searches reveal all matches and preserve the expanded results on return', async ({ browser, baseURL }) => {
  const { page, writer, context } = await setup(browser, baseURL!, true)
  try {
    // Stay below the per-conversation publication limit; this is a room
    // search across five independent histories, not a rate-limit test.
    for (let channel = 0; channel < 5; channel++) {
      const name = `planning-${channel}`
      await writer.setChannel(name, true)
      for (let message = 0; message < 24; message++) await writer.channel(name).send(`Agenda ${channel}/${message}: next steps for the workshop.`)
    }
    await page.locator('#chatSearch').click()
    await page.locator('#messageSearchQuery').fill('Agenda')
    await expect(page.locator('#messageSearchStatus')).toContainText('120 matching messages')
    const results = page.locator('#messageSearchResults button')
    await expect(results).toHaveCount(100)
    await page.getByRole('button', { name: 'Show 20 more results', exact: true }).click()
    await expect(results).toHaveCount(120)
    await expect(results.nth(100)).toBeFocused()
    const selected = await results.nth(100).getAttribute('data-result-key')
    await results.nth(100).press('Enter')
    await expect(page.locator('#chatLog .searchTarget')).toBeFocused()
    await page.locator('#backToSearch').click()
    await expect(results).toHaveCount(120)
    await expect(page.locator('#messageSearchResults button:focus')).toHaveAttribute('data-result-key', selected!)
    await page.locator('#messageSearchConversation').selectOption('planning-0')
    await expect(results).toHaveCount(24)
    await expect(page.locator('#messageSearchMore')).toBeHidden()
  } finally { await writer.leave(); await context.close() }
})

test('searching while the microphone is on keeps the call live', async ({ browser, baseURL }) => {
  test.skip(test.info().project.name !== 'chromium', 'Chromium provides the synthetic microphone')
  const { page, writer, context } = await setup(browser, baseURL!)
  try {
    await page.locator('#callToggle').click()
    await expect(page.locator('#toggleMic')).toHaveAttribute('aria-pressed', 'false')
    await page.locator('#toggleMic').click()
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await expect(page.locator('#toggleMic')).toHaveAttribute('aria-pressed', 'true')
    await writer.chat.send('Still in the call')
    await expect(page.locator('#chatLog')).toContainText('Still in the call')
    await search(page, 'call')
    await expect(page.locator('#messageSearchResults li')).toHaveCount(1)
    await page.locator('#messageSearchClose').click()
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await expect(page.locator('#toggleMic')).toHaveAttribute('aria-pressed', 'true')
  } finally { await writer.leave(); await context.close() }
})
