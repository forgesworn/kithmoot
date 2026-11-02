import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { deriveRoom, encodeJoinUrl, generateRoomSecret } from '../src/room.js'
import { decodeChatEvent } from '../src/chat.js'
import type { Event as NostrEvent } from 'nostr-tools/pure'
import { goToConversation, openProfileSettings } from './browser.js'

function testRelay(baseURL: string): string {
  const url = new URL('/__test-relay', baseURL)
  url.protocol = 'wss:'
  return url.href
}

async function contextFor(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 },
  })
  await context.route('**/turn', r => r.fulfill({ status: 503, body: '' }))
  await context.routeWebSocket(url => url.protocol === 'wss:' && url.href !== testRelay(baseURL), ws => ws.close())
  return context
}

async function join(page: Page, url: string, name: string): Promise<void> {
  await page.goto(url)
  await page.locator('#displayName').fill(name)
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
}

test('a reachable relay sends while the browser reports offline', async ({ browser, baseURL }) => {
  const context = await contextFor(browser, baseURL!)
  // Model the browser's heuristic only. The actual relay, socket, queue,
  // publication and received message remain real acceptance-test paths.
  await context.addInitScript(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }))
  const relay = testRelay(baseURL!), secret = generateRoomSecret()
  const { roomId } = deriveRoom(secret)
  const sent: string[] = []
  await context.routeWebSocket(relay, ws => {
    const upstream = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && frame[1].kind === 1460 && frame[1].tags.some((tag: string[]) => tag[0] === 'd' && tag[1] === roomId)) sent.push(frame[1].id)
      upstream.send(raw)
    })
    upstream.onMessage(raw => ws.send(raw))
  })
  try {
    const page = await context.newPage()
    await join(page, encodeJoinUrl(baseURL!, secret, [relay]), 'Ada')
    expect(await page.evaluate(() => navigator.onLine)).toBe(false)
    await page.locator('#chatInput').fill('A local relay is still reachable')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('A local relay is still reachable')
    await expect(page.locator('#outbox')).toBeHidden()
    expect(sent).toHaveLength(1)
    expect(await page.evaluate(() => navigator.onLine)).toBe(false)
  } finally { await context.close() }
})

test('a lost acknowledgement keeps the message until it shows, and never sends it twice', async ({ browser, baseURL }) => {
  const context = await contextFor(browser, baseURL!)
  const relay = testRelay(baseURL!)
  const secret = generateRoomSecret()
  const { roomId } = deriveRoom(secret)
  const sent: string[] = []
  let firstId: string | undefined
  let reject = true
  await context.routeWebSocket(relay, ws => {
    const upstream = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && frame[1].kind === 1460 && frame[1].tags.some((tag: string[]) => tag[0] === 'd' && tag[1] === roomId)) {
        // Control discovery also uses kind 1460. Only the main chat has
        // the room id as its d tag; arm the rejection after joining below.
        if (reject) firstId ??= frame[1].id
        if (frame[1].id === firstId) sent.push(frame[1].id)
      }
      upstream.send(raw)
    })
    upstream.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (reject && frame[0] === 'OK' && frame[1] === firstId) {
        ws.send(JSON.stringify(['OK', frame[1], false, 'acknowledgement lost after delivery']))
      } else ws.send(raw)
    })
  })
  try {
    reject = false
    const page = await context.newPage()
    await join(page, encodeJoinUrl(baseURL!, secret, [relay]), 'Ada')
    reject = true
    await page.locator('#chatInput').fill('Please keep this message')
    await page.locator('#chatInput').press('Enter')
    // The row stands for the message until the message itself is on screen.
    // Here the relay kept it and only its acknowledgement was lost, so it
    // arrives, the row goes, and nothing is sent twice.
    await expect(page.locator('#chatLog')).toContainText('Please keep this message')
    await expect(page.locator('#outbox')).toBeHidden()
    await goToConversation(page, 'Agents')
    await page.locator('#chatInput').fill('A separate draft')
    await expect(page.locator('#chatLog')).not.toContainText('Please keep this message')
    await goToConversation(page, 'Chat')
    await expect(page.locator('#chatLog .msg')).toHaveCount(1)
    await goToConversation(page, 'Agents')
    await expect(page.locator('#chatInput')).toHaveValue('A separate draft')
    expect(firstId).toBeTruthy()
    // Any automatic retry before the message showed is the same event.
    expect(new Set(sent)).toEqual(new Set([firstId]))
  } finally { await context.close() }
})

test('a message written with no relay reachable waits as pending, survives a reload and is sent once', async ({ browser, baseURL }) => {
  const context = await contextFor(browser, baseURL!)
  const relay = testRelay(baseURL!)
  const secret = generateRoomSecret()
  const { roomId } = deriveRoom(secret)
  const chatEvents: string[] = []
  const live = new Set<{ close: () => void }>()
  let blocked = false
  await context.routeWebSocket(relay, ws => {
    if (blocked) { ws.close(); return }
    live.add(ws)
    const upstream = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && frame[1].kind === 1460 && frame[1].tags.some((tag: string[]) => tag[0] === 'd' && tag[1] === roomId)) chatEvents.push(frame[1].id)
      upstream.send(raw)
    })
    upstream.onMessage(raw => ws.send(raw))
  })
  try {
    const page = await context.newPage()
    const url = encodeJoinUrl(baseURL!, secret, [relay])
    await join(page, url, 'Ada')
    blocked = true
    for (const ws of live) ws.close()
    live.clear()
    await page.locator('#chatInput').fill('Written on a train')
    await page.locator('#chatInput').press('Enter')
    const row = page.locator('#outbox .pendingMsg')
    await expect(row).toContainText('Written on a train')
    await expect(row).toContainText('Pending: will send when you are connected.')
    // Nothing has left the page, so it can be edited, or deleted with the
    // promise that nobody sees it.
    await expect(row.getByRole('button', { name: 'Delete' })).toBeVisible()
    await expect(row.getByRole('button', { name: 'Edit' })).toBeVisible()
    expect(chatEvents).toEqual([])
    blocked = false
    await page.reload()
    const joinButton = page.locator('#join')
    const room = page.locator('#roomArea')
    await expect.poll(async () => await joinButton.isVisible() || await room.isVisible()).toBe(true)
    if (await joinButton.isVisible()) await joinButton.click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#chatLog')).toContainText('Written on a train')
    await expect(page.locator('#outbox')).toBeHidden()
    await expect(page.locator('#chatLog .msg', { hasText: 'Written on a train' })).toHaveCount(1)
    expect(chatEvents.length).toBeGreaterThanOrEqual(1)
    expect(new Set(chatEvents).size).toBe(1)
  } finally { await context.close() }
})

test('a message unsent for more than a day is not sent by itself, and Retry sends it as a new message', async ({ browser, baseURL }) => {
  const context = await contextFor(browser, baseURL!)
  const relay = testRelay(baseURL!)
  const secret = generateRoomSecret()
  const { roomId } = deriveRoom(secret)
  const chatEvents: NostrEvent[] = []
  const live = new Set<{ close: () => void }>()
  let blocked = false
  await context.routeWebSocket(relay, ws => {
    if (blocked) { ws.close(); return }
    live.add(ws)
    const upstream = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && frame[1].kind === 1460 && frame[1].tags.some((tag: string[]) => tag[0] === 'd' && tag[1] === roomId)) chatEvents.push(frame[1])
      upstream.send(raw)
    })
    upstream.onMessage(raw => ws.send(raw))
  })
  try {
    const page = await context.newPage()
    await join(page, encodeJoinUrl(baseURL!, secret, [relay]), 'Ada')
    blocked = true
    for (const ws of live) ws.close()
    live.clear()
    const writtenAt = Math.floor(Date.now() / 1000)
    await page.locator('#chatInput').fill('Written before the weekend')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#outbox .pendingMsg')).toContainText('Pending: will send when you are connected.')
    expect(chatEvents).toEqual([])
    // A day and an hour later, by the wall clock, with the relay back.
    await context.addInitScript(() => {
      const real = Date.now.bind(Date)
      Date.now = () => real() + 25 * 60 * 60 * 1000
    })
    blocked = false
    await page.reload()
    const joinButton = page.locator('#join')
    await expect.poll(async () => await joinButton.isVisible() || await page.locator('#roomArea').isVisible()).toBe(true)
    if (await joinButton.isVisible()) await joinButton.click()
    await expect(page.locator('#roomArea')).toBeVisible()
    const row = page.locator('#outbox .pendingMsg')
    await expect(row).toContainText('Written before the weekend')
    await expect(row).toContainText('Not sent: it waited more than a day. Press Retry to send it now.')
    // Opening the room again did not send the old event.
    await page.waitForTimeout(2_000)
    expect(chatEvents).toEqual([])
    await row.getByRole('button', { name: 'Retry' }).click()
    await expect(page.locator('#outbox')).toBeHidden()
    await expect(page.locator('#chatLog .msg', { hasText: 'Written before the weekend' })).toHaveCount(1)
    expect(chatEvents).toHaveLength(1)
    // Signed again, now: not the event written a day ago.
    expect(chatEvents[0]!.created_at).toBeGreaterThanOrEqual(writtenAt + 24 * 60 * 60)
  } finally { await context.close() }
})

test('an unsent message can be edited or deleted before it leaves, without a trace', async ({ browser, baseURL }) => {
  const context = await contextFor(browser, baseURL!)
  const relay = testRelay(baseURL!)
  const secret = generateRoomSecret()
  const { roomId } = deriveRoom(secret)
  const chatEvents: string[] = []
  const live = new Set<{ close: () => void }>()
  let blocked = false
  await context.routeWebSocket(relay, ws => {
    if (blocked) { ws.close(); return }
    live.add(ws)
    const upstream = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && frame[1].kind === 1460 && frame[1].tags.some((tag: string[]) => tag[0] === 'd' && tag[1] === roomId)) chatEvents.push(frame[1].id)
      upstream.send(raw)
    })
    upstream.onMessage(raw => ws.send(raw))
  })
  try {
    const page = await context.newPage()
    await join(page, encodeJoinUrl(baseURL!, secret, [relay]), 'Ada')
    blocked = true
    for (const ws of live) ws.close()
    live.clear()
    await page.locator('#chatInput').fill('Meet at the wrong place')
    await page.locator('#chatInput').press('Enter')
    const row = page.locator('#outbox .pendingMsg')
    await expect(row).toContainText('Pending')
    await row.getByRole('button', { name: 'Edit' }).click()
    await expect(page.locator('#chatInput')).toHaveValue('Meet at the wrong place')
    await expect(page.locator('#outbox')).toBeHidden()
    await page.locator('#chatInput').fill('Meet at the station')
    await page.locator('#chatInput').press('Enter')
    await page.locator('#chatInput').fill('Never mind')
    await page.locator('#chatInput').press('Enter')
    const second = page.locator('#outbox .pendingMsg', { hasText: 'Never mind' })
    await second.getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('button', { name: 'Delete message' }).click()
    await expect(second).toHaveCount(0)
    expect(chatEvents).toEqual([])
    blocked = false
    await expect(page.locator('#chatLog')).toContainText('Meet at the station')
    await expect(page.locator('#outbox')).toBeHidden()
    await expect(page.locator('#chatLog')).not.toContainText('Meet at the wrong place')
    await expect(page.locator('#chatLog')).not.toContainText('Never mind')
    expect(new Set(chatEvents).size).toBe(1)
  } finally { await context.close() }
})

test('a chosen wait before sending gives a moment to undo, and Send now skips it', async ({ browser, baseURL }) => {
  const context = await contextFor(browser, baseURL!)
  await context.addInitScript(() => localStorage.setItem('kithmoot.send-delay', '10'))
  const relay = testRelay(baseURL!)
  const secret = generateRoomSecret()
  const { roomId } = deriveRoom(secret)
  const chatEvents: string[] = []
  await context.routeWebSocket(relay, ws => {
    const upstream = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && frame[1].kind === 1460 && frame[1].tags.some((tag: string[]) => tag[0] === 'd' && tag[1] === roomId)) chatEvents.push(frame[1].id)
      upstream.send(raw)
    })
    upstream.onMessage(raw => ws.send(raw))
  })
  try {
    const page = await context.newPage()
    await join(page, encodeJoinUrl(baseURL!, secret, [relay]), 'Ada')
    await page.locator('#chatInput').fill('Said in haste')
    await page.locator('#chatInput').press('Enter')
    const row = page.locator('#outbox .pendingMsg')
    await expect(row).toContainText(/Sending in \d+ s/)
    await row.getByRole('button', { name: 'Undo' }).click()
    await expect(page.locator('#chatInput')).toHaveValue('Said in haste')
    await expect(page.locator('#outbox')).toBeHidden()
    await page.locator('#chatInput').fill('Said with care')
    await page.locator('#chatInput').press('Enter')
    await page.locator('#outbox .pendingMsg').getByRole('button', { name: 'Send now' }).click()
    await expect(page.locator('#chatLog')).toContainText('Said with care')
    await expect(page.locator('#chatLog')).not.toContainText('Said in haste')
    expect(new Set(chatEvents).size).toBe(1)
  } finally { await context.close() }
})

test('countdown redraw preserves a pressed Undo or Send now button', async ({ browser, baseURL }) => {
  const context = await contextFor(browser, baseURL!)
  await context.addInitScript(() => localStorage.setItem('kithmoot.send-delay', '10'))
  const relay = testRelay(baseURL!)
  const secret = generateRoomSecret()
  const { roomId } = deriveRoom(secret)
  const sent: string[] = []
  await context.routeWebSocket(relay, socket => {
    const upstream = socket.connectToServer()
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && frame[1].kind === 1460 && frame[1].tags.some((tag: string[]) => tag[0] === 'd' && tag[1] === roomId)) sent.push(frame[1].id)
      upstream.send(raw)
    })
    upstream.onMessage(raw => socket.send(raw))
  })
  try {
    const page = await context.newPage()
    await join(page, encodeJoinUrl(baseURL!, secret, [relay]), 'Ada')
    const holdAcrossTick = async (name: string) => {
      const row = page.locator('#outbox .pendingMsg')
      const status = row.locator('.pendingStatus')
      await expect(status).toContainText(/Sending in \d+ s/)
      const before = await status.innerText()
      const button = await row.getByRole('button', { name, exact: true }).elementHandle()
      expect(button).not.toBeNull()
      const bounds = await button!.boundingBox()
      expect(bounds).not.toBeNull()
      await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
      await page.mouse.down()
      try {
        // Wait for the app's real countdown update, not an injected redraw or
        // an arbitrarily timed click that can miss the original race.
        await expect(status).not.toHaveText(before)
        expect(await button!.evaluate(element => element.isConnected)).toBe(true)
      } finally { await page.mouse.up() }
    }
    await page.locator('#chatInput').fill('Keep this unsent draft')
    await page.locator('#chatInput').press('Enter')
    await holdAcrossTick('Undo')
    await expect(page.locator('#chatInput')).toHaveValue('Keep this unsent draft')
    await expect(page.locator('#outbox')).toBeHidden()
    expect(sent).toEqual([])
    await page.locator('#chatInput').fill('Send this after the tick')
    await page.locator('#chatInput').press('Enter')
    await holdAcrossTick('Send now')
    await expect(page.locator('#chatLog')).toContainText('Send this after the tick')
    await expect(page.locator('#chatLog')).not.toContainText('Keep this unsent draft')
    expect(sent).toHaveLength(1)
  } finally { await context.close() }
})

test('incoming chat preserves the reading position and offers a way to the latest messages', async ({ browser, baseURL }) => {
  const a = await contextFor(browser, baseURL!)
  const b = await contextFor(browser, baseURL!)
  try {
    const url = encodeJoinUrl(baseURL!, generateRoomSecret(), [testRelay(baseURL!)])
    const reader = await a.newPage()
    const writer = await b.newPage()
    await join(reader, url, 'Reader')
    await join(writer, url, 'Writer')
    for (let i = 0; i < 12; i++) {
      await writer.locator('#chatInput').fill(`Message ${i}: ` + 'A longer message to fill this phone screen. '.repeat(6))
      await writer.locator('#chatInput').press('Enter')
      await expect(reader.locator('#chatLog .msg')).toHaveCount(i + 1)
    }
    const log = reader.locator('#chatLog')
    await log.evaluate(el => { el.scrollTop = 0 })
    const place = await log.evaluate(el => {
      const edge = el.getBoundingClientRect().top
      const message = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find(message => message.getBoundingClientRect().bottom > edge)!
      return { id: message.dataset.messageId!, offset: message.getBoundingClientRect().top - edge }
    })
    await writer.locator('#chatInput').fill('A new arrival while you read')
    await writer.locator('#chatInput').press('Enter')
    await expect(reader.locator('#chatLog .msg')).toHaveCount(13)
    // Equal timestamps sort by id, so the arrival may land above the reader.
    // Preserve the message on screen, not a scrollbar value that would shift it.
    await expect.poll(() => log.evaluate((el, place) => {
      const message = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find(message => message.dataset.messageId === place.id)!
      return Math.abs(message.getBoundingClientRect().top - el.getBoundingClientRect().top - place.offset)
    }, place)).toBeLessThan(1)
    await expect(reader.locator('#newMessages')).toBeVisible()
    await reader.locator('#newMessages').click()
    await expect.poll(() => log.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(5)
    await expect(reader.locator('#newMessages')).toBeHidden()
    expect(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally { await a.close(); await b.close() }
})

test('public profiles need opt-in, and both choices survive a new visit', async ({ browser, baseURL }) => {
  const context = await contextFor(browser, baseURL!)
  const relay = testRelay(baseURL!)
  const queries: string[][] = []
  await context.routeWebSocket(relay, ws => {
    const upstream = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'REQ') {
        for (const filter of frame.slice(2)) {
          if (filter.kinds?.includes(0) && filter.authors) queries.push(filter.authors)
        }
      }
      upstream.send(raw)
    })
  })
  // Somebody to look up. A browser alone in a room asks nothing: the only
  // key there is the one it made itself, which it never asks about.
  const other = await contextFor(browser, baseURL!)
  try {
    const link = encodeJoinUrl(baseURL!, generateRoomSecret(), [relay])
    await join(await other.newPage(), link, 'Somebody else')
    const page = await context.newPage()
    await join(page, link, 'Private reader')
    await page.locator('#chatInput').fill('No public lookup without permission')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('No public lookup without permission')
    await openProfileSettings(page)
    await expect(page.locator('#lookupProfiles')).not.toBeChecked()
    expect(queries).toHaveLength(0)
    await page.locator('#lookupProfiles').check()
    await expect.poll(() => queries.length).toBeGreaterThan(0)
    const enabledCount = queries.length
    await page.reload()
    await expect(page.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    await openProfileSettings(page)
    await expect(page.locator('#lookupProfiles')).toBeChecked()
    await expect.poll(() => queries.length).toBeGreaterThan(enabledCount)
    await page.locator('#lookupProfiles').uncheck()
    const offCount = queries.length
    await page.reload()
    await expect(page.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    await openProfileSettings(page)
    await expect(page.locator('#lookupProfiles')).not.toBeChecked()
    expect(queries).toHaveLength(offCount)
    await page.locator('#lookupProfiles').check()
    await expect.poll(() => queries.length).toBeGreaterThan(offCount)
  } finally { await context.close(); await other.close() }
})

test('a failed outbox write keeps the actual composer draft and sends nothing', async ({ browser, baseURL }) => {
  const context = await contextFor(browser, baseURL!), relay = testRelay(baseURL!), secret = generateRoomSecret()
  const { roomId } = deriveRoom(secret), sent: string[] = []
  await context.routeWebSocket(relay, ws => {
    const upstream = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && frame[1].kind === 1460 && frame[1].tags.some((tag: string[]) => tag[0] === 'd' && tag[1] === roomId)) sent.push(frame[1].id)
      upstream.send(raw)
    })
    upstream.onMessage(raw => ws.send(raw))
  })
  try {
    const page = await context.newPage(); await join(page, encodeJoinUrl(baseURL!, secret, [relay]), 'Ada')
    await page.evaluate(room => {
      const original = Storage.prototype.setItem
      Storage.prototype.setItem = function(key, value) {
        if (key === `kithmoot.pending.${room}`) throw new DOMException('Outbox quota test', 'QuotaExceededError')
        return original.call(this, key, value)
      }
    }, roomId)
    await page.locator('#chatInput').fill('Keep this draft if storage fails')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#status')).toContainText('Outbox quota test')
    await expect(page.locator('#chatInput')).toHaveValue('Keep this draft if storage fails')
    await expect(page.locator('#outbox')).toBeHidden()
    await expect(page.locator('#chatLog')).not.toContainText('Keep this draft if storage fails')
    expect(sent).toEqual([])
  } finally { await context.close() }
})

test('repeated submits while the actual composer retains a message sign and publish one copy', async ({ browser, baseURL }) => {
  const context = await contextFor(browser, baseURL!), relay = testRelay(baseURL!), secret = generateRoomSecret()
  const { roomId } = deriveRoom(secret), sent: string[] = []
  await context.routeWebSocket(relay, ws => {
    const upstream = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && frame[1].kind === 1460 && frame[1].tags.some((tag: string[]) => tag[0] === 'd' && tag[1] === roomId)) sent.push(frame[1].id)
      upstream.send(raw)
    })
    upstream.onMessage(raw => ws.send(raw))
  })
  try {
    const page = await context.newPage(); await join(page, encodeJoinUrl(baseURL!, secret, [relay]), 'Ada')
    await page.locator('#chatInput').fill('One submission, please')
    await page.locator('#chatForm').evaluate(form => {
      for (let i = 0; i < 4; i++) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await expect(page.locator('#chatLog .msg', { hasText: 'One submission, please' })).toHaveCount(1)
    await expect(page.locator('#chatInput')).toHaveValue('')
    await expect(page.locator('#outbox')).toBeHidden()
    expect(sent).toHaveLength(1)
  } finally { await context.close() }
})

test('changed and reverted drafts during retention neither duplicate the old send nor clear new work', async ({ browser, baseURL }) => {
  const context = await contextFor(browser, baseURL!), relay = testRelay(baseURL!), secret = generateRoomSecret()
  const { roomId } = deriveRoom(secret), sent: string[] = []
  await context.routeWebSocket(relay, ws => {
    const upstream = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && frame[1].kind === 1460 && frame[1].tags.some((tag: string[]) => tag[0] === 'd' && tag[1] === roomId)) sent.push(frame[1].id)
      upstream.send(raw)
    })
    upstream.onMessage(raw => ws.send(raw))
  })
  try {
    const page = await context.newPage(); await join(page, encodeJoinUrl(baseURL!, secret, [relay]), 'Ada')
    await page.evaluate(room => {
      const original = Storage.prototype.setItem
      let injected = false
      Storage.prototype.setItem = function(key, value) {
        original.call(this, key, value)
        if (key !== `kithmoot.pending.${room}` || injected) return
        injected = true
        const input = document.querySelector<HTMLTextAreaElement>('#chatInput')!, form = document.querySelector('#chatForm')!
        input.value = 'The changed submission'; input.dispatchEvent(new Event('input', { bubbles: true }))
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        input.value = 'The original submission'; input.dispatchEvent(new Event('input', { bubbles: true }))
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        input.value = 'Keep this new work'; input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }, roomId)
    await page.locator('#chatInput').fill('The original submission')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog .msg', { hasText: 'The original submission' })).toHaveCount(1)
    await expect(page.locator('#chatLog .msg', { hasText: 'The changed submission' })).toHaveCount(1)
    await expect(page.locator('#chatInput')).toHaveValue('Keep this new work')
    await expect(page.locator('#outbox')).toBeHidden()
    expect(sent).toHaveLength(2)
  } finally { await context.close() }
})

test('choosing another person with the same shown name during retention preserves the new recipient draft', async ({ browser, baseURL }) => {
  const relay = testRelay(baseURL!), secret = generateRoomSecret(), url = encodeJoinUrl(baseURL!, secret, [relay])
  const { roomId, roomKey } = deriveRoom(secret), contexts: BrowserContext[] = [], sent: NostrEvent[] = []
  try {
    for (let i = 0; i < 2; i++) {
      const context = await contextFor(browser, baseURL!); contexts.push(context)
      await join(await context.newPage(), url, 'Robin')
    }
    const context = await contextFor(browser, baseURL!); contexts.push(context)
    await context.routeWebSocket(relay, ws => {
      const upstream = ws.connectToServer()
      ws.onMessage(raw => {
        const frame = JSON.parse(String(raw))
        if (frame[0] === 'EVENT' && frame[1].kind === 1460 && frame[1].tags.some((tag: string[]) => tag[0] === 'd' && tag[1] === roomId)) sent.push(frame[1])
        upstream.send(raw)
      })
      upstream.onMessage(raw => ws.send(raw))
    })
    const page = await context.newPage(); await join(page, url, 'Ada')
    await page.locator('#chatInput').fill('@Ro')
    await expect(page.locator('#mentions [role=option]')).toHaveCount(2)
    await page.locator('#mentions [role=option]').first().dispatchEvent('pointerdown')
    await expect(page.locator('#chatInput')).toHaveValue('@Robin ')
    await page.evaluate(room => {
      const original = Storage.prototype.setItem
      let injected = false
      Storage.prototype.setItem = function(key, value) {
        original.call(this, key, value)
        if (key !== `kithmoot.pending.${room}` || injected) return
        injected = true
        const input = document.querySelector<HTMLTextAreaElement>('#chatInput')!
        input.value = '@Ro'; input.setSelectionRange(3, 3)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        document.querySelectorAll('#mentions [role=option]')[1]!.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
      }
    }, roomId)
    await page.locator('#chatForm').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await expect(page.locator('#chatLog .msg', { hasText: '@Robin' })).toHaveCount(1)
    await expect(page.locator('#chatInput')).toHaveValue('@Robin ')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog .msg', { hasText: '@Robin' })).toHaveCount(2)
    await expect(page.locator('#chatInput')).toHaveValue('')
    const messages = sent.map(event => decodeChatEvent(event, { roomId, roomKey, now: Math.floor(Date.now() / 1000) }))
    expect(messages).toHaveLength(2)
    expect(messages[0]?.mentions).toHaveLength(1); expect(messages[1]?.mentions).toHaveLength(1)
    expect(messages[0]?.mentions).not.toEqual(messages[1]?.mentions)
  } finally { await Promise.all(contexts.map(context => context.close())) }
})

test('a laptop that slept past its device credential sends on waking, without rejoining', async ({ browser, baseURL }) => {
  // A computer asleep runs no timers, but its wall clock moves on. Moving
  // only Date.now models that exactly: the renewal timer stays where it
  // was, and the credential's expiry, which is wall-clock time, passes.
  const asleep = async (): Promise<BrowserContext> => {
    const context = await contextFor(browser, baseURL!)
    await context.addInitScript(() => {
      const real = Date.now.bind(Date)
      const clock = window as unknown as { __sleptMs?: number }
      Date.now = () => real() + (clock.__sleptMs ?? 0)
    })
    return context
  }
  const relay = testRelay(baseURL!), secret = generateRoomSecret()
  const url = encodeJoinUrl(baseURL!, secret, [relay])
  const thirteenHours = 13 * 60 * 60 * 1000
  const ada = await asleep(), bea = await asleep()
  try {
    const page = await ada.newPage()
    await join(page, url, 'Ada')
    await page.evaluate(ms => { (window as unknown as { __sleptMs?: number }).__sleptMs = ms }, thirteenHours)
    await page.locator('#chatInput').fill('Good morning, I slept')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('Good morning, I slept')
    await expect(page.locator('#outbox')).toBeHidden()
    await expect(page.locator('#chatInput')).toHaveValue('')
    await expect(page.locator('#status')).not.toContainText(/rejoin|ran out|no longer valid/i)

    // Somebody else, on the same morning, reads it: it was signed under a
    // credential that was good when it was sent.
    const reader = await bea.newPage()
    await reader.addInitScript(ms => { (window as unknown as { __sleptMs?: number }).__sleptMs = ms }, thirteenHours)
    await join(reader, url, 'Bea')
    await expect(reader.locator('#chatLog')).toContainText('Good morning, I slept')
  } finally {
    await ada.close()
    await bea.close()
  }
})
