import { test, expect, type Browser, type BrowserContext } from '@playwright/test'
import { generateRoomSecret, encodeJoinUrl } from '../src/room.js'
import { buildFileEvent } from '../src/attachment.js'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { RoomAgent } from '../src/agent.js'
import { withRelays } from './relays.js'
import { goToConversation, openRoomDetails, allowTestFileStorage, TEST_RELAY_WS } from './browser.js'
import { fetchFromTestBlossom, routeTestBlossom } from './blossom.js'

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

test('file storage defaults off and only remembers explicit shared-host consent', async ({ browser, baseURL }) => {
  const { page, context } = await setup(browser, baseURL!)
  try {
    await page.locator('#attachToggle').click()
    await page.locator('#fileStorageOptions').evaluate(d => { (d as HTMLDetailsElement).open = true })
    await expect(page.locator('#attachServer')).toHaveValue(new URL(baseURL!).origin)
    await expect(page.locator('#fileStorageStatus')).toContainText('File uploads are off')
    await page.locator('#saveFileStorage').click()
    await expect(page.locator('#attachStatus')).toContainText('Confirm')
    await page.locator('#attachServer').fill('https://files.example')
    await page.locator('#allowSharedFiles').check()
    await page.locator('#saveFileStorage').click()
    await expect(page.locator('#fileStorageStatus')).toContainText('Uploads go to https://files.example')
    await page.reload()
    // The start page initialises the remembered setting before a room is joined.
    await expect(page.locator('#attachServer')).toHaveValue('https://files.example')
    await expect(page.locator('#fileStorageStatus')).toContainText('Uploads go to https://files.example')
  } finally { await context.close() }
})

test('legacy settings, picker and drop cannot upload without consent; editing revokes it', async ({ browser, baseURL }, testInfo) => {
  const { page, context } = await setup(browser, baseURL!, async c => {
    await c.addInitScript(origin => localStorage.setItem('kithmoot.blossom-server', origin), new URL(baseURL!).origin)
  })
  let uploads = 0
  await context.route('**/upload', route => { uploads++; return route.abort() })
  try {
    await page.locator('#attachToggle').click()
    await expect(page.locator('#fileStorageStatus')).toContainText('File uploads are off')
    await page.locator('#attachFile').setInputFiles({ name: 'private.txt', mimeType: 'text/plain', buffer: Buffer.from('Stay here') })
    await expect(page.locator('#attachStatus')).toContainText('File uploads are off')
    expect(uploads).toBe(0)
    await page.locator('#chatForm').evaluate(form => {
      const data = new DataTransfer(); data.items.add(new File(['Stay here'], 'drop.txt', { type: 'text/plain' }))
      form.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
    })
    await expect(page.locator('#attachStatus')).toContainText('File uploads are off')
    await expect(page.locator('#attachFile')).toBeEnabled()
    expect(uploads).toBe(0)
    await allowTestFileStorage(page, new URL(baseURL!).origin)
    await page.locator('#attachServer').fill('not a URL')
    await expect(page.locator('#fileStorageStatus')).toContainText('File uploads are off')
    await expect(page.locator('#allowSharedFiles')).not.toBeChecked()
    await page.locator('#attachFile').setInputFiles({ name: 'still-private.txt', mimeType: 'text/plain', buffer: Buffer.from('Stay here') })
    await expect(page.locator('#attachStatus')).toContainText('File uploads are off')
    expect(uploads).toBe(0)
    await page.locator('#attachPanel').screenshot({ path: testInfo.outputPath('file-storage-off.png') })
  } finally { await context.close() }
})

test('turning uploads off in another tab blocks subsequent files without deleting old preferences', async ({ browser, baseURL }) => {
  const { page, context } = await setup(browser, baseURL!)
  let uploads = 0
  await context.route('**/upload', route => { uploads++; return route.abort() })
  try {
    await allowTestFileStorage(page, new URL(baseURL!).origin)
    const other = await context.newPage()
    await other.goto(new URL('/j/', baseURL!).href)
    await other.evaluate(() => localStorage.removeItem('kithmoot.file-storage.v1'))
    await expect(page.locator('#fileStorageStatus')).toContainText('File uploads are off')
    await page.locator('#attachFile').setInputFiles({ name: 'private.txt', mimeType: 'text/plain', buffer: Buffer.from('Stay here') })
    await expect(page.locator('#attachStatus')).toContainText('File uploads are off')
    expect(uploads).toBe(0)
    await allowTestFileStorage(page, new URL(baseURL!).origin)
    await page.locator('#stopFileUploads').click()
    await expect(page.locator('#fileStorageStatus')).toContainText('File uploads are off')
    await page.reload()
    await expect(page.locator('#fileStorageStatus')).toContainText('File uploads are off')
  } finally { await context.close() }
})

test('revoking consent during a batch stops the next upload and preserves the already uploaded attachment', async ({ browser, baseURL }) => {
  const { page, context } = await setup(browser, baseURL!)
  const origin = new URL(baseURL!).origin
  let uploads = 0
  await context.route(`${origin}/upload`, async route => {
    uploads++
    const response = await fetchFromTestBlossom(route, origin)
    await page.evaluate(() => localStorage.removeItem('kithmoot.file-storage.v1'))
    await route.fulfill({ response })
  })
  try {
    await allowTestFileStorage(page, origin)
    await page.locator('#attachFile').setInputFiles([
      { name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('First synthetic file') },
      { name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep this local') },
    ])
    await expect(page.locator('#attachStatus')).toContainText('File uploads are off')
    expect(uploads).toBe(1)
    await expect(page.locator('#attachStaged .attachChip')).toHaveCount(1)
    await expect(page.locator('#attachStaged')).toContainText('first.txt')
  } finally { await context.close() }
})

test('drafts stay with their conversations, including files and a visit to read-only minutes', async ({ browser, baseURL }) => {
  const { page, context } = await setup(browser, baseURL!)
  try {
    const event = finalizeEvent(buildFileEvent({ url: `https://files.example/${'ab'.repeat(32)}`, sha256: 'ab'.repeat(32), size: 65608 }), generateSecretKey())
    await page.locator('#chatInput').fill('A draft for the main chat')
    await page.locator('#chatInput').evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(2, 7))
    await page.locator('#attachToggle').click()
    await page.locator('#attachOptions').evaluate(d => { (d as HTMLDetailsElement).open = true })
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
  const blobOrigin = new URL(baseURL!).origin
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  let uploads = 0
  await context.route(`${blobOrigin}/upload`, async route => {
    uploads++
    const response = await fetchFromTestBlossom(route, blobOrigin)
    await released
    await route.fulfill({ response })
  })
  try {
    await page.locator('#chatInput').fill('This file belongs in Chat')
    await page.locator('#attachToggle').click()
    await page.locator('#attachOptions').evaluate(d => { (d as HTMLDetailsElement).open = true })
    await allowTestFileStorage(page, blobOrigin)
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
    await expect(page.locator('#roomSwitcherNote')).toContainText('drafts')
    await page.locator('#roomSwitcherClose').click()
    await goToConversation(page, 'Chat')
    await openRoomDetails(page)
    await page.locator('#discardDraft').click()
    await page.locator('#actionCancel').click()
    await page.locator('#roomSheetClose').click()
    await expect(page.locator('#chatInput')).toHaveValue('Do not lose this hidden draft')
    await openRoomDetails(page)
    await page.locator('#discardDraft').click()
    await page.locator('#actionConfirm').click()
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
    await page.locator('#attachOptions').evaluate(d => { (d as HTMLDetailsElement).open = true })
    await page.locator('#attachEvent').fill('Unfinished file details')
    await page.locator('#attachKey').fill('Secret for this draft only')
    await goToConversation(page, 'Agents')
    await page.locator('#attachToggle').click()
    await page.locator('#attachOptions').evaluate(d => { (d as HTMLDetailsElement).open = true })
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
  const blobOrigin = new URL(baseURL!).origin
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  let uploads = 0
  await context.route(`${blobOrigin}/upload`, async route => {
    const number = ++uploads
    const response = await fetchFromTestBlossom(route, blobOrigin)
    if (number === 1) await released
    await route.fulfill({ response }).catch(() => {})
  })
  try {
    await page.locator('#attachToggle').click()
    await page.locator('#attachOptions').evaluate(d => { (d as HTMLDetailsElement).open = true })
    await allowTestFileStorage(page, blobOrigin)
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
  const blobOrigin = new URL(baseURL!).origin
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
    await context.route(`${blobOrigin}/upload`, async route => {
      await route.fulfill({ response: await fetchFromTestBlossom(route, blobOrigin) })
    })
  })
  try {
    await page.locator('#attachToggle').click()
    await page.locator('#attachOptions').evaluate(d => { (d as HTMLDetailsElement).open = true })
    await allowTestFileStorage(page, blobOrigin)
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
  const keeper = await RoomAgent.create({ base: baseURL!, name: 'Keeper', relays: [TEST_RELAY_WS] })
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
    await page.locator('#discardDraft').click()
    await page.locator('#actionConfirm').click()
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


test('pasted files stay staged until Send and text attachments display as inert text', async ({ browser, baseURL }) => {
  const { page, context } = await setup(browser, baseURL!)
  const origin = new URL(baseURL!).origin
  await context.route(`${origin}/upload`, async route => {
    await route.fulfill({ response: await fetchFromTestBlossom(route, origin) })
  })
  await context.route(url => url.origin === origin && url.pathname.startsWith('/blossom/'), async route => {
    await route.fulfill({ response: await fetchFromTestBlossom(route, origin) })
  })
  try {
    await allowTestFileStorage(page, origin)
    await page.locator('#chatInput').fill('Attached notes')
    await page.locator('#chatInput').evaluate(input => {
      const clipboard = new DataTransfer()
      clipboard.items.add(new File(['<script>window.previewExecuted = true</script>'], 'notes.html', { type: 'text/html' }))
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
      // Firefox ignores the constructor's synthetic clipboardData; provide
      // the same data a trusted paste supplies without depending on the OS clipboard.
      Object.defineProperty(event, 'clipboardData', { value: clipboard })
      input.dispatchEvent(event)
    })
    await expect(page.locator('#attachCount')).toContainText('(1)')
    await expect(page.locator('#chatInput')).toHaveValue('Attached notes')
    await expect(page.locator('#chatLog .attachment')).toHaveCount(0)
    await page.locator('#chatForm button[type="submit"]').click()
    const attachment = page.locator('#chatLog .attachment').first()
    await attachment.getByRole('button', { name: 'Show', exact: true }).click()
    await expect(attachment.locator('pre')).toContainText('<script>window.previewExecuted = true</script>')
    expect(await page.evaluate(() => (window as unknown as { previewExecuted?: boolean }).previewExecuted)).toBeUndefined()
    await expect(attachment.getByRole('link', { name: /Save notes.html/ })).toBeVisible()
  } finally { await context.close() }
})


test('notification defaults and room overrides remain separate after reload', async ({ browser, baseURL }) => {
  const { page, context } = await setup(browser, baseURL!)
  try {
    await openRoomDetails(page)
    await page.locator('#notificationPreferences').evaluate(el => { (el as HTMLDetailsElement).open = true })
    const scope = page.locator('#notificationScope')
    await scope.focus()
    const roomScope = await scope.locator('option').evaluateAll(options =>
      options.map(option => (option as HTMLOptionElement).value).find(value => JSON.parse(value).kind === 'room')!,
    )
    await page.locator('#notificationMode').selectOption('off')
    await scope.selectOption(roomScope)
    await expect(page.locator('#notificationMode')).toHaveValue('inherit')
    await page.locator('#notificationMode').selectOption('all')
    await scope.selectOption(JSON.stringify({ kind: 'default' }))
    await expect(page.locator('#notificationMode')).toHaveValue('off')
    await page.reload()
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await openRoomDetails(page)
    await expect(page.locator('#notificationMode')).toHaveValue('off')
    await page.locator('#notificationPreferences').evaluate(el => { (el as HTMLDetailsElement).open = true })
    await scope.selectOption(roomScope)
    await expect(page.locator('#notificationMode')).toHaveValue('all')
  } finally { await context.close() }
})


test('long paste preserves its tail, encrypts a full document, expands and copies exactly', async ({ browser, baseURL }) => {
  const { page, context } = await setup(browser, baseURL!)
  const full = '  Leading spaces\n' + 'A detailed task 🐱 with newlines.\n'.repeat(2400) + '\nTHE EXACT END  '
  try {
    await page.locator('#chatInput').fill(full)
    await expect(page.locator('#chatInput')).toHaveValue(full)
    await expect(page.locator('#pasteSizeNote')).toContainText('complete encrypted text')
    await page.locator('#chatForm button[type=submit]').click()
    await expect(page.locator('#attachStatus')).toContainText('File uploads are off')
    await expect(page.locator('#chatInput')).toHaveValue(full)
    await routeTestBlossom(context, new URL(baseURL!).origin)
    await allowTestFileStorage(page, new URL(baseURL!).origin)
    await page.locator('#chatForm button[type=submit]').click()
    await expect(page.locator('#chatInput')).toHaveValue('')
    const file = page.locator('#chatLog .attachment').last()
    await expect(file).toBeVisible()
    await file.getByRole('button', { name: 'Show', exact: true }).click()
    await expect(file.locator('pre')).not.toContainText('THE EXACT END')
    await file.getByRole('button', { name: 'Read more', exact: true }).click()
    expect(await file.locator('pre').textContent()).toBe(full)
    // A deterministic clipboard sink also exercises Safari's click path.
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__copied = text } } }))
    await file.getByRole('button', { name: 'Copy full text', exact: true }).click()
    await expect(file.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
    expect(await page.evaluate(() => (window as any).__copied)).toBe(full)
    await file.getByRole('button', { name: 'Collapse', exact: true }).click()
    await expect(file.locator('pre')).not.toContainText('THE EXACT END')
  } finally { await context.close() }
})

test('long text upload failure keeps the whole draft; edits during upload are not sent', async ({ browser, baseURL }) => {
  const { page, context } = await setup(browser, baseURL!)
  const origin = new URL(baseURL!).origin
  const full = 'Original text. '.repeat(200) + 'THE END'
  try {
    await allowTestFileStorage(page, origin)
    await context.route(`${origin}/upload`, route => route.fulfill({ status: 503, body: 'Unavailable' }))
    await page.locator('#chatInput').fill(full)
    await page.locator('#chatForm button[type=submit]').click()
    await expect(page.locator('#chatForm button[type=submit]')).toBeEnabled()
    await expect(page.locator('#chatInput')).toHaveValue(full)
    await context.unroute(`${origin}/upload`)
    await context.route(`${origin}/upload`, async route => {
      await page.locator('#chatInput').fill('Newer edits kept here')
      await route.fulfill({ response: await fetchFromTestBlossom(route, origin) })
    })
    await page.locator('#chatForm button[type=submit]').click()
    await expect(page.locator('#attachStatus')).toContainText('newer edits are kept')
    await expect(page.locator('#chatInput')).toHaveValue('Newer edits kept here')
    await expect(page.locator('#attachStaged .attachChip')).toHaveCount(1)
    await expect(page.locator('#chatLog .attachment')).toHaveCount(0)
  } finally { await context.close() }
})


test('clipboard screenshot waits locally for storage consent, uploads once and stays private until Send', async ({ browser, baseURL }) => {
  const { page, context } = await setup(browser, baseURL!)
  const origin = new URL(baseURL!).origin
  let uploads = 0
  await context.route(`${origin}/upload`, async route => {
    uploads++
    await route.fulfill({ response: await fetchFromTestBlossom(route, origin) })
  })
  await context.route(url => url.origin === origin && url.pathname.startsWith('/blossom/'), async route => {
    await route.fulfill({ response: await fetchFromTestBlossom(route, origin) })
  })
  try {
    await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 900
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#153f52'; ctx.fillRect(0, 0, 1600, 900)
      ctx.fillStyle = '#4ecbff'; ctx.font = '64px sans-serif'; ctx.fillText('Shared reference image', 100, 180)
      const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]!), c => c.charCodeAt(0))
      const clipboard = new DataTransfer()
      clipboard.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }))
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: clipboard })
      document.body.dispatchEvent(event)
    })
    await expect(page.locator('#pendingFileNames')).toContainText('screenshot.png')
    await expect(page.locator('#pendingFileNames')).toContainText('not uploaded')
    expect(uploads).toBe(0)
    await expect(page.locator('#chatForm button[type="submit"]')).toBeDisabled()
    await page.locator('#attachServer').fill(origin)
    await page.locator('#allowSharedFiles').check()
    await page.locator('#saveFileStorage').click()
    expect(uploads).toBe(0)
    await page.locator('#uploadPendingFiles').click()
    await expect(page.locator('#attachCount')).toContainText('(1)')
    expect(uploads).toBe(1)
    await expect(page.locator('#chatLog .attachment')).toHaveCount(0)
    await expect(page.locator('#pendingFileNames')).toBeHidden()
    await page.locator('#chatForm button[type="submit"]').click()
    const attachment = page.locator('#chatLog .attachment').first()
    await attachment.getByRole('button', { name: 'Show', exact: true }).click()
    await expect(attachment.locator('img')).toBeVisible()
    await attachment.getByRole('button', { name: 'Expand screenshot.png' }).click()
    const viewer = page.getByRole('dialog', { name: 'screenshot.png' })
    await expect(viewer).toBeVisible()
    await page.screenshot({ path: '/tmp/kithmoot-attachment-expanded.png' })
    await viewer.getByRole('button', { name: 'Actual size', exact: true }).click()
    await expect(viewer.locator('.attachmentViewerSurface')).toHaveClass(/actualSize/)
    const popped = page.waitForEvent('popup')
    await viewer.getByRole('button', { name: 'Pop out', exact: true }).click()
    const popup = await popped
    await expect(popup.getByRole('img', { name: 'screenshot.png' })).toBeVisible()
    await viewer.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(viewer).toHaveCount(0)
    await expect(attachment.getByRole('button', { name: 'Expand screenshot.png' })).toBeFocused()
    await popup.close()
    await expect(page.locator('#chatLog .lane').first()).toContainText('Encrypted · public relay')
    await page.screenshot({ path: '/tmp/kithmoot-pasted-screenshot.png' })
  } finally { await context.close() }
})
