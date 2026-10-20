import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { RoomAgent } from '../src/agent.js'
import { agentRelaysFor, testRelaysFor } from './relays.js'
import { encodeRoomLink } from '../src/link.js'
import { generateRoomSecret } from '../src/room.js'
import { accountDevice, signInAccount } from './nostr-account.js'
import { showChats, openRoomMenu, roomMenuItem } from './browser.js'

/**
 * The app shell (calm shell, stage 2): a fixed page with a rail, a list of
 * chats and the main pane; one pane at a time under 900 px with the rail
 * becoming a bottom bar under 600; People for a Nostr sign-in only; the New
 * menu; the keyboard.
 */

test.describe.configure({ mode: 'serial' })

interface Seed { roomId: string; name: string; link: string; pin?: boolean; project?: string }
let keepers: RoomAgent[] = []
let seeds: Seed[] = []

test.beforeAll(async ({ baseURL }) => {
  test.setTimeout(120_000)
  for (const [name, messages, pin, project] of [
    ['Release workshop', ['Perfect. Call at 3?', 'Yes, 3 works for me.'], true],
    ['Priya Natarajan', ['Thanks. I will run the phone checks.'], false],
    ['Town hall', ['Agenda is up.'], false],
    ['Book club', ['Chapter 4 for next week.'], false, 'Reading'],
  ] as const) {
    const keeper = await RoomAgent.create({ base: baseURL!, roomName: name, name: 'Rowan', agent: false, ...agentRelaysFor(baseURL!) })
    for (const text of messages) await keeper.chat.send(text)
    keepers.push(keeper)
    seeds.push({ roomId: keeper.roomId, name, link: keeper.url, pin, project })
  }
})

test.afterAll(async () => { for (const keeper of keepers) await keeper.leave(); keepers = []; seeds = [] })

async function seed(context: BrowserContext, account: string, size?: string) {
  await context.addInitScript(({ seeds, account, size }) => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    const pins: string[] = []
    for (const room of seeds) {
      localStorage.setItem((account ? `kithmoot.account.${account}.` : '') + 'kithmoot.room.' + room.roomId, JSON.stringify({ roomId: room.roomId, name: room.name, link: room.link, openedAt: Math.floor(Date.now() / 1000), readAt: 0 }))
      if (room.pin) pins.push(room.roomId)
      if (room.project) localStorage.setItem(`kithmoot.project.v1.${account || 'visitor'}.${room.roomId}`, room.project)
    }
    localStorage.setItem('kithmoot.pinned-rooms.v1', JSON.stringify(pins))
    if (size) localStorage.setItem('kithmoot.textSize', size)
  }, { seeds, account, size })
}

/** A name-only visitor who already knows the four rooms. */
async function visitor(browser: Browser, baseURL: string, viewport: { width: number; height: number }, options: { size?: string; touch?: boolean; scheme?: 'dark' | 'light'; empty?: boolean } = {}) {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const context = await browser.newContext({
    ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport, hasTouch: !!options.touch, isMobile: !!options.touch,
    colorScheme: options.scheme ?? 'dark',
  })
  await context.routeWebSocket(url => url.protocol === 'wss:' && url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  if (!options.empty) await seed(context, '', options.size)
  const page = await context.newPage()
  page.on('dialog', dialog => { void dialog.accept() })
  return { context, page }
}

/** Signed in with a Nostr account, the four rooms saved to it. */
async function account(browser: Browser, baseURL: string, viewport: { width: number; height: number }, options: { touch?: boolean; scheme?: 'dark' | 'light' } = {}) {
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  const context = await accountDevice(browser, baseURL, secret)
  await seed(context, pubkey, undefined)
  const page = await context.newPage()
  page.on('dialog', dialog => { void dialog.accept() })
  await page.setViewportSize(viewport)
  await page.emulateMedia({ colorScheme: options.scheme ?? 'dark' })
  await signInAccount(page, baseURL)
  await page.goto(baseURL)
  await expect(page.locator('#roomList .roomRow')).toHaveCount(4, { timeout: 30_000 })
  return { context, page }
}

async function joinRoom(page: Page, index = 0) {
  await page.goto('about:blank')
  await page.goto(seeds[index]!.link)
  await expect(page.locator('#displayName:visible, #chatLog:visible').first()).toBeVisible({ timeout: 60_000 })
  if (await page.locator('#displayName').isVisible()) { await page.locator('#displayName').fill('Ada'); await page.locator('#join').click() }
  await expect(page.locator('#chatLog')).toBeVisible({ timeout: 60_000 })
}

const box = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!

test('at 1440 by 900 the rail, the list and the conversation sit side by side and only the panes scroll', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 })
  try {
    await joinRoom(page)
    await expect(page.locator('#rail')).toBeVisible()
    await expect(page.locator('#rooms')).toBeVisible()
    await expect(page.locator('#roomArea')).toBeVisible()
    const rail = await box(page, '#rail'), list = await box(page, '#listColumn'), room = await box(page, '#roomArea')
    expect(Math.round(rail.width)).toBe(76)
    expect(Math.round(list.width)).toBe(300)
    expect(room.x).toBeGreaterThanOrEqual(list.x + list.width)
    // The page itself never scrolls, and says so.
    const page_ = await page.evaluate(() => ({
      scrollHeight: document.scrollingElement!.scrollHeight, innerHeight: window.innerHeight,
      scrollWidth: document.scrollingElement!.scrollWidth, innerWidth: window.innerWidth,
      html: getComputedStyle(document.documentElement).overflow, body: getComputedStyle(document.body).overflow,
      overscroll: [getComputedStyle(document.documentElement).overscrollBehavior, getComputedStyle(document.body).overscrollBehavior],
    }))
    expect(page_.scrollHeight).toBe(page_.innerHeight)
    expect(page_.scrollWidth).toBe(page_.innerWidth)
    expect(page_.html).toBe('hidden'); expect(page_.body).toBe('hidden')
    expect(page_.overscroll.join(' ')).toContain('none')
    // The list and the log are what scroll.
    expect(await page.locator('#roomList').evaluate(el => getComputedStyle(el).overflowY)).toBe('auto')
    expect(await page.locator('#chatLog').evaluate(el => getComputedStyle(el).overflowY)).toMatch(/auto|scroll/)
    // The room open is the selected row.
    await expect(page.locator('#roomList .open[aria-current="true"]')).toHaveAccessibleName('Open Release workshop')
    await expect(page.locator('#railChats')).toHaveAttribute('aria-current', 'page')
  } finally { await context.close() }
})

test('at 820 by 1180 the rail has one pane beside it: opening a room replaces the list and back returns to it', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 820, height: 1180 }, { touch: true })
  try {
    await page.goto(baseURL!)
    await expect(page.locator('#rooms')).toBeVisible()
    await expect(page.locator('#rail')).toBeVisible()
    await expect(page.locator('main')).toBeHidden()
    await page.locator('#roomList').getByRole('button', { name: 'Open Town hall', exact: true }).click()
    await expect(page.locator('#displayName, #chatLog').first()).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('#rooms')).toBeHidden()
    await expect(page.locator('#rail')).toBeVisible()
    if (await page.locator('#displayName').isVisible()) { await page.locator('#displayName').fill('Ada'); await page.locator('#join').click() }
    await expect(page.locator('#chatLog')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('#rooms')).toBeHidden()
    await expect(page.locator('#backToRooms')).toBeVisible()
    await page.locator('#backToRooms').click()
    await expect(page.locator('#rooms')).toBeVisible()
    await expect(page.locator('#chatLog')).toBeHidden()
    // The room is still open behind the list, and its row says so.
    await expect(page.locator('#roomList .open[aria-current="true"]')).toHaveAccessibleName('Open Town hall')
  } finally { await context.close() }
})

test('at 390 by 844 the bottom bar belongs to the list level: labelled, 44 px, gone inside a room', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 390, height: 844 }, { touch: true })
  try {
    await page.goto(baseURL!)
    await expect(page.locator('#rooms')).toBeVisible()
    const bar = page.locator('#rail')
    await expect(bar).toBeVisible()
    const bounds = await box(page, '#rail')
    expect(bounds.y + bounds.height).toBeGreaterThanOrEqual(843)
    // Chats and Boards, with their words showing; People is for a sign-in.
    for (const name of ['Chats', 'Boards']) {
      const item = bar.getByRole('button', { name, exact: true })
      await expect(item).toBeVisible()
      await expect(item.locator('.railLabel')).toBeVisible()
      const b = (await item.boundingBox())!
      expect(b.height, `${name} height`).toBeGreaterThanOrEqual(44)
      expect(b.width, `${name} width`).toBeGreaterThanOrEqual(44)
    }
    await expect(page.locator('#railPeople')).toBeHidden()
    await page.locator('#roomList').getByRole('button', { name: 'Open Priya Natarajan', exact: true }).click()
    await expect(page.locator('#displayName, #chatLog').first()).toBeVisible({ timeout: 60_000 })
    if (await page.locator('#displayName').isVisible()) { await page.locator('#displayName').fill('Ada'); await page.locator('#join').click() }
    await expect(page.locator('#chatLog')).toBeVisible({ timeout: 60_000 })
    await expect(bar).toBeHidden()
    await page.locator('#backToRooms').click()
    await expect(page.locator('#rooms')).toBeVisible()
    await expect(bar).toBeVisible()
  } finally { await context.close() }
})

test('People shows only for a Nostr sign-in, and opening it fills the shell panes and says so', async ({ browser, baseURL }) => {
  // Name only, in a room, and signed out on the start page: no People.
  const named = await visitor(browser, baseURL!, { width: 1440, height: 900 })
  try {
    await named.page.goto(baseURL!)
    await expect(named.page.locator('#rooms')).toBeVisible()
    await expect(named.page.locator('#railPeople')).toBeHidden()
    await joinRoom(named.page)
    await expect(named.page.locator('#railPeople')).toBeHidden()
    await named.page.keyboard.press('Control+2')
    await expect(named.page.locator('#peopleList')).toBeHidden()
  } finally { await named.context.close() }
  const signed = await account(browser, baseURL!, { width: 1440, height: 900 })
  try {
    const { page } = signed
    await expect(page.locator('#railPeople')).toBeVisible()
    await expect(page.locator('#peopleList')).toBeHidden()
    await expect(page.locator('#peoplePane')).toBeHidden()
    const heard = page.evaluate(() => new Promise<string>(resolve => document.addEventListener('shell:destination', event => resolve((event as CustomEvent).detail.destination), { once: true })))
    await page.locator('#railPeople').click()
    expect(await heard).toBe('people')
    await expect(page.locator('#peopleList')).toBeVisible()
    await expect(page.locator('#peoplePane')).toBeVisible()
    await expect(page.locator('#rooms')).toBeHidden()
    await expect(page.locator('#railPeople')).toHaveAttribute('aria-current', 'page')
    await page.keyboard.press('Control+1')
    await expect(page.locator('#peopleList')).toBeHidden()
    await expect(page.locator('#rooms')).toBeVisible()
    await page.keyboard.press('Control+2')
    await expect(page.locator('#peopleList')).toBeVisible()
  } finally { await signed.context.close() }
})

test('Ctrl+K finds a chat, typing filters, Ctrl+1 and 3 switch destinations and the skip links work', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 })
  try {
    await joinRoom(page)
    // Skip links are the first stops, and the two for a room are offered in one.
    const fromTheTop = () => page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute('tabindex') })
    await fromTheTop()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'Skip to messages' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('#chatLog')).toBeFocused()
    await fromTheTop()
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'Skip to message box' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('#chatInput')).toBeFocused()
    await fromTheTop()
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'Skip to chats' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('#homeRoomQuery')).toBeFocused()
    // Ctrl+K from the composer.
    await page.locator('#chatInput').focus()
    await page.keyboard.press('Control+k')
    await expect(page.locator('#homeRoomQuery')).toBeFocused()
    await expect(page.getByRole('searchbox', { name: 'Find a chat or room' })).toBeVisible()
    await page.keyboard.type('book')
    await expect(page.locator('#roomList .roomRow')).toHaveCount(1)
    await expect(page.locator('#roomList .roomRow')).toContainText('Book club')
    await page.keyboard.press('Escape')
    await expect(page.locator('#roomList .roomRow')).toHaveCount(4)
    // Destinations from the keyboard.
    await page.keyboard.press('Control+3')
    await expect(page.locator('#railBoards')).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('#workspaceWorkPanel')).toBeVisible()
    await expect(page.locator('#roomArea')).toBeHidden()
    await page.keyboard.press('Control+1')
    await expect(page.locator('#railChats')).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('#workspaceWorkPanel')).toBeHidden()
    await expect(page.locator('#roomArea')).toBeVisible()
    // The shortcuts are written down.
    await page.keyboard.press('Control+/')
    await expect(page.locator('#keyboardShortcuts')).toContainText('Control / Command + K')
    await expect(page.locator('#keyboardShortcuts')).toContainText('Control / Command + 1, 2, 3')
  } finally { await context.close() }
})

test('the New menu opens with Enter, moves with the arrows, closes with Escape and returns focus to New', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 })
  try {
    await page.goto(baseURL!)
    const opener = page.locator('#newMenuButton')
    await expect(opener).toBeVisible()
    await expect(opener).toHaveAttribute('aria-haspopup', 'menu')
    await expect(opener).toHaveAttribute('aria-expanded', 'false')
    await opener.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: 'New chat or room' })
    await expect(menu).toBeVisible()
    await expect(opener).toHaveAttribute('aria-expanded', 'true')
    // Signed out: no "Message a contact".
    await expect(menu.getByRole('menuitem')).toHaveText(['New room', 'Open an invite link…', 'Join with a code…', 'New project…', 'Projects…'])
    await expect(menu.getByRole('menuitem', { name: 'New room' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem', { name: 'Open an invite link…' })).toBeFocused()
    await page.keyboard.press('End')
    await expect(menu.getByRole('menuitem', { name: 'Projects…' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem', { name: 'New room' })).toBeFocused()
    await page.keyboard.press('j')
    await expect(menu.getByRole('menuitem', { name: 'Join with a code…' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(opener).toBeFocused()
    await expect(opener).toHaveAttribute('aria-expanded', 'false')
    // Tab closes it and carries on.
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(menu).toBeHidden()
    // An item opens the form it names, and Escape closes that too.
    await opener.click()
    await menu.getByRole('menuitem', { name: 'New room' }).click()
    await expect(page.locator('#roomName')).toBeVisible()
    await expect(page.locator('#roomName')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.locator('#roomName')).toBeHidden()
  } finally { await context.close() }
})

for (const [label, viewport, size, touch] of [
  ['320 by 640 at Huge text', { width: 320, height: 640 }, 'huge', true],
  ['390 by 844', { width: 390, height: 844 }, undefined, true],
  ['844 by 390', { width: 844, height: 390 }, undefined, true],
] as const) {
  test(`nothing scrolls sideways at ${label}, on the list or in a room`, async ({ browser, baseURL }) => {
    const { context, page } = await visitor(browser, baseURL!, viewport, { size, touch })
    try {
      const overflow = () => page.evaluate(() => ({
        wide: document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth,
        offenders: [...document.querySelectorAll<HTMLElement>('body *')].filter(el => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && r.right > window.innerWidth + 1 && getComputedStyle(el).position !== 'fixed' && !el.closest('[hidden], #chatFilters, .skipLinks, .sr-only, #parked, dialog:not([open])')
        }).slice(0, 5).map(el => `${el.tagName.toLowerCase()}#${el.id}.${el.className}`),
      }))
      await page.goto(baseURL!)
      await expect(page.locator('#rooms')).toBeVisible()
      expect(await overflow(), 'chats').toEqual({ wide: 0, offenders: [] })
      await joinRoom(page)
      expect(await overflow(), 'room').toEqual({ wide: 0, offenders: [] })
    } finally { await context.close() }
  })
}

for (const scheme of ['dark', 'light'] as const) {
  test(`axe finds nothing on Chats at 1440 and at 390 in ${scheme}`, async ({ browser, baseURL }) => {
    for (const [viewport, touch] of [[{ width: 1440, height: 900 }, false], [{ width: 390, height: 844 }, true]] as const) {
      const { context, page } = await account(browser, baseURL!, viewport, { scheme })
      try {
        await expect(page.locator('#rooms')).toBeVisible()
        const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
        expect(scan.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), `${viewport.width} ${scheme} ${touch}`).toEqual([])
      } finally { await context.close() }
    }
  })
}

test('axe finds nothing on Boards at 1440, and Boards shows in the pane with its two tabs', async ({ browser, baseURL }) => {
  const { context, page } = await account(browser, baseURL!, { width: 1440, height: 900 })
  try {
    await page.locator('#railBoards').click()
    const panel = page.locator('#workspaceWorkPanel')
    await expect(panel).toBeVisible()
    // In the main pane, not over it.
    const pane = await box(page, 'main'), shown = await box(page, '#workspaceWorkPanel')
    expect(shown.x).toBeGreaterThanOrEqual(pane.x)
    expect(shown.x + shown.width).toBeLessThanOrEqual(pane.x + pane.width + 1)
    await expect(page.locator('#rooms')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Needs you' })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'All' })).toBeVisible()
    // Nothing needs this account, so it opens on All.
    await expect(panel.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    await panel.getByRole('button', { name: 'Needs you' }).click()
    await expect(panel.getByRole('button', { name: 'Needs you' })).toHaveAttribute('aria-pressed', 'true')
    const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
    expect(scan.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([])
    // Back to a chat: the panel closes with the destination.
    await page.locator('#roomList').getByRole('button', { name: 'Open Book club', exact: true }).click()
    await expect(panel).toBeHidden()
  } finally { await context.close() }
})

test('in forced colours the selected rail item and the selected chat row keep a visible boundary', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 })
  try {
    await joinRoom(page)
    await page.emulateMedia({ forcedColors: 'active' })
    const row = page.locator('#roomList .roomRow', { has: page.locator('.open[aria-current="true"]') })
    await expect(row).toHaveCount(1)
    await expect.poll(() => row.evaluate(el => { const s = getComputedStyle(el); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 1 })).toBe(true)
    const item = await page.locator('#railChats').evaluate(el => {
      const selected = getComputedStyle(el), other = getComputedStyle(document.getElementById('railBoards')!)
      return { background: selected.backgroundColor, otherBackground: other.backgroundColor, color: selected.color, otherColor: other.color }
    })
    expect(item.background, 'the selected rail item is filled').not.toBe(item.otherBackground)
    expect(item.color).not.toBe(item.otherColor)
  } finally { await context.close() }
})

test('a first run is one sentence and three ways in: no list, no People, no counts', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 }, { empty: true })
  try {
    await page.goto(baseURL!)
    await expect(page.getByRole('heading', { name: 'Start a room, then send the link.' })).toBeVisible()
    await expect(page.getByText('Messages, files and calls for your people and your agents. No account needed.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start a room' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open an invite link' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Join with a code' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Already on Nostr? Sign in' })).toBeVisible()
    await expect(page.locator('#rooms')).toBeHidden()
    await expect(page.locator('#railPeople')).toBeHidden()
    await expect(page.locator('.railCount:visible')).toHaveCount(0)
    await expect(page.locator('#listColumn')).toBeHidden()
    // Start a room opens the form; the other two open theirs.
    await page.getByRole('button', { name: 'Start a room' }).click()
    await expect(page.locator('#roomName')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Open an invite link' }).click()
    await expect(page.locator('#url')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Join with a code' }).click()
    await expect(page.locator('#meetingCodeInput')).toBeVisible()
    await page.keyboard.press('Escape')
    // A phone has no rail and a first run no list header: Settings still has
    // a place, because somebody who needs bigger text needs it first.
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible()
    await page.getByRole('button', { name: 'Settings' }).click()
    await expect(page.locator('#appSettings')).toBeVisible()
  } finally { await context.close() }
})

test('the chips narrow the list, projects get a chip, and an empty filter says so with a way back', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 })
  try {
    await page.goto(baseURL!)
    const chips = page.locator('#chatFilters')
    await expect(chips.getByRole('button')).toHaveText(['All', 'Unread', 'Mentions', 'Reading'])
    await expect(chips.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#roomList .roomRow')).toHaveCount(4)
    await expect(page.locator('#roomList .roomSection h3')).toHaveText(['Pinned', 'Chats'])
    await chips.getByRole('button', { name: 'Reading' }).click()
    await expect(page.locator('#roomList .roomRow')).toHaveCount(1)
    await expect(page.locator('#roomList .roomRow')).toContainText('Book club')
    await chips.getByRole('button', { name: 'Mentions' }).click()
    await expect(page.locator('#roomList .roomRow')).toHaveCount(0)
    await expect(page.locator('#homeRoomResults')).toContainText('No chats match')
    await page.locator('#homeRoomResults').getByRole('button', { name: 'Clear' }).click()
    await expect(page.locator('#roomList .roomRow')).toHaveCount(4)
    await expect(chips.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
  } finally { await context.close() }
})

test('the list is one tab stop: arrows move between rows and Enter opens', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 })
  try {
    await page.goto(baseURL!)
    await expect(page.locator('#roomList .roomRow')).toHaveCount(4)
    const stops = await page.locator('#roomList .open').evaluateAll(buttons => buttons.map(b => (b as HTMLElement).tabIndex))
    expect(stops.filter(index => index === 0)).toHaveLength(1)
    expect(stops.filter(index => index === -1)).toHaveLength(3)
    await page.locator('#roomList .open[tabindex="0"]').focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('#roomList .open').nth(1)).toBeFocused()
    await page.keyboard.press('End')
    await expect(page.locator('#roomList .open').nth(3)).toBeFocused()
    await page.keyboard.press('Home')
    await expect(page.locator('#roomList .open').first()).toBeFocused()
    // The row's menu is its own, with the keyboard model: Right goes to its
    // ⋯, Enter opens it on the first item, Escape closes it back onto the ⋯.
    await page.keyboard.press('ArrowRight')
    const more = page.locator('#roomList .rowMenu').first()
    await expect(more).toBeFocused()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: /More for/ })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem').first()).toBeFocused()
    await expect(menu.getByRole('menuitem')).toHaveText(['Mark as read', 'Copy invite link', 'Open in a new tab', 'Notifications', 'Unpin', 'Add to a project', 'Group on this browser', 'Forget this room'])
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(more).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(page.locator('#roomList .open').first()).toBeFocused()
    // Right-click on a row opens the same menu.
    await page.locator('#roomList').getByRole('button', { name: 'Open Priya Natarajan', exact: true }).click({ button: 'right' })
    await expect(page.getByRole('menu', { name: /More for Priya/ })).toBeVisible()
    await page.keyboard.press('Escape')
    // Enter on a row opens it.
    await page.locator('#roomList .open').nth(2).focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('#displayName, #chatLog').first()).toBeVisible({ timeout: 60_000 })
  } finally { await context.close() }
})

test('back to the list from the start page keeps the room list reachable at every width', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 600, height: 800 })
  try {
    await joinRoom(page, 2)
    await showChats(page)
    await expect(page.locator('#roomList .open[aria-current="true"]')).toHaveAccessibleName('Open Town hall')
  } finally { await context.close() }
})

test('creating a room from the New menu closes the sheet and leaves the door clear', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 1280, height: 900 })
  try {
    const relays = testRelaysFor(baseURL!)!
    await page.addInitScript(urls => localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: urls.map(url => ({ url, read: true, write: true })) })), relays)
    await page.goto(baseURL!)
    await page.locator('#newMenuButton').click()
    await page.getByRole('menuitem', { name: 'New room' }).click()
    await page.locator('#roomName').fill('Door check')
    await page.locator('#create').click()
    await expect(page.locator('#join')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    await page.locator('#displayName').fill('Ada')
    await page.locator('#join').click()
    await expect(page.locator('#chatLog')).toBeVisible({ timeout: 60_000 })
  } finally { await context.close() }
})

// ---------------------------------------------------------------------------
// Stage 3: the room header, the ⋯ menu, the empty room.
// ---------------------------------------------------------------------------

/** Visible controls above the log, outside the rail and the list: what a
 *  person meets before the first message. */
async function controlsAboveLog(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const log = document.getElementById('chatLog')!.getBoundingClientRect()
    const area = document.getElementById('roomArea')!
    const found: string[] = []
    for (const el of area.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')) {
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden' || el.closest('[hidden], dialog:not([open]), [popover]:not(:popover-open)')) continue
      if (r.bottom <= log.top + 1 && !el.closest('.sr-only')) found.push(el.id || el.getAttribute('aria-label') || (el.textContent ?? '').trim().slice(0, 20))
    }
    return found
  })
}

for (const [label, size, touch] of [['1440 by 900', { width: 1440, height: 900 }, false], ['390 by 844', { width: 390, height: 844 }, true]] as const) {
  test(`at ${label} a room has four controls above its log: the way back where there is one, the title, Start call, ⋯ (and Search where it fits)`, async ({ browser, baseURL }) => {
    const { context, page } = await visitor(browser, baseURL!, size, { touch })
    try {
      await joinRoom(page)
      const controls = await controlsAboveLog(page)
      expect(controls.length, controls.join(', ')).toBeLessThanOrEqual(4)
      await expect(page.locator('#callToggle')).toBeVisible()
      await expect(page.locator('#callToggle')).toHaveAccessibleName('Start call')
      await expect(page.locator('#roomMenu')).toHaveAccessibleName('More for this room')
      await expect(page.locator('#roomMenu')).toHaveAttribute('aria-haspopup', 'menu')
      // Search is an icon from 600 px and a menu item below it.
      if (size.width >= 600) await expect(page.locator('#chatSearch')).toHaveAccessibleName('Search in room')
      else await expect(page.locator('#chatSearch')).toBeHidden()
      // None of what the header replaced is still on the screen.
      for (const gone of ['#agentActivity', '#invitePeople', '#inviteQr', '#openAssignments', '#mobileWork']) await expect(page.locator(gone)).toHaveCount(0)
      // The phone's Chat and Call switch waits until this device is on a call.
      await expect(page.locator('#mobileRoomViews')).toBeHidden()
    } finally { await context.close() }
  })
}

test('the ⋯ menu has the keyboard model: Enter opens, arrows move, Right opens Notifications, Escape steps back out and focus returns to the ⋯', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 })
  try {
    await joinRoom(page)
    const more = page.locator('#roomMenu')
    const menu = page.getByRole('menu', { name: 'More for this room' })
    await more.focus()
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    const items = menu.getByRole('menuitem')
    await expect(items.first()).toHaveAccessibleName('Room info')
    await expect(items.first()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(items.nth(1)).toBeFocused()
    await page.keyboard.press('End')
    await expect(items.last()).toHaveAccessibleName('Leave room…')
    await page.keyboard.press('Home')
    // Right on Notifications opens its choices, with the one in force ticked.
    await menu.getByRole('menuitem', { name: 'Notifications', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    const choices = menu.getByRole('menu', { name: 'Notifications' }).getByRole('menuitemradio')
    await expect(choices).toHaveText(['Every message', 'Nothing', 'Use my default'])
    await expect(choices.first()).toBeFocused()
    await expect(choices.nth(2)).toHaveAttribute('aria-checked', 'true')
    // Left, and Escape, close only the submenu and give focus back to its item.
    await page.keyboard.press('ArrowLeft')
    await expect(menu.getByRole('menuitem', { name: 'Notifications', exact: true })).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Escape')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Notifications', exact: true })).toBeFocused()
    // Choosing one writes the room's own mode.
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(menu).toBeHidden()
    await expect(more).toBeFocused()
    expect(await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('kithmoot.notification-scopes.v1.')).map(([, value]) => value))).toEqual(['off'])
    // And a last Escape, from the top level, closes the menu onto the ⋯.
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(more).toBeFocused()
    // Room info is the first item, and Cmd or Ctrl+I says the same.
    await page.keyboard.press('Control+i')
    await expect(page.locator('#roomSheet')).toHaveJSProperty('open', true)
  } finally { await context.close() }
})

test('the menu of a room lists what a person does and leaves out what the room cannot, and a phone gets it as a sheet', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 390, height: 844 }, { touch: true })
  try {
    await joinRoom(page, 2)
    await openRoomMenu(page)
    const menu = page.locator('#roomMoreMenu')
    await expect(menu.getByRole('menuitem')).toHaveText(['Room info', 'Search in room', 'Invite people…', 'Add an agent…', 'Notifications', 'New task…', 'Pin', 'Add to project…', 'Leave room…'])
    // Two groups of separators and no stray one at an edge.
    expect(await menu.evaluate(el => [...el.children].map(child => child.tagName === 'HR' ? '-' : 'i').join('').replace(/i+/g, 'i'))).toBe('i-i-i')
    // A sheet from the bottom edge.
    const bounds = (await menu.boundingBox())!
    expect(Math.round(bounds.x)).toBe(0)
    expect(Math.round(bounds.width)).toBe(390)
    expect(Math.round(bounds.y + bounds.height)).toBe(844)
    // Notifications replace the items, with a way back.
    await menu.getByRole('menuitem', { name: 'Notifications', exact: true }).click()
    await expect(menu.getByRole('menuitem', { name: 'Room info' })).toBeHidden()
    await expect(menu.getByRole('menuitemradio')).toHaveCount(3)
    await menu.getByRole('menuitem', { name: /Back/ }).click()
    await expect(menu.getByRole('menuitem', { name: 'Room info' })).toBeVisible()
    await roomMenuItem(page, 'Invite people…')
    await expect(page.locator('#inviteDialog')).toHaveJSProperty('open', true)
    await page.keyboard.press('Escape')
    await expect(page.locator('#roomMenu')).toBeFocused()
    // Search is here on a phone.
    await roomMenuItem(page, 'Search in room')
    await expect(page.locator('#conversationSearch')).toBeVisible()
  } finally { await context.close() }
})

test('a private chat has no invitation, no agent, no project, and says it is a private chat to leave', async ({ browser, baseURL }) => {
  const secret = generateSecretKey()
  const me = getPublicKey(secret)
  const peer = getPublicKey(generateSecretKey())
  const context = await accountDevice(browser, baseURL!, secret)
  try {
    const page = await context.newPage()
    await page.setViewportSize({ width: 1440, height: 900 })
    await signInAccount(page, baseURL!)
    const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Priya', relays: testRelaysFor(baseURL!) ?? [], iceUrls: [], policy: { tier: 'open', members: [me, peer].sort() } })
    await page.goto('about:blank'); await page.goto(link)
    await expect(page.locator('#join')).toBeEnabled({ timeout: 60_000 })
    await page.locator('#join').click()
    await expect(page.locator('#chatLog')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('#roomWho')).toHaveText('Private chat')
    await openRoomMenu(page)
    await expect(page.locator('#roomMoreMenu').getByRole('menuitem')).toHaveText(['Room info', 'Notifications', 'New task…', 'Pin', 'Leave private chat…'])
    await page.keyboard.press('Escape')
    // No block about nobody being here: nobody is invited by a link.
    await expect(page.locator('#emptyRoom')).toBeHidden()
  } finally { await context.close() }
})

test('an empty room says so once, offers the link and the QR code, and steps aside the moment somebody arrives', async ({ browser, baseURL }) => {
  const keeper = await RoomAgent.create({ base: baseURL!, roomName: 'Fresh room', name: 'Host', agent: false, ...agentRelaysFor(baseURL!) })
  await keeper.leave()
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 }, { empty: true })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL!).origin })
  let late: RoomAgent | undefined
  try {
    await page.goto('about:blank'); await page.goto(keeper.url)
    await expect(page.locator('#displayName')).toBeVisible({ timeout: 60_000 })
    await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    await expect(page.locator('#chatLog')).toBeVisible({ timeout: 60_000 })
    const block = page.locator('#emptyRoom')
    await expect(block).toBeVisible()
    await expect(block.getByText('Nobody else is here yet.', { exact: true })).toBeVisible()
    await expect(block.getByText('Anyone with the link can join.', { exact: true })).toBeVisible()
    // Centred in the log.
    const around = (await page.locator('#chatViewport').boundingBox())!, inside = (await block.boundingBox())!
    expect(Math.abs((inside.x + inside.width / 2) - (around.x + around.width / 2))).toBeLessThan(4)
    await block.getByRole('button', { name: 'Copy invite link', exact: true }).click()
    await expect(page.locator('#status')).toHaveText('Invite link copied.')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await page.locator('#shareUrl').inputValue())
    await block.getByRole('button', { name: 'Show QR code', exact: true }).click()
    await expect(page.locator('#inviteDialog')).toHaveJSProperty('open', true)
    await expect(page.locator('#shareQr')).toBeVisible()
    await page.keyboard.press('Escape')
    // Somebody arrives, and the block goes.
    late = await RoomAgent.join({ link: keeper.url, name: 'Rowan', agent: false, transport: agentRelaysFor(baseURL!).transport })
    await expect(block).toBeHidden({ timeout: 30_000 })
  } finally { await late?.leave(); await context.close() }
})

test('at 320 by 640 with Huge text the header is back, name and ⋯, Start call is in the menu, and two messages and the composer are on screen', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 320, height: 640 }, { size: 'huge', touch: true })
  try {
    await joinRoom(page)
    await expect(page.locator('#callToggle')).toBeHidden()
    await expect(page.locator('#chatSearch')).toBeHidden()
    await expect(page.locator('#roomMenu')).toBeVisible()
    await expect(page.locator('#roomWho')).toBeHidden()
    await openRoomMenu(page)
    await expect(page.locator('#roomMoreMenu').getByRole('menuitem').first()).toHaveAccessibleName('Start call')
    await page.keyboard.press('Escape')
    const log = (await page.locator('#chatLog').boundingBox())!
    const messages = await page.locator('#chatLog [data-message-id]').evaluateAll(rows => rows.map(row => { const r = row.getBoundingClientRect(); return { top: r.top, bottom: r.bottom } }))
    const shown = messages.filter(m => m.top >= log.y - 1 && m.bottom <= log.y + log.height + 1)
    expect(shown.length, 'messages wholly in view').toBeGreaterThanOrEqual(2)
    const composer = (await page.locator('#chatForm').boundingBox())!
    expect(composer.y).toBeGreaterThanOrEqual(0)
    expect(composer.y + composer.height).toBeLessThanOrEqual(640)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  } finally { await context.close() }
})
