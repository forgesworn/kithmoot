import { test, expect, type Browser, type Page } from '@playwright/test'
import { RoomAgent } from '../src/agent.js'
import { deriveRoom, generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { withRelays } from './relays.js'

async function setup(browser: Browser, base: string) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1440, height: 900 } })
  const relay = new URL('/__test-relay', base); relay.protocol = 'wss:'
  await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  const rooms = ['Town hall', 'Design workshop', 'Release planning'].map((name, index) => {
    const secret = generateRoomSecret()
    return { roomId: deriveRoom(secret).roomId, name, link: encodeRoomLink(base, { secret, name, relays: [relay.href], iceUrls: [] }), openedAt: 100 + index, readAt: 0 }
  })
  await context.addInitScript(rooms => {
    if (localStorage.getItem('workspace-seeded')) return
    for (const room of rooms) localStorage.setItem('kithmoot.room.' + room.roomId, JSON.stringify(room))
    localStorage.setItem('workspace-seeded', 'true')
  }, rooms)
  const page = await context.newPage()
  return { context, page, rooms, relay: relay.href }
}

async function join(page: Page, link: string) {
  await page.goto(link)
  await page.locator('#displayName').fill('Ada')
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
}

async function project(page: Page, room: string, name: string) {
  await page.getByRole('button', { name: `Set project for ${room}`, exact: true }).click()
  await page.locator('#projectName').fill(name)
  await page.getByRole('button', { name: 'Save project', exact: true }).click()
  await expect(page.locator('#projectEditor')).not.toBeVisible()
}

test('projects group rooms, filter by name, survive reload and remain reachable on mobile', async ({ browser, baseURL }, testInfo) => {
  const { context, page, rooms } = await setup(browser, baseURL!)
  try {
    await join(page, rooms[0]!.link)
    await expect(page.getByRole('complementary', { name: 'Projects and rooms' })).toBeVisible()
    await page.locator('#conversationNav button[data-channel=agents]').click()
    await expect(page.locator('#agentActivityTitle')).toHaveText('No agents here yet')
    await expect(page.locator('#manageAgents')).toBeVisible()
    await project(page, 'Design workshop', 'KithMoot')
    await project(page, 'Release planning', 'KithMoot')
    const group = page.locator('#workspaceRooms section', { has: page.getByRole('heading', { name: 'KithMoot', exact: true }) })
    await expect(group.locator('.workspaceRoom')).toHaveCount(2)
    await page.locator('#workspaceQuery').fill('kithmoot')
    await expect(page.locator('#workspaceRooms .workspaceRoom')).toHaveCount(2)
    await group.getByRole('button', { name: 'Design workshop', exact: true }).click()
    await expect(page.locator('#roomTitle')).toHaveText('Design workshop')
    await expect(page.locator('#workspaceRooms [aria-current=true]')).toHaveText('Design workshop')
    await expect(page.locator('#workspaceRooms h3')).toContainText(['KithMoot', 'No project'])
    await page.locator('#workspaceRooms').getByRole('button', { name: 'Town hall', exact: true }).click()
    await expect(page.locator('#conversationNav button[data-channel=agents]')).toHaveAttribute('aria-pressed', 'true')
    await page.locator('#workspaceRooms').getByRole('button', { name: 'Design workshop', exact: true }).click()
    await page.locator('#chatInput').fill('Keep this draft in Design workshop')
    await page.locator('#workspaceRooms').getByRole('button', { name: 'Town hall', exact: true }).click()
    await expect(page.locator('#roomSwitcher')).toBeVisible()
    await expect(page.locator('#roomSwitcherNote')).toContainText('unfinished')
    await page.keyboard.press('Escape')
    await expect(page.locator('#chatInput')).toHaveValue('Keep this draft in Design workshop')
    await page.locator('#chatInput').fill('')
    await page.keyboard.press('Control+k')
    await expect(page.locator('#roomSearch')).toBeFocused()
    await page.locator('#switcherProject').selectOption({ label: 'KithMoot' })
    await expect(page.locator('#roomSwitcherList .roomRow')).toHaveCount(2)
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 390, height: 740 })
    await expect(page.locator('#workspaceNav')).not.toBeVisible()
    await page.locator('#backToRooms').click()
    await expect(page.locator('#roomSwitcherList .roomRow')).toHaveCount(2)
    await page.screenshot({ path: testInfo.outputPath('mobile-project-picker.png') })
    await project(page, 'Design workshop', '')
    await expect(page.locator('#roomSwitcherList .roomRow')).toHaveCount(1)
    await page.locator('#switcherProject').selectOption('')
    await expect(page.locator('#roomSwitcherList .roomRow')).toHaveCount(2)
    await page.locator('#roomSwitcherHome').click()
    await expect(page.locator('#home')).toBeVisible()
    await page.locator('#homeProject').selectOption({ label: 'KithMoot' })
    await expect(page.locator('#roomList .roomRow')).toHaveCount(1)
    await expect(page.locator('#roomList')).toContainText('Release planning')
  } finally { await context.close() }
})

test('agent exchanges arrive in visible navigation and can be watched or joined without opening settings', async ({ browser, baseURL }, testInfo) => {
  const { context, page, relay } = await setup(browser, baseURL!)
  const keeper = await RoomAgent.create({ base: baseURL!, name: 'Planner', roomName: 'KithMoot workshop', relays: ['ws://127.0.0.1:7777'] })
  const agent = await RoomAgent.join({ link: keeper.url, name: 'Reviewer' })
  try {
    await join(page, withRelays(keeper.url, [relay]))
    await keeper.setChannel('design-review', true)
    const review = page.locator('#conversationNav button[data-channel=design-review]')
    await expect(review).toBeVisible()
    await agent.session.channel('design-review').send('The navigation review is ready.')
    await expect(review.locator('.conversationUnread')).toHaveText('1')
    const agents = page.locator('#conversationNav button[data-channel=agents]')
    await expect(agents).toBeVisible()
    await expect(page.locator('#agentActivityTitle')).toHaveText('2 agents in this room')
    await keeper.session.channel('agents').send('I will map the navigation. Can you review the mobile layout?')
    await agent.session.channel('agents').send('Yes. I will check the room picker and the space left for messages.')
    await expect(agents.locator('.conversationUnread')).toHaveText('2')
    await expect(page.locator('#chatLog')).not.toContainText('I will map the navigation')
    await page.locator('#watchAgents').click()
    await expect(agents).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#chatLog')).toContainText('I will map the navigation')
    await expect(page.locator('#chatLog')).toContainText('I will check the room picker')
    await expect(agents.locator('.conversationUnread')).toHaveCount(0)
    await page.locator('#roomMenu').click()
    await agent.session.channel('agents').send('This arrived while room details covered the conversation.')
    await expect(agents.locator('.conversationUnread')).toHaveText('1')
    await page.locator('#roomSheetClose').click()
    await expect(agents.locator('.conversationUnread')).toHaveCount(0)
    await page.locator('#chatInput').fill('Please include keyboard navigation in the review.')
    await page.locator('#chatInput').press('Enter')
    await expect.poll(() => agent.session.channel('agents').messages().some(message => message.text === 'Please include keyboard navigation in the review.')).toBe(true)
    await expect(page.locator('#roomSheet')).not.toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('desktop-agents.png') })
    await page.locator('#conversationNav button[data-channel=""]').click()
    await agent.session.channel('agents').send('The next update should be visible from Chat.')
    await expect(agents.locator('.conversationUnread')).toHaveText('1')
    await agents.focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('#conversationNav button[data-channel=transcript]')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('#chatForm')).toBeHidden()
    await expect(page.locator('#readOnlyNote')).toBeVisible()
    await agents.click()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 740 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        const composer = await page.locator('#chatForm').boundingBox()
        expect(composer!.y + composer!.height).toBeLessThanOrEqual(740)
        expect((await page.locator('#chatLog').boundingBox())!.height).toBeGreaterThan(150)
        await page.screenshot({ path: testInfo.outputPath(`agents-${colorScheme}-${width}.png`) })
      }
    }
    await page.setViewportSize({ width: 320, height: 540 })
    const shortComposer = await page.locator('#chatForm').boundingBox()
    expect(shortComposer!.y + shortComposer!.height).toBeLessThanOrEqual(540)
    await page.screenshot({ path: testInfo.outputPath('agents-short-phone.png') })
    await page.setViewportSize({ width: 390, height: 740 })
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await page.locator('#chatInput').evaluate(el => el.clientHeight >= parseFloat(getComputedStyle(el).lineHeight) + parseFloat(getComputedStyle(el).paddingTop) + parseFloat(getComputedStyle(el).paddingBottom))).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('agents-large-text.png'), fullPage: true })
    await page.locator('#manageAgents').click()
    await expect(page.locator('#inviteAgents')).toHaveAttribute('open', '')
    await expect(page.locator('#inviteList')).toContainText('Nobody here is offering one')
  } finally { agent.leave(); keeper.leave(); await context.close() }
})

test('refreshing a rekeyed room restores its lock state without announcing old removals again', async ({ browser, baseURL }) => {
  const { context, page, relay } = await setup(browser, baseURL!)
  // A small clock difference proves notices use the authority's timestamp,
  // not the time this browser renders them.
  const keeper = await RoomAgent.create({ base: baseURL!, name: 'Keeper', roomName: 'Standing room', relays: ['ws://127.0.0.1:7777'], now: () => Math.floor(Date.now() / 1000) - 5 })
  const former = await RoomAgent.join({ link: keeper.url, name: 'Former member' })
  let next: RoomAgent | undefined
  try {
    await keeper.remove(former.participant)
    former.leave()
    await join(page, withRelays(keeper.url, [relay]))

    const notices = page.locator('#chatLog > .system:not(.intro)')
    const checkRestored = async (epoch: number, message: string) => {
      await expect(page.locator('#roomArea')).toBeVisible()
      await keeper.session.chat.send(message)
      await expect(page.locator('#chatLog')).toContainText(message)
      await expect(notices).toHaveCount(0)
      expect(keeper.session.epoch).toBe(epoch)
      await page.locator('#roomMenu').click()
      await expect(page.locator('#roomLockState')).toContainText(epoch === 1 ? 'changed once' : `changed ${epoch} times`)
      await page.locator('#roomSheetClose').click()
    }
    await checkRestored(1, 'The existing lock is working.')
    for (let i = 0; i < 2; i++) {
      await page.reload()
      await page.locator('#displayName').fill('Ada')
      await page.locator('#join').click()
      await checkRestored(1, `Still in the same epoch after refresh ${i + 1}.`)
    }

    // A removal made while this reader is present must still be announced.
    next = await RoomAgent.join({ link: keeper.url, name: 'Leaving member' })
    await expect.poll(() => keeper.session.participants().some(view => view.name === 'Ada')).toBe(true)
    let changedAt = 0
    keeper.onEpoch(notice => { changedAt = notice.at })
    await keeper.remove(next.participant)
    await expect(notices.filter({ hasText: 'was removed.' })).toHaveCount(1)
    const changed = notices.filter({ hasText: 'The room moved to epoch 2.' })
    await expect(changed).toHaveCount(1)
    await expect(changed.locator('time')).toHaveAttribute('datetime', new Date(changedAt * 1000).toISOString())

    await page.reload()
    await page.locator('#displayName').fill('Ada')
    await page.locator('#join').click()
    await checkRestored(2, 'The new lock also survives a refresh.')
  } finally {
    next?.leave()
    former.leave()
    keeper.leave()
    await context.close()
  }
})
