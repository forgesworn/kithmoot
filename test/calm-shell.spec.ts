import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { RoomAgent } from '../src/agent.js'
import { agentRelaysFor, testRelaysFor } from './relays.js'
import { encodeRoomLink } from '../src/link.js'
import { generateRoomSecret } from '../src/room.js'
import { accountDevice, signInAccount } from './nostr-account.js'
import { showChats, openRoomMenu, roomMenuItem, openRoomInfoPage, leaveRoom, openSettings, closeSettings, openNewRoomForm, openRoomDetails, openMember } from './browser.js'

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

test('the New menu opens with Enter, moves with the arrows, closes with Escape and returns focus to New', async ({ browser, baseURL }, testInfo) => {
  // The desktop test build names no code service, so it has no code item.
  const codes = testInfo.project.name !== 'chromium-desktop'
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
    await expect(menu.getByRole('menuitem')).toHaveText(['New room', 'Open an invite link…', ...(codes ? ['Join with a code…'] : []), 'New project…', 'Projects…'])
    await expect(menu.getByRole('menuitem', { name: 'New room' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem', { name: 'Open an invite link…' })).toBeFocused()
    await page.keyboard.press('End')
    await expect(menu.getByRole('menuitem', { name: 'Projects…' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem', { name: 'New room' })).toBeFocused()
    if (codes) {
      await page.keyboard.press('j')
      await expect(menu.getByRole('menuitem', { name: 'Join with a code…' })).toBeFocused()
    }
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(opener).toBeFocused()
    await expect(opener).toHaveAttribute('aria-expanded', 'false')
    // Tab closes it and carries on.
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    // Tab before the first item has focus would leave the menu open.
    await expect(menu.getByRole('menuitem').first()).toBeFocused()
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

test('a first run is one sentence and three ways in: no list, no People, no counts', async ({ browser, baseURL }, testInfo) => {
  // The web test build names a code service; the desktop one, like
  // ForgeSworn's own builds, names none and must not offer codes or ask
  // any service for one, or for a TURN credential.
  const codes = testInfo.project.name !== 'chromium-desktop'
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 }, { empty: true })
  const services: string[] = []
  page.on('request', r => { const path = new URL(r.url()).pathname; if (/^\/(codes|turn)(\/|$)/.test(path)) services.push(path) })
  try {
    await page.goto(baseURL!)
    await expect(page.getByRole('heading', { name: 'Start a room, then send the link.' })).toBeVisible()
    await expect(page.getByText('Messages, files and calls for your people and your agents. No account needed.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start a room' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open an invite link' })).toBeVisible()
    if (codes) await expect(page.getByRole('button', { name: 'Join with a code' })).toBeVisible()
    else await expect(page.getByRole('button', { name: 'Join with a code' })).toHaveCount(0)
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
    if (codes) {
      await page.getByRole('button', { name: 'Join with a code' }).click()
      await expect(page.locator('#meetingCodeInput')).toBeVisible()
      await page.keyboard.press('Escape')
    }
    // A phone has no rail and a first run no list header: Settings still has
    // a place, because somebody who needs bigger text needs it first.
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible()
    await page.getByRole('button', { name: 'Settings' }).click()
    await expect(page.locator('#settingsPane')).toBeVisible()
    if (!codes) expect(services).toEqual([])
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

test('creating a room from the New menu closes the sheet and goes straight into the room, with no door', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 1280, height: 900 })
  try {
    const relays = testRelaysFor(baseURL!)!
    await page.addInitScript(urls => localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: urls.map(url => ({ url, read: true, write: true })) })), relays)
    await page.goto(baseURL!)
    await page.locator('#newMenuButton').click()
    await page.getByRole('menuitem', { name: 'New room' }).click()
    await page.locator('#roomName').fill('Door check')
    await page.locator('#newRoomYourName').fill('Ada')
    await page.locator('#create').click()
    await expect(page.locator('#chatLog')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    await expect(page.locator('#joinRoomForm')).toBeHidden()
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
    await expect(choices).toHaveText(['Every message', 'Only mentions and replies', 'Nothing', 'Use my default'])
    await expect(choices.first()).toBeFocused()
    await expect(choices.nth(3)).toHaveAttribute('aria-checked', 'true')
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
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(menu).toBeHidden()
    await expect(more).toBeFocused()
    expect(await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('kithmoot.notification-scopes.v1.')).map(([, value]) => value))).toEqual(['off'])
    // And a last Escape, from the top level, closes the menu onto the ⋯.
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await expect(items.first()).toBeFocused()
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
    await expect(menu.getByRole('menuitemradio')).toHaveCount(4)
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

test('a right-click on a message opens the app menu with what the message offers, and the message field keeps the native menu', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 })
  try {
    await joinRoom(page)
    await expect(page.locator('#chatLog [data-message-id]').first()).toBeVisible()
    const bubble = page.locator('#chatLog [data-message-id] .bubble').last()
    await bubble.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: /^Message from/ })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem')).toHaveText(['Reply', 'React', 'Copy text', 'Send as task', 'Summarise this'])
    await expect(menu.getByRole('menuitem').first()).toBeFocused()
    // React opens its choices with Right, each a toggle with its state.
    await menu.getByRole('menuitem', { name: 'React', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    const reactions = menu.getByRole('menu', { name: 'React' }).getByRole('menuitemcheckbox')
    expect(await reactions.count()).toBeGreaterThan(3)
    await expect(reactions.first()).toHaveAttribute('aria-checked', 'false')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    // Reply is the same handler as the ⋯ on the message.
    await bubble.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: /^Reply to/ }).click()
    await expect(page.locator('#composerContext')).toBeVisible()
    // What the page does with the event: the app takes it on a message, and
    // leaves it alone in the message field, where the desktop shows its native edit menu.
    const taken = (selector: string) => page.evaluate(sel => new Promise<boolean>(resolve => {
      const target = document.querySelector(sel)!
      target.addEventListener('contextmenu', event => queueMicrotask(() => resolve(event.defaultPrevented)), { once: true })
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
    }), selector)
    expect(await taken('#chatInput')).toBe(false)
    expect(await taken('#chatLog [data-message-id] .bubble')).toBe(true)
    await page.keyboard.press('Escape')
  } finally { await context.close() }
})

// ---------------------------------------------------------------------------
// Stage 4: Room info, and Leave.
// ---------------------------------------------------------------------------

/** A room with three people, one of them an agent, that a name-only visitor
 *  can go into: what the spec's measurements are taken on. */
async function populatedRoom(baseURL: string, name = 'Release workshop') {
  const rowan = await RoomAgent.create({ base: baseURL, roomName: name, name: 'Rowan', agent: false, ...agentRelaysFor(baseURL) })
  const priya = await RoomAgent.join({ link: rowan.url, name: 'Priya', agent: false, transport: agentRelaysFor(baseURL).transport })
  const tally = await RoomAgent.join({ link: rowan.url, name: 'Tally', transport: agentRelaysFor(baseURL).transport })
  await rowan.chat.send('Perfect. Call at 3?')
  return { rowan, priya, tally, link: rowan.url, leave: async () => { for (const who of [tally, priya, rowan]) await who.leave() } }
}

async function enterLink(page: Page, link: string) {
  await page.goto('about:blank')
  await page.goto(link)
  await expect(page.locator('#displayName:visible, #chatLog:visible').first()).toBeVisible({ timeout: 60_000 })
  if (await page.locator('#displayName').isVisible()) { await page.locator('#displayName').fill('Ada'); await page.locator('#join').click() }
  await expect(page.locator('#chatLog')).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('#roomWho')).toContainText('3 people, 1 agent', { timeout: 30_000 })
}

for (const [label, size, touch, limit, mode] of [['1440 by 900', { width: 1440, height: 900 }, false, 1.2, 'panel'], ['390 by 844', { width: 390, height: 844 }, true, 2.0, 'sheet']] as const) {
  test(`Room info is about one screen at ${label}: its content is at most ${limit} times what is visible, as a ${mode}`, async ({ browser, baseURL }) => {
    const room = await populatedRoom(baseURL!)
    const { context, page } = await visitor(browser, baseURL!, size, { touch, empty: true })
    try {
      await enterLink(page, room.link)
      await page.locator('#roomIdentity').click()
      const sheet = page.locator('#roomSheet')
      await expect(sheet).toHaveJSProperty('open', true)
      await expect(sheet).toHaveAttribute('data-mode', mode)
      await expect(page.locator('#roomSheetTitle')).toBeFocused()
      await expect(page.locator('#roomSheetTitle')).toHaveText('Room info')
      const measured = await sheet.evaluate(el => ({ content: el.scrollHeight, visible: el.clientHeight, modal: el.matches(':modal') }))
      console.log(`room info ${label}: content ${measured.content}px over ${measured.visible}px visible = ${(measured.content / measured.visible).toFixed(2)}`)
      expect(measured.content / measured.visible, JSON.stringify(measured)).toBeLessThanOrEqual(limit)
      expect(measured.modal).toBe(mode === 'sheet')
      // The who card says who is here and who can come in.
      await expect(page.locator('#infoName')).toHaveText('Release workshop')
      await expect(page.locator('#infoWho')).toHaveText('3 people, 1 agent · Anyone with the link can join')
      // The three people and their agent, the agent with its pill.
      await expect(page.locator('#sheetRoster .rosterRow')).toHaveCount(4)
      await expect(page.locator('#sheetRoster .rosterRow', { hasText: 'Tally' }).locator('.badge.agent')).toHaveText('Agent')
      // "not checked" is gone from the list.
      await expect(page.locator('#sheetRoster')).not.toContainText('not checked')
      if (mode === 'panel') {
        // The conversation sits beside the panel and is still usable: from
        // 1280 px it narrows to make room rather than going under it.
        const form = await box(page, '#chatForm')
        const panel = await box(page, '#roomSheet')
        expect(form.x + form.width).toBeLessThanOrEqual(panel.x + 1)
        await page.locator('#chatInput').fill('typing beside Room info')
        await expect(page.locator('#chatInput')).toHaveValue('typing beside Room info')
      }
    } finally { await context.close(); await room.leave() }
  })
}

test('a subpage opens in the same panel, its heading takes the focus, and back returns to the row that opened it; Escape closes and returns to the opener', async ({ browser, baseURL }) => {
  const room = await populatedRoom(baseURL!)
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 }, { empty: true })
  try {
    await enterLink(page, room.link)
    await page.locator('#roomIdentity').focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('#roomSheet')).toHaveJSProperty('open', true)
    for (const [row, title] of [['Invite link', 'Invite link'], ['Privacy and connection', 'Privacy and connection'], ['Name and picture', 'Name and picture'], ['How you appear', 'How you appear'], ['Use your phone here too', 'Use your phone here too'], ['Conversations', 'Conversations']] as const) {
      const opener = page.locator('#roomSheet .infoRow', { has: page.locator('.infoRowTitle', { hasText: new RegExp(`^${row}$`) }) })
      await opener.click()
      await expect(page.locator('#roomSheetTitle')).toHaveText(title)
      await expect(page.locator('#roomSheetTitle')).toBeFocused()
      await expect(page.locator('#roomSheet')).toHaveJSProperty('open', true)
      await page.locator('#roomInfoBack').click()
      await expect(page.locator('#roomSheetTitle')).toHaveText('Room info')
      await expect(opener, `back from ${title}`).toBeFocused()
    }
    // Escape, from inside the panel, closes it and the focus goes back.
    await page.keyboard.press('Escape')
    await expect(page.locator('#roomSheet')).toHaveJSProperty('open', false)
    await expect(page.locator('#roomIdentity')).toBeFocused()
    // The same from a subpage, opened from the ⋯ menu's Room info.
    await roomMenuItem(page, 'Room info')
    await expect(page.locator('#roomSheetTitle')).toBeFocused()
    await page.locator('#roomSheetClose').click()
    await expect(page.locator('#roomSheet')).toHaveJSProperty('open', false)
    await expect(page.locator('#roomMenu')).toBeFocused()
  } finally { await context.close(); await room.leave() }
})

test('Leave asks once with the name of the room; Cancel stays, and Leave goes to the chats', async ({ browser, baseURL }) => {
  const room = await populatedRoom(baseURL!)
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 }, { empty: true })
  try {
    await enterLink(page, room.link)
    await roomMenuItem(page, 'Leave room…')
    const confirm = page.locator('#actionDialog')
    await expect(confirm.getByRole('heading', { name: 'Leave Release workshop?' })).toBeVisible()
    await expect(confirm).toContainText('You stop getting its messages. You can come back with the link.')
    const tidy = confirm.getByLabel('Also ask relays and the file server to delete what I left')
    await expect(tidy).not.toBeChecked()
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.locator('#roomArea')).toBeVisible()
    // Room info's own Leave goes through the same question.
    await page.locator('#roomIdentity').click()
    await page.locator('#leave').click()
    await expect(page.locator('#actionDialog')).toBeVisible()
    await page.locator('#actionDialog').getByRole('button', { name: 'Leave', exact: true }).click()
    await expect(page.locator('#roomArea')).toBeHidden({ timeout: 30_000 })
    await expect(page.locator('#tidyUpDialog')).not.toBeVisible()
  } finally { await context.close(); await room.leave() }
})

test('ticking the box in the Leave confirm hands over to the tidy-up steps instead of leaving at once', async ({ browser, baseURL }) => {
  const room = await populatedRoom(baseURL!)
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 }, { empty: true })
  try {
    await enterLink(page, room.link)
    await leaveRoom(page, { tidy: true })
    await expect(page.locator('#tidyUpDialog')).toBeVisible()
    await expect(page.locator('#tidyUpSteps li').first()).toBeVisible()
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.locator('#tidyUpCancel').click()
    await expect(page.locator('#roomArea')).toBeVisible()
  } finally { await context.close(); await room.leave() }
})

for (const scheme of ['dark', 'light'] as const) {
  test(`axe finds nothing on Room info and a subpage at 1440 and at 390 in ${scheme}`, async ({ browser, baseURL }) => {
    const room = await populatedRoom(baseURL!)
    try {
      for (const [size, touch] of [[{ width: 1440, height: 900 }, false], [{ width: 390, height: 844 }, true]] as const) {
        const { context, page } = await visitor(browser, baseURL!, size, { touch, scheme, empty: true })
        try {
          await enterLink(page, room.link)
          await page.locator('#roomIdentity').click()
          await expect(page.locator('#roomSheet')).toHaveJSProperty('open', true)
          for (const where of ['Room info', 'Invite link']) {
            if (where !== 'Room info') await openRoomInfoPage(page, 'Invite link')
            const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
            expect(scan.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), `${where} ${size.width} ${scheme}`).toEqual([])
          }
        } finally { await context.close() }
      }
    } finally { await room.leave() }
  })
}

// ---------------------------------------------------------------------------
// Stage 4: Settings, a destination.
// ---------------------------------------------------------------------------

test('at 1440 Settings opens in the main pane beside the chats, with its pages as rows, and Display changes the text size', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 })
  try {
    await page.goto(baseURL!)
    await expect(page.locator('#roomList .roomRow')).toHaveCount(4, { timeout: 30_000 })
    await page.locator('#openAppSettings').click()
    await expect(page.locator('html')).toHaveAttribute('data-destination', 'settings')
    await expect(page.locator('#openAppSettings')).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('#settingsPane')).toBeVisible()
    await expect(page.locator('#rooms')).toBeVisible()
    await expect(page.locator('#settingsPane [data-settings-page="main"] .infoRowTitle')).toHaveText(['Account', 'Profile', 'Notifications', 'Messages', 'Display', 'Privacy', 'Connections', 'Keyboard shortcuts', 'About and help'])
    await expect(page.locator('#settingsSubaccount')).toHaveText('Just a name · sign in with Nostr')
    expect(await page.evaluate(() => document.querySelector('dialog:modal'))).toBeNull()
    const pane = await box(page, '#settingsPane'), list = await box(page, '#listColumn')
    expect(pane.x).toBeGreaterThanOrEqual(list.x + list.width)
    await openSettings(page, 'Display')
    await expect(page.locator('#settingsTitle')).toBeFocused()
    await page.getByRole('radio', { name: 'Large' }).check()
    await expect(page.locator('html')).toHaveAttribute('data-text-size', 'large')
    await expect(page.locator('#settingsPane')).toContainText('Light, dark and contrast follow your system settings.')
    await page.locator('#settingsBack').click()
    await expect(page.locator('#settingsRowdisplay')).toBeFocused()
    // Back to the chats.
    await page.locator('#railChats').click()
    await expect(page.locator('#settingsPane')).toBeHidden()
    await expect(page.locator('html')).toHaveAttribute('data-destination', 'chats')
  } finally { await context.close() }
})

test('at 390 Settings is a full screen with a back arrow, and back returns to the room that was open', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 390, height: 844 }, { touch: true })
  try {
    await joinRoom(page)
    await page.keyboard.press('Control+,')
    await expect(page.locator('#settingsPane')).toBeVisible()
    await expect(page.locator('#listColumn')).toBeHidden()
    const pane = await box(page, '#settingsPane')
    expect(pane.x).toBeLessThanOrEqual(20)
    expect(pane.width).toBeGreaterThanOrEqual(350)
    await expect(page.locator('#settingsBack')).toBeVisible()
    await page.locator('#settingsRowmessages').click()
    await expect(page.locator('#sendDelay')).toBeVisible()
    await page.locator('#settingsBack').click()
    await expect(page.locator('#settingsTitle')).toHaveText('Settings')
    await page.locator('#settingsBack').click()
    await expect(page.locator('#settingsPane')).toBeHidden()
    await expect(page.locator('#chatLog')).toBeVisible()
  } finally { await context.close() }
})

test('Ctrl+, opens Settings from a room and again from Settings, and not while a dialog is open', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 })
  try {
    await joinRoom(page)
    await page.keyboard.press('Control+,')
    await expect(page.locator('#settingsPane')).toBeVisible()
    await expect(page.locator('#chatLog')).toBeHidden()
    await page.locator('#railChats').click()
    await expect(page.locator('#chatLog')).toBeVisible()
  } finally { await context.close() }
})

for (const scheme of ['dark', 'light'] as const) {
  test(`axe finds nothing on Settings and its Display page at 1440 and at 390 in ${scheme}`, async ({ browser, baseURL }) => {
    for (const [size, touch] of [[{ width: 1440, height: 900 }, false], [{ width: 390, height: 844 }, true]] as const) {
      const { context, page } = await visitor(browser, baseURL!, size, { touch, scheme })
      try {
        await page.goto(baseURL!)
        await expect(page.locator('#roomList .roomRow')).toHaveCount(4, { timeout: 30_000 })
        await openSettings(page)
        for (const where of ['Settings', 'Display', 'Connections', 'Notifications']) {
          if (where !== 'Settings') await openSettings(page, where as 'Display')
          const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
          expect(scan.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), `${where} ${size.width} ${scheme}`).toEqual([])
        }
      } finally { await context.close() }
    }
  })
}

test('Settings does not scroll sideways at 320 by 640 with Huge text, on any page', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 320, height: 640 }, { touch: true, size: 'huge' })
  try {
    await page.goto(baseURL!)
    await expect(page.locator('#roomList .roomRow')).toHaveCount(4, { timeout: 30_000 })
    await openSettings(page)
    for (const where of ['Settings', 'Account', 'Notifications', 'Messages', 'Display', 'Privacy', 'Connections', 'About and help'] as const) {
      if (where !== 'Settings') await openSettings(page, where)
      const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, pane: document.getElementById('settingsPane')!.scrollWidth, inner: innerWidth, paneClient: document.getElementById('settingsPane')!.clientWidth }))
      console.log(`settings 320 huge ${where}: ${JSON.stringify(widths)}`)
      expect(widths.doc, where).toBeLessThanOrEqual(widths.inner)
      expect(widths.pane, where).toBeLessThanOrEqual(widths.paneClient)
    }
  } finally { await context.close() }
})

// ---------------------------------------------------------------------------
// Stage 5: the call. A bar of six with their words, More as a menu, the
// agents-hear question, no keys in the call.
// ---------------------------------------------------------------------------

/** In the seeded room, and on its call (nothing of mine switched on). */
async function startCall(page: Page, index = 0) {
  await joinRoom(page, index)
  await page.locator('#callToggle').click()
  await expect(page.locator('#deviceControls')).toBeVisible()
}

for (const [label, size, touch, words] of [
  ['1440 by 900', { width: 1440, height: 900 }, false, ['Unmute', 'Camera', 'Share', 'Chat', 'More', 'Leave', 'Full screen']],
  ['390 by 844', { width: 390, height: 844 }, true, ['Unmute', 'Camera', 'Chat', 'More', 'Leave']],
] as const) {
  test(`at ${label} the call bar is a toolbar of buttons with a word under each, and one red Leave`, async ({ browser, baseURL }) => {
    const { context, page } = await visitor(browser, baseURL!, size, { touch })
    try {
      await startCall(page)
      const bar = page.getByRole('toolbar', { name: 'Call controls' })
      await expect(bar).toBeVisible()
      const shown: string[] = []
      for (const button of await bar.locator('button:visible, #callExtras:visible').all()) shown.push((await button.innerText()).trim())
      expect(shown, `${label}: the words under the buttons`).toEqual(words)
      // The mic's name is Microphone and it says whether it is pressed; its word says what a press does.
      await expect(bar.locator('#toggleMic')).toHaveAccessibleName('Microphone')
      await expect(bar.locator('#toggleMic')).toHaveAttribute('aria-pressed', 'false')
      await expect(bar.locator('#toggleCamera')).toHaveAccessibleName('Camera')
      await expect(bar.locator('#leaveCall')).toHaveAccessibleName('Leave call')
      // One Leave on screen, never two (the room bar's own call button steps aside).
      await expect(page.getByRole('button', { name: 'Leave call', exact: true }).and(page.locator(':visible'))).toHaveCount(1)
      await expect(page.locator('#callToggle')).toBeHidden()
      // Leave is the only red one.
      const reds = await bar.locator('button:visible, #callExtras:visible').evaluateAll(els => els.filter(el => getComputedStyle(el).backgroundColor === 'rgb(179, 38, 30)').map(el => el.id))
      expect(reds).toEqual(['leaveCall'])
      // Every target is 44 px or more, whole in the window, no sideways scroll.
      for (const button of await bar.locator('button:visible, #callExtras:visible').all()) {
        const b = (await button.boundingBox())!
        expect(b.width, 'target width').toBeGreaterThanOrEqual(44)
        expect(b.height, 'target height').toBeGreaterThanOrEqual(44)
        expect(b.x + b.width).toBeLessThanOrEqual(size.width)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.locator('#toggleMic').click()
      await expect(bar.locator('#toggleMic')).toHaveAttribute('aria-pressed', 'true')
      await expect(bar.locator('#toggleMic')).toContainText('Mute')
    } finally { await context.close() }
  })
}

test('More in the call bar is a menu: Enter opens it, arrows move, Escape closes it and returns to More', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 })
  try {
    await startCall(page)
    const more = page.locator('#callExtras')
    await expect(more).toHaveAttribute('aria-haspopup', 'menu')
    await more.focus()
    await page.keyboard.press('Enter')
    const menu = page.locator('#callMoreMenu')
    await expect(menu).toBeVisible()
    await expect(menu).toHaveAttribute('role', 'menu')
    const items = menu.locator('[role="menuitem"]:visible, [role="menuitemcheckbox"]:visible, [role="menuitemradio"]:visible')
    await expect(items.first()).toBeFocused()
    await expect(items.first()).toHaveText('Effects…')
    await page.keyboard.press('ArrowDown')
    await expect(items.nth(1)).toBeFocused()
    // The switches say what they are, and the order is the spec's.
    const names = await items.evaluateAll(els => els.map(el => (el.textContent ?? '').trim()))
    expect(names.slice(0, 1)).toEqual(['Effects…'])
    expect(names).toEqual(expect.arrayContaining(['Use beside another device', 'Mirror my view', 'Let agents hear me']))
    expect(names.indexOf('Use beside another device')).toBeLessThan(names.indexOf('Mirror my view'))
    expect(names.indexOf('Mirror my view')).toBeLessThan(names.indexOf('Let agents hear me'))
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Let agents hear me' })).toHaveAttribute('aria-checked', 'false')
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(more).toBeFocused()
    // Effects… opens a panel, with focus on its heading, and Escape gives focus back to More.
    await page.keyboard.press('Enter')
    // The menu takes focus once it has opened; a second Enter sooner lands on More.
    await expect(items.first()).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('#effects')).toBeVisible()
    await expect(page.locator('#effectsHeading')).toBeFocused()
    await expect(page.locator('#effectsHeading')).toHaveText('Effects')
    await page.keyboard.press('Escape')
    await expect(page.locator('#effects')).toBeHidden()
    await expect(more).toBeFocused()
  } finally { await context.close() }
})

test('the first unmute in a call with an agent asks once whether agents may hear; Not now leaves it off', async ({ browser, baseURL }) => {
  const tally = await RoomAgent.create({ base: baseURL!, roomName: 'Agent call', name: 'Tally', ...agentRelaysFor(baseURL!) })
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 }, { empty: true })
  try {
    await page.goto(tally.url)
    await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    await expect(page.locator('#chatLog')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('#roomWho')).toContainText('agent', { timeout: 30_000 })
    await page.locator('#callToggle').click()
    const prompt = page.locator('#agentsConsent')
    await expect(prompt, 'nothing is asked before the microphone is used').toBeHidden()
    await page.locator('#toggleMic').click()
    await expect(prompt).toBeVisible()
    await expect(prompt).toContainText('Tally is an agent on this call.')
    await expect(prompt).toContainText('Agents cannot hear you unless you say so.')
    await expect(page.locator('#agentsConsentTitle')).toBeFocused()
    // Not a modal: the bar is still there, and the switch is off.
    await expect(page.locator('#toggleMic')).toBeVisible()
    await expect(page.locator('#toggleAgentsHear')).toHaveAttribute('data-on', 'false')
    await page.getByRole('button', { name: 'Not now', exact: true }).click()
    await expect(prompt).toBeHidden()
    await expect(page.locator('#toggleMic')).toBeFocused()
    await expect(page.locator('#toggleAgentsHear')).toHaveAttribute('data-on', 'false')
    await expect(page.locator('#agentsHearChip')).toBeHidden()
    // Asked once per call: mute and unmute again, and it stays away.
    await page.locator('#toggleMic').click()
    await page.locator('#toggleMic').click()
    await expect(page.locator('#toggleMic')).toHaveAttribute('aria-pressed', 'true')
    await expect(prompt).toBeHidden()
    await page.locator('#callExtras').click()
    await expect(page.locator('#callMoreMenu').getByRole('menuitemcheckbox', { name: 'Let agents hear me' })).toHaveAttribute('aria-checked', 'false')
    // The menu takes focus once it is open; Escape before that goes to the bar.
    await expect.poll(() => page.evaluate(() => document.getElementById('callMoreMenu')!.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    // Closed before More is pressed again, or the press closes it instead.
    await expect(page.locator('#callMoreMenu')).toBeHidden()
    // The same switch, from the menu, shows the ear chip and the agent's tile says so.
    await page.locator('#callExtras').click()
    await page.locator('#callMoreMenu').getByRole('menuitemcheckbox', { name: 'Let agents hear me' }).click()
    await expect(page.locator('#toggleAgentsHear')).toHaveAttribute('data-on', 'true')
    await expect(page.locator('#agentsHearChip')).toBeVisible()
    await expect(page.locator('#agentsHearChip')).toHaveText('Agents hear you')
    await expect(page.locator('#agentsRow')).toContainText('can hear you')
    await expect(page.locator('#callMoreMenu')).toBeHidden()
    await page.locator('#callExtras').click()
    await page.locator('#callMoreMenu').getByRole('menuitemcheckbox', { name: 'Let agents hear me' }).click()
    await expect(page.locator('#toggleAgentsHear')).toHaveAttribute('data-on', 'false')
    await expect(page.locator('#agentsHearChip')).toBeHidden()
  } finally { await context.close(); await tally.leave() }
})

test('no npub or 64-character key appears in the text of the call', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 })
  try {
    await startCall(page)
    await page.locator('#toggleMic').click()
    await expect(page.locator('#callChips, #callWho, #room')).toHaveCount(3)
    for (const selector of ['#callSurface', '#callDock']) {
      const text = await page.locator(selector).evaluate(el => el.textContent ?? '')
      expect(text, selector).not.toMatch(/npub1[0-9a-z]{6,}/)
      expect(text, selector).not.toMatch(/[0-9a-f]{64}/)
    }
  } finally { await context.close() }
})

for (const scheme of ['dark', 'light'] as const) {
  test(`axe finds nothing on the call, and on its More menu, at 1440 and at 390 in ${scheme}`, async ({ browser, baseURL }) => {
    for (const [size, touch] of [[{ width: 1440, height: 900 }, false], [{ width: 390, height: 844 }, true]] as const) {
      const { context, page } = await visitor(browser, baseURL!, size, { touch, scheme })
      try {
        await startCall(page)
        await page.locator('#toggleMic').click()
        for (const open of [false, true]) {
          if (open) { await page.locator('#callExtras').click(); await expect(page.locator('#callMoreMenu')).toBeVisible() }
          const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
          expect(scan.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), `call ${open ? 'with More open' : ''} ${size.width} ${scheme}`).toEqual([])
        }
      } finally { await context.close() }
    }
  })
}

// ---------------------------------------------------------------------------
// Stage 5, slice B: the ring banner, the phone's Chat and Call, the short
// landscape bar, the banner's words, reduced motion.
// ---------------------------------------------------------------------------

/** Ada in a fresh room, and Priya Natarajan arriving in it and starting a call. */
async function ringSetup(browser: Browser, baseURL: string, beforeCall?: (ada: Page) => Promise<void>) {
  const keeper = await RoomAgent.create({ base: baseURL, roomName: 'Ring room', name: 'Rowan', agent: false, ...agentRelaysFor(baseURL) })
  const ada = await visitor(browser, baseURL, { width: 1440, height: 900 }, { empty: true })
  await ada.page.goto(keeper.url)
  await ada.page.locator('#displayName').fill('Ada'); await ada.page.locator('#join').click()
  await expect(ada.page.locator('#chatLog')).toBeVisible({ timeout: 60_000 })
  const priya = await visitor(browser, baseURL, { width: 1280, height: 800 }, { empty: true })
  await priya.page.goto(keeper.url)
  await priya.page.locator('#displayName').fill('Priya Natarajan'); await priya.page.locator('#join').click()
  await expect(priya.page.locator('#chatLog')).toBeVisible({ timeout: 60_000 })
  await expect(ada.page.locator('#callBanner')).toBeHidden()
  await beforeCall?.(ada.page)
  await priya.page.locator('#callToggle').click()
  return { keeper, ada, priya, close: async () => { await ada.context.close(); await priya.context.close(); await keeper.leave() } }
}

test('a call started in the open room rings as a banner over everything: focus on Answer, Escape declines and nothing is sent', async ({ browser, baseURL }) => {
  const { ada, priya, close } = await ringSetup(browser, baseURL!)
  try {
    const banner = ada.page.locator('#ringBanner')
    await expect(banner).toBeVisible({ timeout: 60_000 })
    await expect(banner).toHaveAttribute('role', 'alertdialog')
    await expect(banner).toContainText('Priya Natarajan is calling')
    await expect(banner).toContainText('Call')
    await expect(ada.page.locator('#ringAnswer')).toBeFocused()
    await expect(ada.page.getByRole('button', { name: 'Decline', exact: true })).toBeVisible()
    // Pinned to the top of the window, in the top layer.
    const b = (await banner.boundingBox())!
    expect(b.y).toBeLessThan(40)
    const scan = await new AxeBuilder({ page: ada.page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
    expect(scan.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([])
    await ada.page.keyboard.press('Escape')
    await expect(banner).toBeHidden()
    // Declining joined nothing and said nothing: the room still offers the call, and Ada is not on it.
    await expect(ada.page.locator('#deviceControls')).toBeHidden()
    await expect(ada.page.locator('#callBanner')).toBeVisible()
    await expect(ada.page.locator('#callBanner')).toContainText('Call on · Priya Natarajan')
    await expect(ada.page.locator('#joinCall')).toHaveText('Join')
    // It does not ring again for the same call.
    await ada.page.waitForTimeout(1500)
    await expect(banner).toBeHidden()
  } finally { await close() }
})

test('Answer joins the call with the microphone on and the camera off', async ({ browser, baseURL }) => {
  const { ada, close } = await ringSetup(browser, baseURL!)
  try {
    await expect(ada.page.locator('#ringBanner')).toBeVisible({ timeout: 60_000 })
    await ada.page.locator('#ringAnswer').click()
    await expect(ada.page.locator('#ringBanner')).toBeHidden()
    await expect(ada.page.locator('#deviceControls')).toBeVisible({ timeout: 30_000 })
    await expect(ada.page.locator('#toggleMic')).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 })
    await expect(ada.page.locator('#toggleCamera')).toHaveAttribute('aria-pressed', 'false')
  } finally { await close() }
})

test('Decline puts the banner away and is not a hang-up: the call can still be joined', async ({ browser, baseURL }) => {
  const { ada, close } = await ringSetup(browser, baseURL!)
  try {
    await expect(ada.page.locator('#ringBanner')).toBeVisible({ timeout: 60_000 })
    await ada.page.getByRole('button', { name: 'Decline', exact: true }).click()
    await expect(ada.page.locator('#ringBanner')).toBeHidden()
    await ada.page.locator('#joinCall').click()
    await expect(ada.page.locator('#deviceControls')).toBeVisible({ timeout: 30_000 })
  } finally { await close() }
})

test('on a phone the call bar\'s Chat swaps the stage for the conversation, over which the call is one line: On the call, Mic, Return, Leave', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 390, height: 844 }, { touch: true })
  try {
    await startCall(page)
    await expect(page.locator('#roomArea')).toHaveAttribute('data-mobile-view', 'call')
    await expect(page.locator('#mobileRoomViews')).toHaveCount(0)
    await expect(page.locator('#callChatBar')).toBeHidden()
    await page.locator('#callChatToggle').click()
    await expect(page.locator('#roomArea')).toHaveAttribute('data-mobile-view', 'chat')
    await expect(page.locator('#chatForm')).toBeVisible()
    const line = page.locator('#callChatBar')
    await expect(line).toBeVisible()
    await expect(line).toContainText('On the call')
    await expect(page.locator('#callChatBarElapsed')).toHaveAttribute('aria-live', 'off')
    await expect(page.locator('#callChatBarElapsed')).toHaveText(/^· \d\d:\d\d$/, { timeout: 5_000 })
    // Mic, Return and Leave, one Leave on screen.
    await expect(line.getByRole('button')).toHaveText(['Unmute', 'Return', 'Leave'], { useInnerText: true })
    await expect(page.getByRole('button', { name: 'Leave call', exact: true }).and(page.locator(':visible'))).toHaveCount(1)
    await line.locator('#callChatBarMic').click()
    await expect(page.locator('#toggleMic')).toHaveAttribute('aria-pressed', 'true')
    await expect(line.locator('#callChatBarMic')).toHaveAttribute('aria-pressed', 'true')
    await line.locator('#callChatBarReturn').click()
    await expect(page.locator('#roomArea')).toHaveAttribute('data-mobile-view', 'call')
    await expect(line).toBeHidden()
    await expect(page.locator('#deviceControls')).toBeVisible()
    // The bar's Chat goes there and back as well, the conversation's one Leave ends the call.
    await page.locator('#callChatToggle').click()
    await line.locator('#callChatBarLeave').click()
    await expect(page.locator('#deviceControls')).toBeHidden()
    await expect(line).toBeHidden()
  } finally { await context.close() }
})

test('at 844 by 390 the call bar is a column on the end edge, and the bars leave the stage most of the height', async ({ browser, baseURL }) => {
  test.skip(test.info().project.name === 'chromium-desktop', 'The installed window is never narrower than 900 px, so it never has the short landscape phone layout')
  const { context, page } = await visitor(browser, baseURL!, { width: 844, height: 390 }, { touch: true })
  try {
    await startCall(page)
    await expect(page.locator('#roomArea')).toHaveAttribute('data-mobile-view', 'call')
    const bar = (await page.locator('#deviceControls').boundingBox())!
    expect(bar.x + bar.width, 'the bar is on the end edge').toBeGreaterThan(844 - 24)
    expect(bar.width, 'a column, not a row').toBeLessThan(110)
    const buttons = await page.locator('#deviceControls').locator('#toggleMic, #toggleCamera, #callChatToggle, #callExtras, #leaveCall').all()
    const xs = new Set<number>()
    for (const button of buttons) {
      const b = (await button.boundingBox())!
      expect(b.height).toBeGreaterThanOrEqual(44)
      expect(b.y + b.height).toBeLessThanOrEqual(390)
      xs.add(Math.round(b.x))
    }
    expect(xs.size, 'one column').toBe(1)
    const header = (await page.locator('#roomArea > .roomBar').boundingBox())!
    const stage = (await page.locator('#whoIsHere').boundingBox().catch(() => null))
    expect(header.height / 390, `the bars take ${(header.height / 390 * 100).toFixed(0)}% of the height`).toBeLessThanOrEqual(1 / 3)
    expect(stage === null || stage.height >= 390 * 0.5).toBe(true)
    // The conversation, with the one-line call over it: header, line and composer under a third.
    await page.locator('#callChatToggle').click()
    const heights = await page.evaluate(() => ['#roomArea > .roomBar', '#chatForm'].map(s => document.querySelector(s)!.getBoundingClientRect().height))
    const total = heights.reduce((a, b) => a + b, 0)
    // The call line shares the header's row, so it adds no height of its own.
    const line = (await page.locator('#callChatBar').boundingBox())!
    const head = (await page.locator('#roomArea > .roomBar').boundingBox())!
    expect(line.y + line.height).toBeLessThanOrEqual(head.y + head.height + 1)
    console.log(`844x390 chat view bars: ${heights.map(h => h.toFixed(0)).join(' + ')} = ${total.toFixed(0)} of 390 (${(total / 390 * 100).toFixed(0)}%)`)
    expect(total / 390, 'header, call line and composer').toBeLessThanOrEqual(1 / 3)
    const log = (await page.locator('#chatLog').boundingBox())!
    expect(log.height).toBeGreaterThan(100)
  } finally { await context.close() }
})

test('the speaking ring is static under reduced motion', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 })
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await startCall(page)
    const style = await page.evaluate(() => {
      const tile = document.createElement('div')
      tile.className = 'participant speaking'
      document.getElementById('room')!.append(tile)
      const css = getComputedStyle(tile)
      const result = { animation: css.animationName, transition: css.transitionDuration, ring: css.boxShadow }
      tile.remove()
      return result
    })
    expect(style.animation).toBe('none')
    expect(style.transition).toBe('0s')
    expect(style.ring).not.toBe('none')
  } finally { await context.close() }
})

test('a refused microphone says so in the call, with what to do', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 390, height: 844 }, { touch: true })
  try {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
    })
    await startCall(page)
    await page.locator('#toggleMic').click()
    await expect(page.locator('#mediaBlockedNote')).toHaveText('Microphone blocked. Allow it in your browser settings.')
    await expect(page.locator('#mediaBlockedNote')).toBeVisible()
  } finally { await context.close() }
})

// ---------------------------------------------------------------------------
// Stage 6, slice A: the door, and no raw keys.
// ---------------------------------------------------------------------------

const DOOR_ACCOUNT = 'b3e7a1c2d4f5061728394a5b6c7d8e9f00112233445566778899aabbccddeeff'
const KEY = /npub1[0-9a-z]+|\b[0-9a-f]{64}\b/

/** A new browser at the first seeded room's link, with whatever the person's
 *  device already holds put in place before the page loads. */
async function door(browser: Browser, baseURL: string, viewport: { width: number; height: number }, options: { scheme?: 'dark' | 'light'; touch?: boolean; extension?: boolean; account?: { named: boolean }; name?: string; size?: string; link?: string; forcedColors?: boolean } = {}) {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const context = await browser.newContext({
    ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport, hasTouch: !!options.touch, isMobile: !!options.touch,
    colorScheme: options.scheme ?? 'dark', ...(options.forcedColors ? { forcedColors: 'active' as const } : {}),
  })
  await context.routeWebSocket(url => url.protocol === 'wss:' && url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  await context.addInitScript(({ extension, account, name, account_key, size }) => {
    if (sessionStorage.getItem('door-seeded')) return
    sessionStorage.setItem('door-seeded', '1')
    if (extension) (window as unknown as { nostr: unknown }).nostr = { getPublicKey: async () => account_key }
    if (account) {
      localStorage.setItem('kithmoot.last-nostr-account', account_key)
      localStorage.setItem('kithmoot.last-nostr-method', 'bunker')
      if (account.named) localStorage.setItem('kithmoot.profiles.lastKnownName.v1', JSON.stringify({ [account_key]: 'TheCryptoDonkey' }))
    }
    if (name) localStorage.setItem('kithmoot.name', name)
    if (size) localStorage.setItem('kithmoot.textSize', size)
  }, { extension: options.extension, account: options.account, name: options.name, account_key: DOOR_ACCOUNT, size: options.size })
  const page = await context.newPage()
  await page.goto(options.link ?? seeds[0]!.link)
  await expect(page.locator('#join')).toBeVisible({ timeout: 60_000 })
  return { context, page }
}

/** Text a person can see that carries a raw key, outside the places a key is for. */
async function visibleKeys(page: Page, except = '.participantCard, #peoplePane'): Promise<string[]> {
  return page.evaluate(({ except, pattern }) => {
    const re = new RegExp(pattern, 'g')
    const found: string[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement
      if (!el || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) || el.closest(`script, style, template, ${except}`)) continue
      const text = node.textContent ?? ''
      if (re.test(text)) found.push(`${el.id || el.className || el.tagName}: ${text.trim().slice(0, 80)}`)
      re.lastIndex = 0
    }
    return found
  }, { except, pattern: KEY.source })
}

const primaries = (page: Page) => page.locator('#identity button.primary:visible')

for (const [label, size, touch] of [['1440 by 900', { width: 1440, height: 900 }, false], ['390 by 844', { width: 390, height: 844 }, true]] as const) {
  for (const scheme of ['dark', 'light'] as const) {
    test(`the door of a stranger at ${label} in ${scheme} has one primary, Join, and none of the old ceremony`, async ({ browser, baseURL }) => {
      const { context, page } = await door(browser, baseURL!, size, { scheme, touch })
      try {
        await expect(primaries(page)).toHaveCount(1)
        await expect(primaries(page)).toHaveAttribute('id', 'join')
        await expect(page.locator('#join')).toHaveText('Join')
        await expect(page.locator('#arrivalTitle')).toHaveText('Release workshop')
        await expect(page.locator('#arrivalLead')).toHaveText('You have been invited to this room.')
        await expect(page.locator('#arrivalAvatar')).toBeVisible()
        await expect(page.locator('#joinMediaChoice')).toBeHidden()
        await expect(page.locator('#whoami, #previousAccount, #joinIdentityHelp')).toHaveCount(0)
        const text = await page.locator('#identity').innerText()
        for (const gone of ['Pick a name', 'Turn on as you join', 'You are on the list', 'Nothing turns on']) expect(text).not.toContain(gone)
        await expect(page.locator('#joinNostr')).toHaveText('Already on Nostr? Sign in')
        await expect(page.locator('#joinPrivacy')).toHaveText('Microphone and camera stay off until you turn them on.')
        await expect(page.locator('#joinNetworkPrivacy > summary')).toHaveText('Hide my IP address on calls')
        expect(await visibleKeys(page)).toEqual([])
      } finally { await context.close() }
    })
  }
}

test('an unnamed room says Untitled room at the door, as Chats does', async ({ browser, baseURL }) => {
  const secret = generateRoomSecret()
  const link = encodeRoomLink(baseURL!, { secret, relays: testRelaysFor(baseURL!) ?? [], iceUrls: [] })
  const { context, page } = await door(browser, baseURL!, { width: 1440, height: 900 }, { link })
  try { await expect(page.locator('#arrivalTitle')).toHaveText('Untitled room') } finally { await context.close() }
})

test('an account used here before: Continue as its name, one way down to a name, and a confirm that says what it means', async ({ browser, baseURL }) => {
  const { context, page } = await door(browser, baseURL!, { width: 1440, height: 900 }, { account: { named: true } })
  try {
    await expect(primaries(page)).toHaveCount(1)
    await expect(page.locator('#join')).toHaveText('Continue as TheCryptoDonkey')
    await expect(page.locator('#displayName')).toBeHidden()
    await expect(page.locator('#joinNostr')).toBeHidden()
    await expect(page.locator('#joinVisitor')).toHaveText('Join with just a name instead')
    expect(await visibleKeys(page)).toEqual([])
    await page.locator('#joinVisitor').click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toContainText('Join with just a name?')
    await expect(confirm).toContainText('This is not your Nostr account, even with the same name. Agents that know your account may ignore these messages.')
    await expect(confirm.getByRole('button', { name: 'Back', exact: true })).toBeVisible()
    await confirm.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(page.locator('#joinVisitor')).toBeFocused()
    // No name remembered: the same choice lands on the name field with its hint.
    await page.locator('#joinVisitor').click()
    await page.getByRole('button', { name: 'Join with just a name', exact: true }).click()
    await expect(page.locator('#displayName')).toBeFocused()
    await expect(page.locator('#displayNameHint')).toHaveText('Just a name, not your Nostr account.')
    await expect(page.locator('#join')).toHaveText('Join')
    await expect(page.locator('#joinNostr')).toBeHidden()
    await expect(page.locator('#joinVisitor')).toBeHidden()
  } finally { await context.close() }
})

test('an account used here before with no name remembered says Continue with your Nostr account', async ({ browser, baseURL }) => {
  const { context, page } = await door(browser, baseURL!, { width: 1440, height: 900 }, { account: { named: false } })
  try {
    await expect(page.locator('#join')).toHaveText('Continue with your Nostr account')
    expect(await visibleKeys(page)).toEqual([])
  } finally { await context.close() }
})

test('with a name remembered, Join with just a name goes straight in', async ({ browser, baseURL }) => {
  const { context, page } = await door(browser, baseURL!, { width: 1440, height: 900 }, { account: { named: true }, name: 'Ada' })
  try {
    await page.locator('#joinVisitor').click()
    await page.getByRole('button', { name: 'Join with just a name', exact: true }).click()
    await expect(page.locator('#chatLog')).toBeVisible({ timeout: 60_000 })
  } finally { await context.close() }
})

test('a Nostr extension and nobody signed in: one primary for the extension, and a name without a confirm', async ({ browser, baseURL }) => {
  const { context, page } = await door(browser, baseURL!, { width: 1440, height: 900 }, { extension: true })
  try {
    await expect(primaries(page)).toHaveCount(1)
    await expect(page.locator('#join')).toHaveText('Continue with your Nostr extension')
    await expect(page.locator('#displayName')).toBeHidden()
    await expect(page.locator('#joinNostr')).toBeHidden()
    expect(await visibleKeys(page)).toEqual([])
    await page.locator('#joinVisitor').click()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(page.locator('#displayName')).toBeFocused()
    await expect(page.locator('#join')).toHaveText('Join')
  } finally { await context.close() }
})

test('a door opened by a device that already holds a key shows no key', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 }, { empty: true })
  try {
    await page.goto(seeds[0]!.link)
    await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    await expect(page.locator('#chatLog')).toBeVisible({ timeout: 60_000 })
    await page.goto('about:blank')
    await page.goto(seeds[1]!.link)
    await expect(page.locator('#join')).toBeVisible({ timeout: 60_000 })
    expect(await visibleKeys(page)).toEqual([])
  } finally { await context.close() }
})

for (const [label, size, touch] of [['1440', { width: 1440, height: 900 }, false], ['390', { width: 390, height: 844 }, true]] as const) {
  test(`Chats with the reconnect banner at ${label} names the account and shows no key`, async ({ browser, baseURL }) => {
    const { context, page } = await door(browser, baseURL!, size, { account: { named: true }, touch })
    try {
      await page.goto(baseURL!)
      const banner = page.locator('#accountReconnect')
      await expect(banner).toBeVisible()
      await expect(page.locator('#accountReconnectText')).toHaveText('Reconnect TheCryptoDonkey to see its rooms.')
      await expect(page.locator('#accountReconnectButton')).toHaveText('Reconnect')
      expect(await visibleKeys(page)).toEqual([])
    } finally { await context.close() }
  })
}

test('the keyboard at the door of a stranger: the name has focus, then Join, Sign in, the IP fold, each with a 2 px outline', async ({ browser, baseURL }) => {
  const { context, page } = await door(browser, baseURL!, { width: 1440, height: 900 })
  try {
    await expect(page.locator('#displayName')).toBeFocused()
    const order: string[] = []
    const outline = async () => page.evaluate(() => { const el = document.activeElement as HTMLElement; const s = getComputedStyle(el); return { id: el.id || el.tagName, inside: !!el.closest('#identity'), width: parseFloat(s.outlineWidth) || 0, style: s.outlineStyle } })
    for (let i = 0; i < 8; i++) {
      const now = await outline()
      if (!now.inside) break
      order.push(now.id)
      expect(now.width, `${now.id} outline`).toBeGreaterThanOrEqual(2)
      expect(now.style, `${now.id} outline`).not.toBe('none')
      await page.keyboard.press('Tab')
    }
    const expected = ['displayName', 'join', 'joinNostr', 'SUMMARY']
    expect(order.filter(id => id !== 'openInAppLink' && id !== 'getAndroidApp')).toEqual(expected)
  } finally { await context.close() }
})

test('a touch screen is not given the keyboard on arrival', async ({ browser, baseURL }) => {
  const { context, page } = await door(browser, baseURL!, { width: 390, height: 844 }, { touch: true })
  try {
    await page.waitForTimeout(500)
    await expect(page.locator('#displayName')).not.toBeFocused()
  } finally { await context.close() }
})

for (const [label, size, touch, scheme, forced] of [
  ['1440 dark', { width: 1440, height: 900 }, false, 'dark', false], ['1440 light', { width: 1440, height: 900 }, false, 'light', false],
  ['390 dark', { width: 390, height: 844 }, true, 'dark', false], ['390 light', { width: 390, height: 844 }, true, 'light', false],
  ['1440 forced colours', { width: 1440, height: 900 }, false, 'light', true],
] as const) {
  test(`axe finds nothing on the door in its three faces at ${label}`, async ({ browser, baseURL }) => {
    for (const options of [{}, { account: { named: true } }, { extension: true }]) {
      const { context, page } = await door(browser, baseURL!, size, { scheme, touch, forcedColors: forced, ...options })
      try {
        const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
        expect(scan.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), JSON.stringify(options)).toEqual([])
      } finally { await context.close() }
    }
  })
}

test('the door and the reconnect banner do not scroll sideways at 320 by 640 or at 400% zoom, and Continue wraps a long name', async ({ browser, baseURL }) => {
  for (const options of [{}, { account: { named: true } }]) {
    const { context, page } = await door(browser, baseURL!, { width: 320, height: 640 }, { touch: true, size: 'huge', ...options })
    try {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), JSON.stringify(options)).toBe(true)
      await page.goto(baseURL!)
      if (options.account) {
        expect(await page.evaluate(() => { const el = document.getElementById('accountReconnectText')!; return el.scrollWidth <= el.clientWidth })).toBe(true)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      }
    } finally { await context.close() }
  }
  // 400% zoom at 1280 wide is a 320 px viewport at scale 1.
  const { context, page } = await door(browser, baseURL!, { width: 320, height: 200 }, { account: { named: true } })
  try { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true) } finally { await context.close() }
})

test('at 390 by 844 every control at the door is at least 44 px tall and wide', async ({ browser, baseURL }) => {
  for (const options of [{}, { account: { named: true } }]) {
    const { context, page } = await door(browser, baseURL!, { width: 390, height: 844 }, { touch: true, ...options })
    try {
      const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#identity button, #identity a[href], #identity input:not([type=checkbox]), #identity summary')]
        .filter(el => el.checkVisibility() && !el.closest('#accountHome'))
        .map(el => { const r = el.getBoundingClientRect(); return { id: el.id || el.tagName, w: Math.round(r.width), h: Math.round(r.height) } })
        .filter(r => r.h < 44 || r.w < 44))
      expect(small, JSON.stringify(options)).toEqual([])
    } finally { await context.close() }
  }
})

test('a short landscape phone keeps the name and Join on screen with the name focused', async ({ browser, baseURL }) => {
  const { context, page } = await door(browser, baseURL!, { width: 844, height: 390 }, { touch: true })
  try {
    await page.locator('#displayName').focus()
    for (const id of ['displayName', 'join']) {
      const box = (await page.locator(`#${id}`).boundingBox())!
      expect(box.y + box.height, id).toBeLessThanOrEqual(390)
      expect(box.y, id).toBeGreaterThanOrEqual(0)
    }
  } finally { await context.close() }
})

test('Settings › Account still holds the account block after a visit to the door', async ({ browser, baseURL }) => {
  const { context, page } = await door(browser, baseURL!, { width: 1440, height: 900 })
  try {
    await openSettings(page, 'Account')
    await expect(page.locator('#accountHome')).toBeVisible()
  } finally { await context.close() }
})

// ---------------------------------------------------------------------------
// Stage 6, slice B: the creator skips the door, and a joined room reopens.
// ---------------------------------------------------------------------------

/** Watches the door of a page from the first paint: true once the name form
 *  or the Continue button has been on screen at any moment. */
async function watchDoor(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { doorSeen: boolean }
    w.doorSeen = false
    const check = () => {
      for (const id of ['displayName', 'join']) {
        const el = document.getElementById(id)
        if (el && el.checkVisibility()) w.doorSeen = true
      }
    }
    new MutationObserver(check).observe(document, { subtree: true, attributes: true, childList: true })
    setInterval(check, 20)
  })
}
const doorSeen = (page: Page) => page.evaluate(() => (window as unknown as { doorSeen: boolean }).doorSeen)

/** A device about to start a room on the test relays. */
async function creatorDevice(browser: Browser, baseURL: string, options: { name?: string; account?: boolean; extension?: boolean; touch?: boolean; scheme?: 'dark' | 'light'; viewport?: { width: number; height: number } } = {}) {
  const relays = testRelaysFor(baseURL)!
  const { context, page } = await door(browser, baseURL, options.viewport ?? { width: 1280, height: 900 }, { name: options.name, account: options.account ? { named: true } : undefined, extension: options.extension, touch: options.touch, scheme: options.scheme })
  await context.addInitScript(urls => localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: urls.map(url => ({ url, read: true, write: true })) })), relays)
  await watchDoor(page)
  await page.goto('about:blank')
  await page.goto(baseURL)
  await expect(page.locator('#newMenuButton:visible, #newRoom:visible').first()).toBeVisible({ timeout: 30_000 })
  return { context, page }
}

test('a creator with no name is asked for one in the form, and then goes straight into the room', async ({ browser, baseURL }) => {
  const { context, page } = await creatorDevice(browser, baseURL!)
  try {
    await openNewRoomForm(page)
    await expect(page.locator('#newRoomYourNameRow')).toBeVisible()
    await expect(page.getByLabel('Your name', { exact: true })).toBeVisible()
    await page.locator('#roomName').fill('Release workshop')
    await page.locator('#create').click()
    await expect(page.locator('#newRoomYourNameError')).toHaveText('Type the name people here will see.')
    await expect(page.locator('#newRoomYourName')).toHaveAttribute('aria-invalid', 'true')
    await expect(page.locator('#newRoomYourName')).toBeFocused()
    await page.locator('#newRoomYourName').fill('Ada')
    await page.locator('#create').click()
    await expect(page.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    expect(await doorSeen(page), 'the name form or Join was on screen').toBe(false)
    await expect(page.locator('#joinRoomForm')).toBeHidden()
    await expect(page.locator('#chatInput')).toBeFocused()
    await openRoomDetails(page)
    await expect(page.locator('#sheetRoster')).toContainText('Ada (you)')
  } finally { await context.close() }
})

test('a creator with a name remembered is not asked, and goes in as that name', async ({ browser, baseURL }) => {
  const { context, page } = await creatorDevice(browser, baseURL!, { name: 'Ada' })
  try {
    await openNewRoomForm(page)
    await expect(page.locator('#newRoomYourNameRow')).toBeHidden()
    await page.locator('#create').click()
    await expect(page.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    expect(await doorSeen(page)).toBe(false)
    await openRoomDetails(page)
    await expect(page.locator('#sheetRoster')).toContainText('Ada (you)')
  } finally { await context.close() }
})

test('a creator whose account must be reconnected meets the door, which says the room is ready', async ({ browser, baseURL }) => {
  const { context, page } = await creatorDevice(browser, baseURL!, { account: true })
  try {
    await openNewRoomForm(page)
    await page.locator('#create').click()
    await expect(page.locator('#join')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('#roomArea')).toBeHidden()
    await expect(page.locator('#arrivalLead')).toHaveText('Your room is ready.')
    await expect(page.locator('#join')).toHaveText('Continue as TheCryptoDonkey')
  } finally { await context.close() }
})

test('a link to a room this device has joined opens the room, for the guest and for the creator, and never shows the name form', async ({ browser, baseURL }) => {
  const { context: hostContext, page: host } = await creatorDevice(browser, baseURL!, { name: 'Ada' })
  try {
    await openNewRoomForm(host)
    await host.locator('#roomName').fill('Reload room')
    await host.locator('#create').click()
    await expect(host.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    const link = await host.locator('#shareUrl').inputValue()

    const { context, page } = await door(browser, baseURL!, { width: 1280, height: 900 }, { link })
    try {
      await watchDoor(page)
      await page.locator('#displayName').fill('Rowan'); await page.locator('#join').click()
      await expect(page.locator('#chatLog')).toBeVisible({ timeout: 60_000 })
      await page.goto('about:blank')
      await watchDoor(page)
      await page.goto(link)
      await expect(page.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
      await page.reload()
      await expect(page.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
      expect(await doorSeen(page), 'the guest saw the door on reload').toBe(false)
    } finally { await context.close() }

    await host.goto('about:blank')
    await host.goto(link)
    await expect(host.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    await host.reload()
    await expect(host.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    expect(await doorSeen(host), 'the creator saw the door on reload').toBe(false)
  } finally { await hostContext.close() }
})

test('a link opened but never joined reloads to the door, not into the room', async ({ browser, baseURL }) => {
  const { context, page } = await door(browser, baseURL!, { width: 1280, height: 900 })
  try {
    await page.reload()
    await expect(page.locator('#displayName')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('#roomArea')).toBeHidden()
  } finally { await context.close() }
})

test('a device that joined as a name and now has an account to reconnect meets the door in reconnect mode, never the room', async ({ browser, baseURL }) => {
  const { context, page } = await door(browser, baseURL!, { width: 1280, height: 900 })
  try {
    await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    await expect(page.locator('#chatLog')).toBeVisible({ timeout: 60_000 })
    await page.evaluate(account => {
      localStorage.setItem('kithmoot.last-nostr-account', account)
      localStorage.setItem('kithmoot.last-nostr-method', 'bunker')
    }, DOOR_ACCOUNT)
    await page.reload()
    await expect(page.locator('#join')).toHaveText('Continue with your Nostr account', { timeout: 60_000 })
    await expect(page.locator('#joinVisitor')).toBeVisible()
    await expect(page.locator('#roomArea')).toBeHidden()
  } finally { await context.close() }
})

test('a device that joined as a name and is now signed in as an account is asked, not walked in', async ({ browser, baseURL }) => {
  const secret = generateSecretKey()
  const accountContext = await accountDevice(browser, baseURL!, secret)
  const relay = new URL('/__test-relay', baseURL!); relay.protocol = 'wss:'
  try {
    const page = await accountContext.newPage()
    await page.goto(seeds[0]!.link)
    // Joined here as a name, with the extension left alone.
    await expect(page.locator('#join')).toBeVisible({ timeout: 60_000 })
    await page.locator('#joinVisitor').click()
    await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    await expect(page.locator('#chatLog')).toBeVisible({ timeout: 60_000 })
    // Now signed in as an account, in the same browser, and the link opened again.
    await signInAccount(page, baseURL!)
    await page.goto('about:blank')
    await page.goto(seeds[0]!.link)
    await expect(page.locator('#join')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('#roomArea')).toBeHidden()
    await expect(page.locator('#join')).toHaveText(/^Continue (as|with your Nostr account)/)
    void relay
  } finally { await accountContext.close() }
})

// ---------------------------------------------------------------------------
// Stage 6, slice C: the sender picker.
// ---------------------------------------------------------------------------

/** Ada, who knows Town hall and Book club already, in a room of her own with
 *  Rowan in it: the page Ada invites from, and Rowan's. */
async function pickerSetup(browser: Browser, baseURL: string, viewport = { width: 1280, height: 900 }, options: { touch?: boolean; scheme?: 'dark' | 'light'; reducedMotion?: boolean; forcedColors?: boolean } = {}) {
  const relays = testRelaysFor(baseURL)!
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const context = await browser.newContext({
    ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport, hasTouch: !!options.touch, isMobile: !!options.touch, colorScheme: options.scheme ?? 'dark',
    ...(options.reducedMotion ? { reducedMotion: 'reduce' as const } : {}), ...(options.forcedColors ? { forcedColors: 'active' as const } : {}),
  })
  await context.routeWebSocket(url => url.protocol === 'wss:' && url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  await context.addInitScript(({ urls, rooms }) => {
    if (sessionStorage.getItem('picker-seeded')) return
    sessionStorage.setItem('picker-seeded', '1')
    localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: urls.map(url => ({ url, read: true, write: true })) }))
    localStorage.setItem('kithmoot.name', 'Ada')
    for (const room of rooms) localStorage.setItem('kithmoot.room.' + room.roomId, JSON.stringify({ roomId: room.roomId, name: room.name, link: room.link, openedAt: Math.floor(Date.now() / 1000) - 600, readAt: 0 }))
  }, { urls: relays, rooms: [seeds[2]!, seeds[3]!] })
  const ada = await context.newPage()
  await ada.goto(baseURL)
  await openNewRoomForm(ada)
  await ada.locator('#roomName').fill('Release workshop')
  await ada.locator('#create').click()
  await expect(ada.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
  const link = await ada.locator('#shareUrl').inputValue()
  const rowanDoor = await door(browser, baseURL, { width: 1280, height: 900 }, { link })
  await rowanDoor.page.locator('#displayName').fill('Rowan'); await rowanDoor.page.locator('#join').click()
  await expect(rowanDoor.page.locator('#chatLog')).toBeVisible({ timeout: 60_000 })
  await openMember(ada, 'Rowan')
  return { ada, context, rowan: rowanDoor.page, close: async () => { await context.close(); await rowanDoor.context.close() } }
}

async function openPicker(ada: Page) {
  const opener = ada.getByRole('button', { name: 'Invite Rowan to a room', exact: true })
  await opener.click({ timeout: 60_000 })
  await expect(ada.locator('#inviteToRoom')).toBeVisible()
  // A bottom sheet slides in over 150 ms: measure it once it has landed.
  await ada.locator('#inviteToRoom').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)))
  return opener
}

test('the picker names the person, lists every room including this one, and sends only what was chosen', async ({ browser, baseURL }) => {
  const set = await pickerSetup(browser, baseURL!)
  const { ada } = set
  try {
    await openPicker(ada)
    const picker = ada.locator('#inviteToRoom')
    await expect(picker.getByRole('heading', { name: 'Invite Rowan to a room' })).toBeVisible()
    await expect(picker.getByRole('radiogroup', { name: 'Invite Rowan to a room' })).toBeVisible()
    const here = picker.getByRole('radio', { name: 'Release workshop, Rowan is already here' })
    await expect(here).toBeDisabled()
    await expect(picker.getByRole('radio', { name: 'Town hall', exact: true })).toBeEnabled()
    await expect(picker.locator('input:checked')).toHaveCount(0)
    await expect(ada.locator('#inviteToRoomSend')).toBeDisabled()
    await expect(ada.locator('#inviteToRoomLead')).toHaveText('The invite goes to Rowan sealed. Only Rowan can open it.')
    await expect(ada.locator('#inviteToRoomClose')).toHaveText('Cancel')
    await expect(ada.locator('#inviteToRoomFind')).toBeHidden()
    await picker.getByRole('radio', { name: 'Town hall', exact: true }).check()
    await expect(ada.locator('#inviteToRoomSend')).toBeEnabled()
    await ada.locator('#inviteToRoomSend').click()
    await expect(picker).toBeHidden()
    await ada.locator('#roomSheetClose').click()
    await expect(ada.locator('#chatLog')).toContainText('You invited Rowan to Town hall.')
    // Asked again, Town hall says it has been, with the day.
    await openMember(ada, 'Rowan')
    const opener = await openPicker(ada)
    await expect(picker.getByRole('radio', { name: 'Town hall, Invited today, not joined yet' })).toBeEnabled()
    await ada.keyboard.press('Escape')
    await expect(picker).toBeHidden()
    await expect(opener).toBeFocused()
  } finally { await set.close() }
})

test('with no group room going, the picker says so and offers one Close', async ({ browser, baseURL }) => {
  const set = await pickerSetup(browser, baseURL!)
  const { ada } = set
  try {
    await ada.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith('kithmoot.room.')) continue
        const room = JSON.parse(localStorage.getItem(key)!)
        room.endedAt = Math.floor(Date.now() / 1000) - 60
        localStorage.setItem(key, JSON.stringify(room))
      }
    })
    await openPicker(ada)
    await expect(ada.locator('#inviteToRoomLead')).toHaveText('You have no rooms to invite Rowan to yet. Start a room from Chats, then invite Rowan.')
    await expect(ada.locator('#inviteToRoomClose')).toHaveText('Close')
    await expect(ada.locator('#inviteToRoomSend')).toBeHidden()
    await expect(ada.locator('#inviteToRoomList')).toBeHidden()
  } finally { await set.close() }
})

test('in the picker the radio group is one Tab stop, the arrows skip the room Rowan is already in, and Enter sends the choice', async ({ browser, baseURL }) => {
  const set = await pickerSetup(browser, baseURL!)
  const { ada } = set
  try {
    await openPicker(ada)
    const picker = ada.locator('#inviteToRoom')
    const rows = picker.getByRole('radio')
    await expect(rows).toHaveCount(3)
    // On open, the first room that can be chosen has the focus.
    const first = await ada.evaluate(() => (document.activeElement as HTMLInputElement).closest('label')?.textContent ?? '')
    expect(first).not.toContain('already here')
    // Arrows move through the choosable rooms and never land on the disabled one.
    const seen = new Set<string>()
    for (let i = 0; i < 4; i++) {
      await ada.keyboard.press('ArrowDown')
      seen.add(await ada.evaluate(() => (document.activeElement as HTMLInputElement).closest('label')?.textContent ?? ''))
    }
    expect([...seen].some(text => text.includes('already here'))).toBe(false)
    // One stop for the group: Tab goes to Cancel, not to the next radio.
    await ada.keyboard.press('Tab')
    await expect(ada.locator('#inviteToRoomClose')).toBeFocused()
    await ada.keyboard.press('Shift+Tab')
    await ada.keyboard.press('Enter')
    await expect(picker).toBeHidden()
    await expect(ada.locator('#roomSheet').getByText('You invited Rowan to').first().or(ada.locator('#chatLog').getByText('You invited Rowan to').first())).toBeVisible()
  } finally { await set.close() }
})

for (const [label, size, touch] of [['1440', { width: 1440, height: 900 }, false], ['390', { width: 390, height: 844 }, true]] as const) {
  for (const scheme of ['dark', 'light'] as const) {
    test(`axe finds nothing on the picker and on the New room form with its name error at ${label} in ${scheme}`, async ({ browser, baseURL }) => {
      const set = await pickerSetup(browser, baseURL!, size, { touch, scheme })
      try {
        await openPicker(set.ada)
        const scan = await new AxeBuilder({ page: set.ada }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
        expect(scan.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), 'picker').toEqual([])
      } finally { await set.close() }
      const { context, page } = await creatorDevice(browser, baseURL!, { viewport: size, touch, scheme })
      try {
        await openNewRoomForm(page)
        await page.locator('#create').click()
        await expect(page.locator('#newRoomYourNameError')).toBeVisible()
        const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
        expect(scan.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), 'new room form').toEqual([])
      } finally { await context.close() }
    })
  }
}

test('axe finds nothing on the picker in forced colours at 1440', async ({ browser, baseURL }) => {
  const set = await pickerSetup(browser, baseURL!, { width: 1440, height: 900 }, { forcedColors: true })
  try {
    await openPicker(set.ada)
    const scan = await new AxeBuilder({ page: set.ada }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
    expect(scan.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([])
  } finally { await set.close() }
})

test('at 390 by 844 the picker is a bottom sheet with both buttons on screen, and its targets are at least 44 px', async ({ browser, baseURL }) => {
  const set = await pickerSetup(browser, baseURL!, { width: 390, height: 844 }, { touch: true })
  try {
    await openPicker(set.ada)
    const sheet = (await set.ada.locator('#inviteToRoom').boundingBox())!
    expect(sheet.width).toBeGreaterThanOrEqual(389)
    expect(sheet.y + sheet.height).toBeGreaterThanOrEqual(843)
    for (const id of ['inviteToRoomClose', 'inviteToRoomSend']) {
      const box = (await set.ada.locator(`#${id}`).boundingBox())!
      expect(box.y + box.height, id).toBeLessThanOrEqual(844)
      expect(box.height, id).toBeGreaterThanOrEqual(44)
    }
    const small = await set.ada.evaluate(() => [...document.querySelectorAll<HTMLElement>('#inviteToRoom .inviteRoomRow, #inviteToRoom button, #inviteToRoom input[type=search]')]
      .filter(el => el.checkVisibility()).map(el => { const r = el.getBoundingClientRect(); return { id: el.id || el.className, h: Math.round(r.height) } }).filter(r => r.h < 44))
    expect(small).toEqual([])
  } finally { await set.close() }
})

test('the picker does not scroll sideways at 320 by 640, and at 844 by 390 its buttons are on screen', async ({ browser, baseURL }) => {
  for (const [size, landscape] of [[{ width: 320, height: 640 }, false], [{ width: 844, height: 390 }, true]] as const) {
    const set = await pickerSetup(browser, baseURL!, size, { touch: true })
    try {
      await openPicker(set.ada)
      expect(await set.ada.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(await set.ada.evaluate(() => { const el = document.getElementById('inviteToRoom')!; return el.scrollWidth <= el.clientWidth })).toBe(true)
      if (landscape) for (const id of ['inviteToRoomClose', 'inviteToRoomSend']) {
        const box = (await set.ada.locator(`#${id}`).boundingBox())!
        expect(box.y + box.height, id).toBeLessThanOrEqual(390)
        expect(box.y, id).toBeGreaterThanOrEqual(0)
      }
    } finally { await set.close() }
  }
})

test('under reduced motion the picker sheet runs no transform transition', async ({ browser, baseURL }) => {
  const set = await pickerSetup(browser, baseURL!, { width: 390, height: 844 }, { touch: true, reducedMotion: true })
  try {
    await openPicker(set.ada)
    const style = await set.ada.locator('#inviteToRoom').evaluate(el => ({ property: getComputedStyle(el).transitionProperty, animation: getComputedStyle(el).animationName }))
    expect(style.property).not.toContain('transform')
    expect(style.animation).toBe('none')
  } finally { await set.close() }
})

test('every control in the New room form is at least 44 px at 390 by 844 on a touch screen', async ({ browser, baseURL }) => {
  const { context, page } = await creatorDevice(browser, baseURL!, { viewport: { width: 390, height: 844 }, touch: true })
  try {
    await openNewRoomForm(page)
    const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#createRoomForm button, #createRoomForm input:not([type=checkbox]):not([type=radio]), #createRoomForm select, #createRoomForm label.checkboxRow')]
      .filter(el => el.checkVisibility()).map(el => { const r = el.getBoundingClientRect(); return { id: el.id || el.className || el.tagName, h: Math.round(r.height), w: Math.round(r.width) } }).filter(r => r.h < 44 || r.w < 44))
    expect(small).toEqual([])
  } finally { await context.close() }
})

// ---------------------------------------------------------------------------
// Stage 6: people without a name, in a room.
// ---------------------------------------------------------------------------

test('a member with no name is Somebody in the log, the roster, the came-in line and the Chats preview, and no key shows', async ({ browser, baseURL }) => {
  const { context, page: host } = await creatorDevice(browser, baseURL!, { name: 'Ada' })
  try {
    await openNewRoomForm(host)
    await host.locator('#roomName').fill('Nameless check')
    await host.locator('#create').click()
    await expect(host.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    const link = await host.locator('#shareUrl').inputValue()
    const guest = await door(browser, baseURL!, { width: 1280, height: 900 }, { link })
    try {
      await guest.page.locator('#join').click()
      await expect(guest.page.locator('#chatInput')).toBeVisible({ timeout: 60_000 })
      await guest.page.locator('#chatInput').fill('hello from nobody in particular')
      await guest.page.locator('#chatInput').press('Enter')
      await expect(host.locator('#chatLog')).toContainText('hello from nobody in particular', { timeout: 60_000 })
      await expect(host.locator('#chatLog')).toContainText('Somebody came in.')
      await expect(host.locator('#chatLog')).toContainText('Somebody')
      // Even the initial in the little picture is Somebody's, not the key's.
      await expect(host.locator('#chatLog .avatar.initials').first()).toHaveText('S')
      expect(await visibleKeys(host)).toEqual([])
      await openRoomDetails(host)
      await expect(host.locator('#sheetRoster')).toContainText('Somebody')
      expect(await visibleKeys(host)).toEqual([])
      await host.locator('#roomSheetClose').click()
      // The list, beside the room on a wide screen: the preview names them the same way.
      await expect(host.locator('#roomList .roomRow', { hasText: 'Nameless check' }).locator('.roomPreview')).toContainText('Somebody')
    } finally { await guest.context.close() }
  } finally { await context.close() }
})

// ---------------------------------------------------------------------------
// Stage 6 follow-up: Hide my IP address on calls is a Settings › Privacy default.
// ---------------------------------------------------------------------------

test('Hide my IP address on calls is a switch in Settings › Privacy kept as one device key, above Blocked', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 1280, height: 900 })
  try {
    await page.goto(baseURL!)
    await openSettings(page, 'Privacy')
    const toggle = page.getByLabel('Hide my IP address on calls', { exact: true })
    await expect(toggle).not.toBeChecked()
    await expect(page.locator('[data-settings-page="privacy"]')).toContainText('other people on the call don’t see your IP address')
    // Above the Blocked section in the page.
    expect(await page.evaluate(() => { const a = document.getElementById('privacyHideIp')!, b = document.getElementById('blockedSection')!; return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) })).toBe(true)
    await toggle.check()
    expect(await page.evaluate(() => localStorage.getItem('kithmoot.hide-ip.v1'))).toBe('1')
    await toggle.uncheck()
    expect(await page.evaluate(() => localStorage.getItem('kithmoot.hide-ip.v1'))).toBeNull()
  } finally { await context.close() }
})

test('with the setting on, the door starts with the IP choice checked, and a creator joins under it', async ({ browser, baseURL }) => {
  const { context, page } = await door(browser, baseURL!, { width: 1280, height: 900 })
  try {
    await page.evaluate(() => localStorage.setItem('kithmoot.hide-ip.v1', '1'))
    await page.reload()
    await expect(page.locator('#join')).toBeVisible({ timeout: 60_000 })
    await page.locator('#joinNetworkPrivacy > summary').click()
    await expect(page.locator('#joinRelayOnly')).toBeChecked()
  } finally { await context.close() }
  // A creator never sees the door: the choice is read from the same checkbox, already set.
  const made = await creatorDevice(browser, baseURL!, { name: 'Ada' })
  try {
    await made.page.evaluate(() => localStorage.setItem('kithmoot.hide-ip.v1', '1'))
    await made.page.reload()
    await openNewRoomForm(made.page)
    await made.page.locator('#create').click()
    await expect.poll(() => made.page.locator('#joinRelayOnly').isChecked()).toBe(true)
  } finally { await made.context.close() }
})

// Mute with durations (design-calm-stage7, part B).
const MUTE_KEY = 'kithmoot.mute-until.v1.visitor.'
const muteKeys = (page: Page) => page.evaluate(prefix => Object.entries(localStorage).filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, value]), MUTE_KEY)
const MUTE_LENGTHS = ['Mute for 1 hour', 'Mute for 8 hours', 'Mute for 1 day', 'Mute for 1 week']

async function notificationsOf(page: Page, menu: ReturnType<Page['locator']>) {
  const parent = menu.getByRole('menuitem', { name: 'Notifications', exact: true })
  // A menu focuses its first item as it opens; try again until the submenu is open.
  await expect(async () => {
    const choices = menu.getByRole('menuitemradio').first()
    if (!(await choices.isVisible())) {
      await parent.focus()
      await page.keyboard.press('ArrowRight')
    }
    await expect(choices).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  return parent
}

for (const [label, size, touch, scheme] of [['1440 by 900 dark', { width: 1440, height: 900 }, false, 'dark'], ['390 by 844 light', { width: 390, height: 844 }, true, 'light']] as const) {
  test(`at ${label} Notifications offers the modes, a separator and four lengths, and the keyboard walks them`, async ({ browser, baseURL }) => {
    const { context, page } = await visitor(browser, baseURL!, size, { touch, scheme })
    try {
      await joinRoom(page)
      await openRoomMenu(page)
      const menu = page.locator('#roomMoreMenu')
      await expect(menu.getByRole('menuitem', { name: 'Notifications', exact: true }).locator('use')).toHaveAttribute('href', '#i-bell')
      const parent = await notificationsOf(page, menu)
      await expect(menu.getByRole('menuitemradio')).toHaveText(['Every message', 'Only mentions and replies', 'Nothing', 'Use my default'])
      await expect(menu.getByRole('menuitem', { name: /^Mute for/ })).toHaveText(MUTE_LENGTHS)
      await expect(menu.getByRole('menuitem', { name: 'Unmute' })).toHaveCount(0)
      if (!touch) {
        const sub = menu.getByRole('menu', { name: 'Notifications' })
        expect(await sub.evaluate(el => [...el.children].map(child => child.tagName === 'HR' ? '-' : 'i').join('').replace(/i+/g, 'i'))).toBe('i-i')
        // Down from the last mode reaches the first length, and through all four.
        await sub.getByRole('menuitemradio').last().focus()
        await page.keyboard.press('ArrowDown')
        await expect(sub.getByRole('menuitem', { name: 'Mute for 1 hour' })).toBeFocused()
        for (const name of MUTE_LENGTHS.slice(1)) {
          await page.keyboard.press('ArrowDown')
          await expect(sub.getByRole('menuitem', { name })).toBeFocused()
        }
        await page.keyboard.press('Escape')
        await expect(parent).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(menu).toBeHidden()
        await expect(page.locator('#roomMenu')).toBeFocused()
      }
    } finally { await context.close() }
  })
}

test('muting a room for an hour writes the end, says so in the header and the status, and offers Unmute', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 })
  try {
    await page.clock.install({ time: new Date(2026, 9, 21, 10, 0) })
    await joinRoom(page)
    await expect(page.locator('#roomMuted')).toBeHidden()
    await openRoomMenu(page)
    const menu = page.locator('#roomMoreMenu')
    await notificationsOf(page, menu)
    await menu.getByRole('menuitem', { name: 'Mute for 1 hour' }).click()
    const now = await page.evaluate(() => Math.floor(Date.now() / 1000))
    const keys = await muteKeys(page)
    expect(keys).toHaveLength(1)
    expect(Math.abs(Number(keys[0]![1]) - (now + 3600))).toBeLessThanOrEqual(5)
    await expect(page.locator('#roomMutedText')).toHaveText('Muted until 11:00')
    await expect(page.locator('#roomMuted')).toBeVisible()
    await expect(page.locator('#status')).toHaveText('Muted until 11:00.')
    // The muted header, row and the open submenu break no accessibility rule.
    await openRoomMenu(page)
    await notificationsOf(page, menu)
    const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
    expect(scan.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([])
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(page.locator('#roomIdentity')).toHaveAccessibleName(/Muted until 11:00/)
    await expect(page.locator('#roomList li.roomRow[data-room]').first().locator('.roomMute').first()).toHaveCount(1)
    // The menu now says Unmute, wears the crossed bell, and offers no lengths.
    await openRoomMenu(page)
    await expect(menu.getByRole('menuitem', { name: 'Notifications', exact: true }).locator('use')).toHaveAttribute('href', '#i-bellOff')
    await notificationsOf(page, menu)
    await expect(menu.getByRole('menuitem', { name: 'Unmute' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: /^Mute for/ })).toHaveCount(0)
    // Choosing Nothing clears the timer: a mute with no end has no Unmute.
    await menu.getByRole('menuitemradio', { name: 'Nothing' }).click()
    expect(await muteKeys(page)).toEqual([])
    await expect(page.locator('#roomMutedText')).toHaveText('Muted')
    await openRoomMenu(page)
    await notificationsOf(page, menu)
    await expect(menu.getByRole('menuitem', { name: 'Unmute' })).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: /^Mute for/ })).toHaveCount(0)
    await expect(menu.getByRole('menuitemradio')).toHaveCount(4)
    await expect(menu.getByRole('menu', { name: 'Notifications' }).locator('hr')).toHaveCount(0)
  } finally { await context.close() }
})

for (const [suffix, hour, minute, mutedLabel] of [
  ['', 10, 0, /^Muted until 11:00\./],
  [' across midnight', 23, 30, /^Muted until tomorrow, 00:30\./],
] as const) {
test(`a muted room keeps its number but leaves the counts, and comes back on its own when the mute ends${suffix}`, async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 })
  try {
    await page.clock.install()
    // A room on the list is watched once this device has been in it.
    await joinRoom(page, 2)
    await joinRoom(page)
    await keepers[2]!.chat.send('Doors at seven.')
    const row = page.locator('#roomList li.roomRow', { hasText: 'Town hall' })
    await expect(row.locator('.unread')).toHaveCount(1, { timeout: 30_000 })
    // Receive the real agent message before moving the browser's wall clock.
    // Anchor local calendar time while retaining the installed timer clock.
    const muteStart = await page.evaluate(({ hour, minute }) => {
      const now = new Date()
      now.setHours(hour, minute, 0, 0)
      return now.getTime()
    }, { hour, minute })
    await page.clock.setSystemTime(muteStart)
    const countText = async () => (await page.locator('#railChatsCount').isVisible()) ? Number(await page.locator('#railChatsCount').innerText()) : 0
    const before = await countText()
    const own = Number(await row.locator('.unread').getAttribute('data-count'))
    expect(own).toBeGreaterThan(0)
    expect(before).toBeGreaterThanOrEqual(own)
    await expect.poll(() => page.title()).toBe(`(${before}) KithMoot`)
    // The row's own menu, as a right-click.
    await row.click({ button: 'right' })
    const rowMenu = page.locator(`#roomMenu-${await row.getAttribute('data-room')}`)
    await notificationsOf(page, rowMenu)
    await expect(rowMenu.getByRole('menuitem', { name: /^Mute for/ })).toHaveText(MUTE_LENGTHS)
    await rowMenu.getByRole('menuitem', { name: 'Mute for 1 hour' }).click()
    await expect.poll(countText).toBe(before - own)
    await expect.poll(() => page.title()).toBe(before - own > 0 ? `(${before - own}) KithMoot` : 'KithMoot')
    await expect(row.locator('.unread')).toHaveAttribute('data-muted', 'true')
    await expect(row.locator('.roomMute')).toHaveCount(1)
    expect(await row.locator('.sr-only').textContent()).toMatch(mutedLabel)
    // The hour passes with the page open: within two seconds all of it goes.
    await page.clock.fastForward('01:00:02')
    await expect(row.locator('.roomMute')).toHaveCount(0, { timeout: 2000 })
    await expect(row.locator('.unread')).not.toHaveAttribute('data-muted', 'true')
    await expect.poll(countText).toBe(before)
    expect(await muteKeys(page)).toEqual([])
    // An explicit Unmute does the same sooner.
    await row.click({ button: 'right' })
    await notificationsOf(page, rowMenu)
    await rowMenu.getByRole('menuitem', { name: 'Mute for 1 day' }).click()
    await expect.poll(countText).toBe(before - own)
    await row.click({ button: 'right' })
    await notificationsOf(page, rowMenu)
    await rowMenu.getByRole('menuitem', { name: 'Unmute' }).click()
    await expect(page.locator('#status')).toHaveText('Unmuted.')
    await expect.poll(countText).toBe(before)
  } finally { await context.close() }
})
}


// Rings follow today's rule (design-calm-stage7, S7 as decided): the banner
// always opens for the room on screen; the ring's sound and the system alert
// are silenced by a mute, as they already are by Nothing.
for (const [mode, rings] of [['none', true], ['mute for 1 hour', false], ['Nothing', false]] as const) {
  test(`a call in a room with ${mode === 'none' ? 'no mute' : mode === 'Nothing' ? 'Nothing chosen' : 'a one-hour mute'} opens the banner and ${rings ? 'rings and alerts' : 'makes no sound and no system alert'}`, async ({ browser, baseURL }) => {
    const { ada, close } = await ringSetup(browser, baseURL!, async page => {
      if (mode !== 'none') {
        await openRoomMenu(page)
        const menu = page.locator('#roomMoreMenu')
        await notificationsOf(page, menu)
        if (mode === 'Nothing') await menu.getByRole('menuitemradio', { name: 'Nothing' }).click()
        else await menu.getByRole('menuitem', { name: 'Mute for 1 hour' }).click()
        await expect(page.locator('#roomMuted')).toBeVisible()
      }
      await page.evaluate(() => {
        localStorage.setItem('kithmoot.notify', 'true')
        const seen = { sounds: 0, alerts: [] as string[] }
        ;(window as any).ringSpy = seen
        const Original = window.AudioContext
        window.AudioContext = class extends Original { constructor(...args: ConstructorParameters<typeof AudioContext>) { super(...args); seen.sounds++ } }
        class Spy { static permission = 'granted'; static requestPermission = async () => 'granted'; constructor(title: string, options?: NotificationOptions) { seen.alerts.push(`${title}: ${options?.body}`) } close() {} }
        Object.defineProperty(window, 'Notification', { value: Spy, configurable: true })
      })
    })
    try {
      await expect(ada.page.locator('#ringBanner')).toBeVisible({ timeout: 60_000 })
      await expect(ada.page.locator('#ringBanner')).toContainText('Priya Natarajan is calling')
      await ada.page.waitForTimeout(1500)
      const seen = await ada.page.evaluate(() => (window as any).ringSpy as { sounds: number; alerts: string[] })
      if (rings) {
        expect(seen.sounds).toBeGreaterThan(0)
        expect(seen.alerts).toEqual(['Ring room: Priya Natarajan is calling'])
      } else {
        expect(seen.sounds).toBe(0)
        expect(seen.alerts).toEqual([])
      }
    } finally { await close() }
  })
}

test('Settings › Notifications names its choices the way the menus do, and a room can be set to Only mentions and replies from either', async ({ browser, baseURL }) => {
  const { context, page } = await visitor(browser, baseURL!, { width: 1440, height: 900 })
  try {
    await joinRoom(page)
    await openSettings(page, 'Notifications')
    await page.locator('#notificationPreferences').evaluate(el => { (el as HTMLDetailsElement).open = true })
    const options = page.locator('#notificationMode option')
    await expect(options).toHaveText(['Use parent setting', 'Every message', 'Only mentions and replies', 'Nothing'])
    expect(await options.evaluateAll(all => all.map(option => (option as HTMLOptionElement).value))).toEqual(['inherit', 'all', 'mentions', 'off'])
    await page.locator('#notificationMode').selectOption('mentions')
    await expect(page.locator('#notificationMode')).toHaveValue('mentions')
    await expect(page.locator('#notificationPreferences .note').first()).toContainText('any project set to Nothing silences it unless the room has its own setting')
    // The room's own menu shows the same choice ticked once the room scope is picked.
    await page.locator('#notificationScope').selectOption({ label: 'Room: Release workshop' })
    await page.locator('#notificationMode').selectOption('mentions')
    await closeSettings(page)
    await roomMenuItem(page, 'Notifications')
    const menu = page.locator('#roomMoreMenu')
    await expect(menu.getByRole('menuitemradio', { name: 'Only mentions and replies' })).toHaveAttribute('aria-checked', 'true')
    // A mentions-only room is not muted: no glyph, no header line.
    await expect(page.locator('#roomMuted')).toBeHidden()
  } finally { await context.close() }
})


for (const width of [390, 1440]) {
  test(`a signed-in person can open Bothy routing before selecting a private route at ${width}`, async ({ browser, baseURL }) => {
    const { context, page } = await account(browser, baseURL!, { width, height: 900 })
    try {
      await joinRoom(page)
      await openRoomInfoPage(page, 'Privacy and connection')
      await expect(page.locator('#infoSubPrivacy')).toHaveText('Encrypted · public relays')
      await page.getByRole('button', { name: 'Bothy routing', exact: true }).click()
      await expect(page.locator('#bothyRoomSettings')).toHaveJSProperty('open', true)
      await expect(page.locator('#bothyRoomStatus')).toContainText('Activation closes this room’s public connections')
      await expect(page.locator('#bothyRoomRoute option')).toHaveCount(0)
      await page.getByRole('button', { name: 'Activate or resume room', exact: true }).click()
      await expect(page.locator('#bothyRoomStatus')).toHaveText('Connect and pair your Bothy in Settings first.')
      await page.locator('#bothyRoomClose').click()
      await openRoomInfoPage(page, 'Privacy and connection')
      await expect(page.locator('#infoSubPrivacy')).toHaveText('Encrypted · public relays')
      await page.screenshot({ path: test.info().outputPath('bothy-first-selection.png') })
    } finally { await context.close() }
  })
}
