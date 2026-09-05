import { test, expect, type Browser } from '@playwright/test'
import { deriveRoom, encodeJoinUrl, generateRoomSecret } from '../src/room.js'
import { RoomAgent } from '../src/agent.js'
import { KINDS } from '../src/kinds.js'
import { withRelays } from './relays.js'

async function device(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 740 } })
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  await context.addInitScript(relay => {
    const sockets: WebSocket[] = []
    ;(window as typeof window & { testSockets: WebSocket[] }).testSockets = sockets
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        const defaults = ['wss://relay.trotters.cc', 'wss://nos.lol', 'wss://relay.primal.net']
        const target = defaults.includes(String(url).replace(/\/$/, '')) ? relay : String(url)
        if (target !== relay) throw new Error('External relay blocked by test')
        super(target, protocols)
        sockets.push(this)
      }
    }
  }, relay.href)
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  return { context, relay: relay.href }
}

test('the home page leads with room actions, fits both themes and starts a named room from the keyboard', async ({ browser, baseURL }) => {
  const { context } = await device(browser, baseURL!)
  try {
    const page = await context.newPage()
    await page.goto(baseURL!)
    await expect(page.locator('#home')).toBeVisible()
    await expect(page.locator('#displayName')).toBeHidden()
    await expect(page.locator('#notify')).toBeHidden()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 740 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        const start = await page.locator('#create').boundingBox()
        const signIn = await page.locator('#signIn').boundingBox()
        expect(start!.y).toBeLessThan(signIn!.y)
      }
    }
    await page.setViewportSize({ width: 390, height: 740 })
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.evaluate(() => { document.documentElement.style.fontSize = '' })
    await page.setViewportSize({ width: 390, height: 540 })
    const start = await page.locator('#create').boundingBox()
    expect(start!.y + start!.height).toBeLessThanOrEqual(540)
    await page.locator('#roomName').fill('Saturday workshop')
    await page.locator('#roomName').press('Enter')
    await expect(page.locator('#arrivalTitle')).toHaveText('Saturday workshop')
    await expect(page.locator('#home')).toBeHidden()
    await expect(page.locator('#displayName')).toBeFocused()
    await page.locator('#displayName').fill('Ada')
    await page.locator('#displayName').press('Enter')
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#roomTitle')).toHaveText('Saturday workshop')
    await expect(page.locator('#toggleMic')).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('#toggleCamera')).toHaveAttribute('aria-pressed', 'false')
  } finally { await context.close() }
})

test('invalid links stay beside their field and a complete invitation from another host opens in this app', async ({ browser, baseURL }) => {
  const { context, relay } = await device(browser, baseURL!)
  try {
    const page = await context.newPage()
    await page.goto(baseURL!)
    for (const value of ['', 'javascript:window.badLink=true', 'https://example.com/ordinary-page', 'https://example.com/#bad']) {
      await page.locator('#url').fill(value)
      await page.locator('#url').press('Enter')
      await expect(page.locator('#linkError')).toBeVisible()
      await expect(page.locator('#url')).toHaveAttribute('aria-invalid', 'true')
      await expect(page.locator('#url')).toBeFocused()
      expect(page.url()).toBe(baseURL!)
    }
    expect(await page.evaluate(() => 'badLink' in window)).toBe(false)
    const link = encodeJoinUrl('https://another-host.example/rooms/', generateRoomSecret(), [relay])
    await page.locator('#url').fill(link)
    await expect(page.locator('#linkError')).toBeHidden()
    await page.locator('#url').press('Enter')
    await expect(page.locator('#join')).toBeVisible()
    expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin)
    expect(new URL(page.url()).hash).toBe(new URL(link).hash)
    await page.locator('#displayName').fill('Visitor')
    await page.locator('#displayName').press('Enter')
    await expect(page.locator('#roomArea')).toBeVisible()
  } finally { await context.close() }
})

test('saved rooms can be searched and refreshed without losing the selected room action', async ({ browser, baseURL }) => {
  const { context, relay } = await device(browser, baseURL!)
  const rooms = ['Saturday workshop', 'Workshop notes', 'Garden group'].map((name, index) => {
    const secret = generateRoomSecret()
    return { roomId: deriveRoom(secret).roomId, name, link: encodeJoinUrl(baseURL!, secret, [relay]), openedAt: 100 + index, readAt: 0 }
  })
  await context.addInitScript(rooms => {
    for (const room of rooms) localStorage.setItem(`kithmoot.room.${room.roomId}`, JSON.stringify(room))
  }, rooms)
  try {
    const page = await context.newPage()
    await page.clock.install()
    await page.goto(baseURL!)
    await expect(page.locator('#roomList .roomRow')).toHaveCount(3)
    await page.locator('#homeRoomQuery').fill('WORKSHOP')
    await expect(page.locator('#roomList .roomRow')).toHaveCount(2)
    await expect(page.locator('#homeRoomResults')).toHaveText('2 rooms found')
    const open = page.getByRole('button', { name: 'Open Saturday workshop', exact: true })
    await open.focus()
    await page.clock.runFor(5100)
    await expect(open).toBeFocused()
    await expect(page.locator('#homeRoomQuery')).toHaveValue('WORKSHOP')
    await page.locator('#homeRoomQuery').fill('No such room')
    await expect(page.locator('#homeRoomResults')).toHaveText('No rooms match this search.')
    await expect(page.locator('#roomList .roomRow')).toHaveCount(0)
    await page.locator('#clearHomeRoomQuery').click()
    await expect(page.locator('#homeRoomQuery')).toBeFocused()
    await expect(page.locator('#roomList .roomRow')).toHaveCount(3)
    await page.locator('#homeRoomQuery').fill(rooms[0]!.roomId.slice(0, 12))
    await expect(page.locator('#roomList .roomRow')).toHaveCount(1)
    await open.click()
    await expect(page.locator('#join')).toBeVisible()
    expect(new URL(page.url()).hash).toBe(new URL(rooms[0]!.link).hash)
    expect(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('No such room')))).toBe(false)
  } finally { await context.close() }
})

test('an incomplete invitation has a clear way back to rooms', async ({ browser, baseURL }) => {
  const { context } = await device(browser, baseURL!)
  try {
    const page = await context.newPage()
    await page.goto(baseURL! + '#bad')
    await expect(page.locator('#arrivalTitle')).toHaveText('This invitation is incomplete')
    await expect(page.locator('#joinRoomForm')).toBeHidden()
    await expect(page.locator('#retryArrival')).toBeHidden()
    await expect(page.locator('#setup')).toBeHidden()
    await page.locator('#arrivalHome').click()
    await expect(page.locator('#home')).toBeVisible()
    expect(new URL(page.url()).hash).toBe('')
  } finally { await context.close() }
})

test('an unanswered invitation can be retried without losing the name already entered', async ({ browser, baseURL }) => {
  const host = await RoomAgent.create({ base: baseURL!, name: 'Host', relays: ['ws://127.0.0.1:7777'] })
  const { context, relay } = await device(browser, baseURL!)
  let ignoreGrants = true
  await context.routeWebSocket(relay, ws => {
    const upstream = ws.connectToServer()
    upstream.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (ignoreGrants && frame[0] === 'EVENT' && frame[2]?.kind === KINDS.INVITATION_GRANT) return
      ws.send(raw)
    })
  })
  try {
    const page = await context.newPage()
    await page.clock.install()
    await page.goto(withRelays(host.url, [relay]))
    await expect(page.locator('#status')).toContainText('Getting you in')
    await page.locator('#displayName').fill('Keep my name')
    await page.clock.fastForward(61_000)
    await expect(page.locator('#arrivalTitle')).toHaveText('The room has not answered')
    await expect(page.locator('#retryArrival')).toBeVisible()
    await expect(page.locator('#joinRoomForm')).toBeHidden()
    ignoreGrants = false
    await page.clock.setSystemTime(new Date())
    await page.locator('#retryArrival').click()
    await expect(page.locator('#join')).toBeVisible()
    await expect(page.locator('#displayName')).toHaveValue('Keep my name')
    await expect(page.locator('#arrivalActions')).toBeHidden()
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
  } finally { await host.leave(); await context.close() }
})

test('a retired invitation asks for a current link and does not offer a pointless retry', async ({ browser, baseURL }) => {
  const host = await RoomAgent.create({ base: baseURL!, name: 'Host', relays: ['ws://127.0.0.1:7777'] })
  const { context, relay } = await device(browser, baseURL!)
  try {
    const oldLink = withRelays(host.url, [relay])
    await host.closeRoom()
    const page = await context.newPage()
    await page.goto(oldLink)
    await expect(page.locator('#arrivalTitle')).toHaveText('This invitation is no longer valid')
    await expect(page.locator('#arrivalLead')).toContainText('current invitation')
    await expect(page.locator('#retryArrival')).toBeHidden()
    await expect(page.locator('#joinRoomForm')).toBeHidden()
    await page.locator('#arrivalHome').click()
    await expect(page.locator('#home')).toBeVisible()
  } finally { await host.leave(); await context.close() }
})

test('a rejected join closes its relay connection and can be retried from the name field', async ({ browser, baseURL }) => {
  const { context, relay } = await device(browser, baseURL!)
  let reject = true
  await context.routeWebSocket(relay, ws => {
    const upstream = ws.connectToServer()
    const roster = new Set<string>()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && frame[1].kind === KINDS.ROSTER) roster.add(frame[1].id)
      upstream.send(raw)
    })
    upstream.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (reject && frame[0] === 'OK' && roster.has(frame[1])) ws.send(JSON.stringify(['OK', frame[1], false, 'try again']))
      else ws.send(raw)
    })
  })
  try {
    const page = await context.newPage()
    await page.goto(encodeJoinUrl(baseURL!, generateRoomSecret(), [relay]))
    await page.locator('#displayName').fill('Ada')
    await page.locator('#displayName').press('Enter')
    await expect(page.locator('#status')).toContainText('Could not join the room')
    await expect(page.locator('#join')).toBeEnabled()
    await expect(page.locator('#joinRoomForm')).not.toHaveAttribute('aria-busy')
    await expect.poll(() => page.evaluate(() => (window as typeof window & { testSockets: WebSocket[] }).testSockets.filter(socket => socket.readyState < WebSocket.CLOSING).length)).toBe(0)
    await expect(page.locator('#displayName')).toHaveValue('Ada')
    reject = false
    await page.locator('#displayName').press('Enter')
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#status')).toBeEmpty()
  } finally { await context.close() }
})
