import { test, expect, type Browser, type BrowserContext } from '@playwright/test'
import { generateRoomSecret, encodeJoinUrl } from '../src/room.js'
import { buildFileEvent } from '../src/attachment.js'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { RoomAgent } from '../src/agent.js'
import { withRelays } from './relays.js'
import { goToConversation, openRoomDetails } from './browser.js'

async function setup(browser: Browser, baseURL: string, beforeJoin?: (context: BrowserContext, relay: string) => Promise<void>) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  await beforeJoin?.(context, relay.href)
  const page = await context.newPage()
  await page.goto(encodeJoinUrl(baseURL, generateRoomSecret(), [relay.href]))
  await page.locator('#displayName').fill('Ada')
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  return { page, context }
}

test('drafts stay with their conversations, including files and a visit to read-only minutes', async ({ browser, baseURL }) => {
  const { page, context } = await setup(browser, baseURL!)
  try {
    const event = finalizeEvent(buildFileEvent({ url: `https://files.example/${'ab'.repeat(32)}`, sha256: 'ab'.repeat(32), size: 65608 }), generateSecretKey())
    await page.locator('#chatInput').fill('A draft for the main chat')
    await page.locator('#chatInput').evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(2, 7))
    await page.locator('#attachToggle').click()
    await page.locator('#attachEvent').fill(JSON.stringify(event))
    await page.locator('#attachKey').fill('cd'.repeat(32))
    await page.locator('#attachAdd').click()
    await expect(page.locator('#attachStaged .attachChip')).toHaveCount(1)
    await goToConversation(page, 'Agents')
    await expect(page.locator('#chatInput')).toHaveValue('', { timeout: 5000 })
    await expect(page.locator('#attachStaged .attachChip')).toHaveCount(0)
    await page.locator('#chatInput').fill('A separate draft for agents')
    await goToConversation(page, 'Minutes')
    await expect(page.locator('#chatForm')).toBeHidden()
    await expect(page.locator('#attachPanel')).toBeHidden()
    await expect(page.locator('#attachStaged')).toBeHidden()
    await goToConversation(page, 'Chat')
    await expect(page.locator('#chatInput')).toHaveValue('A draft for the main chat')
    await expect.poll(() => page.locator('#chatInput').evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd])).toEqual([2, 7])
    await expect(page.locator('#attachStaged .attachChip')).toHaveCount(1)
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('A draft for the main chat')
    await expect(page.locator('#chatLog .attachment')).toHaveCount(1)
    await goToConversation(page, 'Agents')
    await expect(page.locator('#chatInput')).toHaveValue('A separate draft for agents')
    await expect(page.locator('#chatLog')).not.toContainText('A draft for the main chat')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('A separate draft for agents')
    await expect(page.locator('#chatLog .attachment')).toHaveCount(0)
    await goToConversation(page, 'Chat')
    await expect(page.locator('#chatInput')).toHaveValue('')
    await expect(page.locator('#chatLog')).not.toContainText('A separate draft for agents')
  } finally { await context.close() }
})

test('an upload finishes in its original draft while another conversation is used', async ({ browser, baseURL }) => {
  const { page, context } = await setup(browser, baseURL!)
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  let uploads = 0
  await context.route('https://files.example/upload', async route => {
    uploads++
    const request = route.request()
    const hash = request.headers()['x-sha-256']
    const size = request.postDataBuffer()!.length
    await released
    await route.fulfill({ status: 201, json: { url: `https://files.example/${hash}`, sha256: hash, size } })
  })
  try {
    await page.locator('#chatInput').fill('This file belongs in Chat')
    await page.locator('#attachToggle').click()
    await page.locator('#attachServer').fill('https://files.example')
    await page.locator('#attachServer').press('Tab')
    await page.locator('#attachFile').setInputFiles({ name: 'workshop.txt', mimeType: 'text/plain', buffer: Buffer.from('Workshop materials') })
    await expect.poll(() => uploads).toBe(1)
    await expect(page.locator('#chatForm button[type="submit"]')).toBeDisabled()
    await goToConversation(page, 'Agents')
    await page.locator('#chatInput').fill('Keep typing in Agents')
    release()
    await openRoomDetails(page)
    await expect(page.locator('#channelBar button', { hasText: 'Chat' })).toContainText('Draft')
    await page.locator('#roomSheetClose').click()
    await expect(page.locator('#chatInput')).toHaveValue('Keep typing in Agents')
    await expect(page.locator('#attachStaged .attachChip')).toHaveCount(0)
    await goToConversation(page, 'Chat')
    await expect(page.locator('#attachStaged')).toContainText('workshop.txt')
    await expect(page.locator('#chatInput')).toHaveValue('This file belongs in Chat')
    await expect(page.locator('#chatForm button[type="submit"]')).toBeEnabled()
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('workshop.txt')
    await goToConversation(page, 'Agents')
    await expect(page.locator('#chatInput')).toHaveValue('Keep typing in Agents')
    await expect(page.locator('#chatLog')).not.toContainText('workshop.txt')
    expect(uploads).toBe(1)
  } finally { release(); await context.close() }
})

test('unsent work in another conversation still protects room changes and can be discarded explicitly', async ({ browser, baseURL }) => {
  const { page, context } = await setup(browser, baseURL!)
  try {
    await page.locator('#chatInput').fill('Do not lose this hidden draft')
    await goToConversation(page, 'Agents')
    await expect(page.locator('#chatInput')).toHaveValue('')
    await page.locator('#backToRooms').click()
    await expect(page.locator('#roomSwitcherHome')).toBeDisabled()
    await expect(page.locator('#roomSwitcherNote')).toContainText('unfinished')
    await page.locator('#roomSwitcherClose').click()
    await goToConversation(page, 'Chat')
    await openRoomDetails(page)
    page.once('dialog', dialog => dialog.dismiss())
    await page.locator('#discardDraft').click()
    await page.locator('#roomSheetClose').click()
    await expect(page.locator('#chatInput')).toHaveValue('Do not lose this hidden draft')
    await openRoomDetails(page)
    page.once('dialog', dialog => dialog.accept())
    await page.locator('#discardDraft').click()
    await page.locator('#roomSheetClose').click()
    await expect(page.locator('#chatInput')).toHaveValue('')
    await page.locator('#backToRooms').click()
    await expect(page.locator('#roomSwitcherHome')).toBeEnabled()
    expect(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('Do not lose this hidden draft')))).toBe(false)
  } finally { await context.close() }
})

test('unfinished file details stay in their draft and are never stored on disk', async ({ browser, baseURL }) => {
  const { page, context } = await setup(browser, baseURL!)
  try {
    await page.locator('#attachToggle').click()
    await page.locator('#attachEvent').fill('Unfinished file details')
    await page.locator('#attachKey').fill('Secret for this draft only')
    await goToConversation(page, 'Agents')
    await page.locator('#attachToggle').click()
    await expect(page.locator('#attachEvent')).toHaveValue('')
    await expect(page.locator('#attachKey')).toHaveValue('')
    await page.locator('#attachEvent').fill('A different file')
    await goToConversation(page, 'Chat')
    await expect(page.locator('#attachPanel')).toBeVisible()
    await expect(page.locator('#attachEvent')).toHaveValue('Unfinished file details')
    await expect(page.locator('#attachKey')).toHaveValue('Secret for this draft only')
    expect(await page.evaluate(() => [localStorage, sessionStorage].some(store => Object.values(store).some(value => /Unfinished file details|Secret for this draft only/.test(value))))).toBe(false)
  } finally { await context.close() }
})

test('stopping an upload permits another attempt without adding the late result', async ({ browser, baseURL }) => {
  const { page, context } = await setup(browser, baseURL!)
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  let uploads = 0
  await context.route('https://files.example/upload', async route => {
    const number = ++uploads
    const request = route.request()
    const hash = request.headers()['x-sha-256']
    const size = request.postDataBuffer()!.length
    if (number === 1) await released
    await route.fulfill({ status: 201, json: { url: `https://files.example/${hash}`, sha256: hash, size } }).catch(() => {})
  })
  try {
    await page.locator('#attachToggle').click()
    await page.locator('#attachServer').fill('https://files.example')
    await page.locator('#attachServer').press('Tab')
    await page.locator('#attachFile').setInputFiles({ name: 'cancelled.txt', mimeType: 'text/plain', buffer: Buffer.from('Do not attach this') })
    await expect.poll(() => uploads).toBe(1)
    // A second drop while this conversation is busy must not start another
    // upload or bypass its attachment cap.
    await page.locator('#chatForm').evaluate(form => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['Do not start a second upload'], 'second.txt', { type: 'text/plain' }))
      form.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }))
    })
    await page.locator('#cancelFileWork').click()
    await expect(page.locator('#attachStatus')).toContainText('Stopped adding files')
    await expect(page.locator('#attachFile')).toBeEnabled()
    expect(uploads).toBe(1)
    await page.locator('#attachFile').setInputFiles({ name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep this one') })
    await expect(page.locator('#attachStaged')).toContainText('keep.txt')
    release()
    await expect(page.locator('#attachStaged .attachChip')).toHaveCount(1)
    await expect(page.locator('#attachStaged')).not.toContainText('cancelled.txt')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('keep.txt')
    await expect(page.locator('#chatLog')).not.toContainText('cancelled.txt')
    expect(uploads).toBe(2)
  } finally { release(); await context.close() }
})

test('stopping during a stalled relay announcement releases the draft and ignores the late acknowledgement', async ({ browser, baseURL }) => {
  let release: (() => void) | undefined
  const { page, context } = await setup(browser, baseURL!, async (context, relay) => {
    await context.routeWebSocket(relay, ws => {
      const upstream = ws.connectToServer()
      let firstFileId: string | undefined
      ws.onMessage(raw => {
        const frame = JSON.parse(String(raw))
        if (frame[0] === 'EVENT' && frame[1].kind === 1063) firstFileId ??= frame[1].id
        upstream.send(raw)
      })
      upstream.onMessage(raw => {
        const frame = JSON.parse(String(raw))
        if (frame[0] === 'OK' && frame[1] === firstFileId) release = () => ws.send(raw)
        else ws.send(raw)
      })
    })
    await context.route('https://files.example/upload', async route => {
      const request = route.request()
      const sha256 = request.headers()['x-sha-256']
      await route.fulfill({ status: 201, json: { url: `https://files.example/${sha256}`, sha256, size: request.postDataBuffer()!.length } })
    })
  })
  try {
    await page.locator('#attachToggle').click()
    await page.locator('#attachServer').fill('https://files.example')
    await page.locator('#attachServer').press('Tab')
    await page.locator('#attachFile').setInputFiles({ name: 'late.txt', mimeType: 'text/plain', buffer: Buffer.from('Do not attach the late result') })
    await expect.poll(() => Boolean(release)).toBe(true)
    await expect(page.locator('#attachStatus')).toContainText('Announcing')
    await page.locator('#cancelFileWork').click()
    await expect(page.locator('#attachFile')).toBeEnabled({ timeout: 3000 })
    await expect(page.locator('#attachStatus')).toContainText('Stopped adding files')
    await page.locator('#attachFile').setInputFiles({ name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep this file') })
    await expect(page.locator('#attachStaged')).toContainText('keep.txt')
    release!()
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('keep.txt')
    await expect(page.locator('#chatLog')).not.toContainText('late.txt')
    await expect(page.locator('#attachStaged .attachChip')).toHaveCount(0)
  } finally { await context.close() }
})

test('closing a conversation keeps its draft reachable and prevents sending it into another conversation', async ({ browser, baseURL }) => {
  const keeper = await RoomAgent.create({ base: baseURL!, name: 'Keeper', relays: ['ws://127.0.0.1:7777'] })
  await keeper.setChannel('workshop', true)
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  const relay = new URL('/__test-relay', baseURL!); relay.protocol = 'wss:'
  await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  try {
    const page = await context.newPage()
    await page.goto(withRelays(keeper.url, [relay.href]))
    await page.locator('#displayName').fill('Ada')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.locator('#chatInput').fill('Main chat draft')
    await goToConversation(page, 'workshop')
    await page.locator('#chatInput').fill('Keep the closed conversation draft')
    await keeper.setChannel('workshop', false)
    await expect(page.locator('#readOnlyNote')).toContainText('closed')
    await expect(page.locator('#chatInput')).toHaveValue('Keep the closed conversation draft')
    await expect(page.locator('#chatInput')).toHaveJSProperty('readOnly', true)
    await expect(page.locator('#chatForm button[type="submit"]')).toBeDisabled()
    await goToConversation(page, 'Chat')
    await expect(page.locator('#chatInput')).toHaveValue('Main chat draft')
    await goToConversation(page, 'workshop')
    await expect(page.locator('#chatInput')).toHaveValue('Keep the closed conversation draft')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).not.toContainText('Keep the closed conversation draft')
    await openRoomDetails(page)
    page.once('dialog', dialog => dialog.accept())
    await page.locator('#discardDraft').click()
    await expect(page.locator('#roomSheet')).toHaveJSProperty('open', false)
    await expect(page.locator('#chatInput')).toHaveValue('Main chat draft')
    await openRoomDetails(page)
    await expect(page.locator('#channelBar button', { hasText: 'workshop' })).toHaveCount(0)
  } finally { await keeper.leave(); await context.close() }
})

test('cancelling a browser reload keeps a draft from another conversation', async ({ browser, baseURL }) => {
  const { page, context } = await setup(browser, baseURL!)
  try {
    await page.locator('#chatInput').fill('Keep this through a cancelled reload')
    await goToConversation(page, 'Agents')
    const warning = page.waitForEvent('dialog')
    await page.evaluate(() => { setTimeout(() => location.reload(), 0) })
    const dialog = await warning
    expect(dialog.type()).toBe('beforeunload')
    await dialog.dismiss()
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#chatInput')).toHaveValue('')
    await goToConversation(page, 'Chat')
    await expect(page.locator('#chatInput')).toHaveValue('Keep this through a cancelled reload')
  } finally { await context.close() }
})
