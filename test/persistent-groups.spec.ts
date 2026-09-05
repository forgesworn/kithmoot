import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { openRoomDetails } from './browser.js'
import { parseRoomLink } from '../src/link.js'
import { openRoomUrl } from './relays.js'

/** Real WebSocket relay and built app; every creator socket is closed
 * before the next device opens its first invitation. */
async function device(browser: Browser, baseURL: string, storageState?: Awaited<ReturnType<BrowserContext['storageState']>>) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', storageState, viewport: { width: 390, height: 740 } })
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  await context.addInitScript(relay => {
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        const defaults = ['wss://relay.trotters.cc', 'wss://nos.lol', 'wss://relay.primal.net']
        const target = defaults.includes(String(url).replace(/\/$/, '')) ? relay : String(url)
        if (target !== relay) throw new Error('External relay blocked by group acceptance test')
        super(target, protocols)
      }
    }
  }, relay.href)
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  return context
}

async function enter(page: Page, link: string, name: string) {
  await openRoomUrl(page, link)
  await expect(page.locator('#join')).toBeVisible()
  await page.locator('#displayName').fill(name)
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
}

async function create(page: Page, baseURL: string, temporary = false) {
  await page.goto(baseURL)
  await page.locator('#roomName').fill('Our group')
  await expect(page.locator('#roomType')).toHaveValue('persistent')
  if (temporary) await page.locator('#roomType').selectOption('temporary')
  await page.locator('#create').click()
  await expect(page.locator('#join')).toBeVisible()
  return page.locator('#shareUrl').inputValue()
}

test('a new member joins two days after everyone leaves, then both members return after restarting', async ({ browser, baseURL }) => {
  const contexts: BrowserContext[] = []
  try {
    const owner = await device(browser, baseURL!); contexts.push(owner)
    const page = await owner.newPage()
    const link = await create(page, baseURL!)
    expect(parseRoomLink(link).invitation?.persistent).toBe(true)
    expect(parseRoomLink(link).secret).toBeUndefined()
    await page.locator('#displayName').fill('Creator')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.locator('#chatInput').fill('See you later')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('See you later')
    const ownerState = await owner.storageState()
    await owner.close()

    const visitor = await device(browser, baseURL!); contexts.push(visitor)
    const arrival = await visitor.newPage()
    await arrival.clock.setFixedTime(new Date(Date.now() + 2 * 86400_000))
    await enter(arrival, link, 'Visitor')
    await expect(arrival.locator('#chatLog')).toContainText('See you later')
    await openRoomDetails(arrival)
    await expect(arrival.locator('#toggleKeep')).toHaveAttribute('aria-pressed', 'true')
    await expect(arrival.locator('#invitationAvailability')).toContainText('everyone closes the app')
    await expect(arrival.locator('#rotateShare')).toBeHidden()
    const visitorState = await visitor.storageState()
    await visitor.close()

    const returning = await device(browser, baseURL!, visitorState); contexts.push(returning)
    const back = await returning.newPage()
    await back.clock.setFixedTime(new Date(Date.now() + 4 * 86400_000))
    await back.goto(baseURL!)
    await expect(back.locator('#roomList .roomName')).toHaveText('Our group')
    await back.locator('#roomList button.open').click()
    await back.locator('#join').click()
    await expect(back.locator('#roomArea')).toBeVisible()
    await expect(back.locator('#chatLog')).toContainText('See you later')
    await back.locator('#chatInput').fill('Back after the weekend')
    await back.locator('#chatInput').press('Enter')
    await expect(back.locator('#chatLog')).toContainText('Back after the weekend')
    await returning.close()

    const restored = await device(browser, baseURL!, ownerState); contexts.push(restored)
    const creator = await restored.newPage()
    await creator.clock.setFixedTime(new Date(Date.now() + 4 * 86400_000))
    await enter(creator, link, 'Creator')
    await expect(creator.locator('#chatLog')).toContainText('Back after the weekend')
    await openRoomDetails(creator)
    await expect(creator.locator('#rotateShare')).toBeVisible()
  } finally { await Promise.all(contexts.map(context => context.close())) }
})

test('replacing a group invitation rejects fresh arrivals on the old link while existing members can return', async ({ browser, baseURL }) => {
  const contexts: BrowserContext[] = []
  try {
    const owner = await device(browser, baseURL!); contexts.push(owner)
    const page = await owner.newPage()
    const link = await create(page, baseURL!)
    const member = await device(browser, baseURL!); contexts.push(member)
    await enter(await member.newPage(), link, 'Member')
    const saved = await member.storageState()
    await member.close()
    await page.locator('#join').click()
    await openRoomDetails(page)
    page.on('dialog', dialog => dialog.accept())
    await page.locator('#rotateShare').click()
    await expect.poll(() => page.locator('#shareUrl').inputValue()).not.toBe(link)
    const replacement = await page.locator('#shareUrl').inputValue()
    await owner.close()
    const newcomer = await device(browser, baseURL!); contexts.push(newcomer)
    const arrival = await newcomer.newPage()
    await arrival.goto(link)
    await expect(arrival.locator('#arrivalTitle')).toHaveText('This invitation is no longer valid')
    await expect(arrival.locator('#join')).toBeHidden()
    await enter(arrival, replacement, 'New member')
    await newcomer.close()
    const returning = await device(browser, baseURL!, saved); contexts.push(returning)
    await enter(await returning.newPage(), link, 'Member')
  } finally { await Promise.all(contexts.map(context => context.close())) }
})

test('the creator can turn an existing temporary meeting into a group without changing its conversation', async ({ browser, baseURL }) => {
  const contexts: BrowserContext[] = []
  try {
    const owner = await device(browser, baseURL!); contexts.push(owner)
    const page = await owner.newPage()
    const temporary = await create(page, baseURL!, true)
    const member = await device(browser, baseURL!); contexts.push(member)
    const arrival = await member.newPage()
    await enter(arrival, temporary, 'Existing member')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.locator('#chatInput').fill('Keep this conversation')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('Keep this conversation')
    await openRoomDetails(page)
    await page.locator('#makePersistent').click()
    await expect(page.locator('#makePersistent')).toBeHidden()
    const link = await page.locator('#shareUrl').inputValue()
    expect(parseRoomLink(link).invitation?.persistent).toBe(true)
    expect(parseRoomLink(link).invitation?.inviter).toBe(parseRoomLink(temporary).invitation?.inviter)
    expect(parseRoomLink(link).invitation?.bearer).not.toEqual(parseRoomLink(temporary).invitation?.bearer)
    await owner.close()
    await enter(arrival, link, 'Existing member')
    await expect(arrival.locator('#chatLog')).toContainText('Keep this conversation')
    expect(await arrival.evaluate(() => Object.keys(localStorage)
      .filter(key => key.startsWith('kithmoot.admission-kept.'))
      .map(key => JSON.parse(localStorage.getItem(key)!)).some(record => record.persistent === true))).toBe(true)
    arrival.on('dialog', dialog => dialog.accept())
    await arrival.locator('#backToRooms').click()
    await arrival.locator('#roomSwitcherHome').click()
    await arrival.locator('#roomList button.forget').click()
    expect(await arrival.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('kithmoot.admission-kept.')))).toBe(false)
    expect(await arrival.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('kithmoot.admission.v1.')))).toBe(false)
  } finally { await Promise.all(contexts.map(context => context.close())) }
})

test('failed relay publication leaves creation retryable and never presents a ready group link', async ({ browser, baseURL }) => {
  const context = await device(browser, baseURL!)
  try {
    await context.routeWebSocket('**', socket => {
      socket.onMessage(raw => {
        const message = JSON.parse(String(raw))
        if (message[0] === 'EVENT') socket.send(JSON.stringify(['OK', message[1].id, false, 'blocked: test rejection']))
        if (message[0] === 'REQ') socket.send(JSON.stringify(['EOSE', message[1]]))
      })
    })
    const page = await context.newPage()
    await page.goto(baseURL!)
    await page.locator('#create').click()
    await expect(page.locator('#createError')).toContainText('Could not create the room')
    await expect(page.locator('#create')).toBeEnabled()
    await expect(page.locator('#home')).toBeVisible()
    expect(new URL(page.url()).hash).toBe('')
    await expect(page.locator('#shareUrl')).toHaveValue('')
  } finally { await context.close() }
})
