import { test, expect, type Browser, type BrowserContext } from '@playwright/test'
import { deriveRoom, generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { buildFileEvent } from '../src/attachment.js'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'

async function setup(browser: Browser, base: string, beforeJoin?: (context: BrowserContext, roomId: string, relay: string) => Promise<void>) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  const relay = new URL('/__test-relay', base); relay.protocol = 'wss:'
  await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  const rooms = ['Town hall', 'Project room'].map(name => {
    const secret = generateRoomSecret()
    return { roomId: deriveRoom(secret).roomId, name, link: encodeRoomLink(base, { secret, name, relays: [relay.href], iceUrls: [] }), openedAt: Math.floor(Date.now() / 1000), readAt: 0 }
  })
  await beforeJoin?.(context, rooms[0].roomId, relay.href)
  await context.addInitScript(rooms => {
    for (const room of rooms) localStorage.setItem('kithmoot.room.' + room.roomId, JSON.stringify(room))
  }, rooms)
  const page = await context.newPage()
  await page.goto(rooms[0].link)
  await page.locator('#displayName').fill('Ada')
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  return { context, page, rooms }
}

test('the in-room picker preserves the current conversation and switches directly without a home-screen detour', async ({ browser, baseURL }) => {
  const { context, page, rooms } = await setup(browser, baseURL!)
  try {
    await page.evaluate(() => { (window as any).roomVisitMarker = 'same document' })
    const original = page.url()
    await page.locator('#backToRooms').click()
    await expect(page.getByRole('dialog', { name: 'Switch rooms' })).toBeVisible()
    await expect(page.locator('#roomSwitcherList [aria-current="true"]')).toContainText('Town hall')
    expect(page.url()).toBe(original)
    await page.locator('#roomSearch').fill('project')
    await expect(page.locator('#roomSwitcherList .roomRow')).toHaveCount(1)
    await page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Project room', exact: true }).click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#roomTitle')).toHaveText('Project room')
    expect(new URL(page.url()).hash).toBe(new URL(rooms[1].link).hash)
    await expect(page.locator('#join')).toBeHidden()
    expect(await page.evaluate(() => (window as any).roomVisitMarker)).toBe('same document')
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'false')
    await page.locator('#backToRooms').click()
    await page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Town hall', exact: true }).click()
    await expect(page.locator('#roomTitle')).toHaveText('Town hall')
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.locator('#conversationNav [data-channel=minutes]').click()
    await page.locator('#backToRooms').click()
    await page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Project room', exact: true }).click()
    await expect(page.locator('#roomTitle')).toHaveText('Project room')
    await page.locator('#backToRooms').click()
    await page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Town hall', exact: true }).click()
    await expect(page.locator('#conversationNav [data-channel=minutes]')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#chatLog')).toBeFocused()
  } finally { await context.close() }
})

test('room switches retain separate drafts, selections and staged files without storing their contents', async ({ browser, baseURL }) => {
  const { context, page } = await setup(browser, baseURL!)
  try {
    await page.locator('#chatInput').fill('Keep this unfinished message')
    const original = page.url()
    await page.locator('#backToRooms').click()
    await expect(page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Project room', exact: true })).toBeEnabled()
    await expect(page.locator('#roomSwitcherHome')).toBeDisabled()
    await expect(page.locator('#roomSwitcherNote')).toContainText('drafts')
    const opened = context.waitForEvent('page')
    await page.getByRole('link', { name: 'Open Project room in a new tab' }).click()
    const other = await opened
    await expect(other.locator('#join')).toBeVisible()
    expect(await other.evaluate(() => window.opener === null)).toBe(true)
    await page.locator('#roomSwitcherClose').click()
    await expect(page.locator('#chatInput')).toHaveValue('Keep this unfinished message')
    expect(page.url()).toBe(original)
    await expect(page.locator('#backToRooms')).toBeFocused()
    await page.locator('#backToRooms').click()
    await page.keyboard.press('Escape')
    await expect(page.locator('#roomSwitcher')).not.toBeVisible()
    await expect(page.locator('#chatInput')).toHaveValue('Keep this unfinished message')
    const event = finalizeEvent(buildFileEvent({ url: `https://files.example/${'ab'.repeat(32)}`, sha256: 'ab'.repeat(32), size: 65608 }), generateSecretKey())
    await page.locator('#attachToggle').click()
    await page.locator('#attachEvent').fill(JSON.stringify(event))
    await page.locator('#attachKey').fill('cd'.repeat(32))
    await page.locator('#attachAdd').click()
    await expect(page.locator('#attachStaged .attachChip')).toHaveCount(1)
    await page.locator('#chatInput').evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(2, 7))
    await page.locator('#backToRooms').click()
    await page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Project room', exact: true }).click()
    await expect(page.locator('#roomTitle')).toHaveText('Project room')
    await expect(page.locator('#chatInput')).toHaveValue('')
    await expect(page.locator('#attachStaged .attachChip')).toHaveCount(0)
    await page.locator('#chatInput').fill('A different project draft')
    await page.locator('#backToRooms').click()
    await page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Town hall', exact: true }).click()
    await expect(page.locator('#roomTitle')).toHaveText('Town hall')
    await expect(page.locator('#chatInput')).toHaveValue('Keep this unfinished message')
    await expect.poll(() => page.locator('#chatInput').evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd])).toEqual([2, 7])
    await expect(page.locator('#attachStaged .attachChip')).toHaveCount(1)
    const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))
    expect(stored).not.toContain('Keep this unfinished message')
    expect(stored).not.toContain('A different project draft')
    expect(stored).not.toContain('cd'.repeat(32))
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('Keep this unfinished message')
    await expect(page.locator('#chatLog .attachment')).toHaveCount(1)
    await page.locator('#backToRooms').click()
    await expect(page.locator('#roomSwitcherHome')).toBeDisabled()
    await page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Project room', exact: true }).click()
    await expect(page.locator('#chatInput')).toHaveValue('A different project draft')
    await expect(page.locator('#chatLog')).not.toContainText('Keep this unfinished message')
    await expect(page.locator('#chatLog .attachment')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally { await context.close() }
})

test('browsing rooms keeps a live call; cancelling a switch leaves the microphone on', async ({ browser, baseURL }) => {
  test.skip(test.info().project.name !== 'chromium', 'Chromium supplies the synthetic microphone')
  const { context, page } = await setup(browser, baseURL!)
  try {
    await page.locator('#callToggle').click()
    await page.locator('#toggleMic').click()
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await page.locator('#backToRooms').click()
    await page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Project room', exact: true }).click()
    await page.locator('#actionCancel').click()
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
    await expect(page.locator('#roomTitle')).toHaveText('Town hall')
    await page.screenshot({ path: '/tmp/kithmoot-room-switcher.png' })
    await page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Project room', exact: true }).click()
    await page.locator('#actionConfirm').click()
    await expect(page.locator('#roomTitle')).toHaveText('Project room')
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'false')
  } finally { await context.close() }
})

test('a switch never auto-enters as a guest after an account mismatch or an expired intent', async ({ browser, baseURL }) => {
  const { context, page, rooms } = await setup(browser, baseURL!)
  try {
    for (const intent of [
      { account: 'a'.repeat(64), at: Date.now() },
      { account: null, at: Date.now() - 121_000 },
    ]) {
      await page.evaluate(({ value, link }) => {
        sessionStorage.setItem('kithmoot.room-switch.v1', JSON.stringify(value))
        history.replaceState(null, '', link)
      }, { value: { ...intent, hash: new URL(rooms[1].link).hash }, link: rooms[1].link })
      await page.reload()
      await expect(page.locator('#join')).toBeVisible()
      await expect(page.locator('#roomArea')).toBeHidden()
      expect(await page.evaluate(() => sessionStorage.getItem('kithmoot.room-switch.v1'))).toBeNull()
    }
  } finally { await context.close() }
})


test('a late media permission result cannot start a call after a room switch', async ({ browser, baseURL }) => {
  test.skip(test.info().project.name !== 'chromium', 'Chromium supplies synthetic media')
  const { context, page } = await setup(browser, baseURL!)
  try {
    for (const [index, kind] of ['audio', 'video', 'screen'].entries()) {
      await page.evaluate(kind => {
        const state = window as any
        state.lateTracks = []
        state.releaseMedia = undefined
        const media = navigator.mediaDevices
        const original = media.getUserMedia.bind(media)
        const start = async (constraints?: MediaStreamConstraints) => {
          const stream = kind === 'screen' ? document.createElement('canvas').captureStream() : await original(constraints)
          state.lateTracks = stream.getTracks()
          await new Promise<void>(resolve => { state.releaseMedia = resolve })
          return stream
        }
        if (kind === 'screen') media.getDisplayMedia = start
        else media.getUserMedia = async constraints => {
          media.getUserMedia = original
          return start(constraints)
        }
      }, kind)
      await page.locator('#callToggle').click()
      await page.locator(kind === 'audio' ? '#toggleMic' : kind === 'video' ? '#toggleCamera' : '#toggleScreen').click()
      await expect.poll(() => page.evaluate(() => typeof (window as any).releaseMedia)).toBe('function')
      await page.locator('#backToRooms').click()
      const next = index % 2 === 0 ? 'Project room' : 'Town hall'
      await page.locator('#roomSwitcherList').getByRole('button', { name: `Switch to ${next}`, exact: true }).click()
      await expect(page.locator('#roomTitle')).toHaveText(next)
      await expect(page.locator('#roomArea')).toBeVisible()
      await page.evaluate(() => (window as any).releaseMedia())
      await expect.poll(() => page.evaluate(() => (window as any).lateTracks.every((track: MediaStreamTrack) => track.readyState === 'ended'))).toBe(true)
      for (const id of ['toggleMic', 'toggleCamera', 'toggleScreen']) await expect(page.locator('#' + id)).toHaveAttribute('data-on', 'false')
      await expect(page.locator('#callBay')).toBeHidden()
      await expect(page.locator('#local video')).toHaveCount(0)
    }
  } finally { await context.close() }
})

test('leaving a room removes its roster and messages while its peer can keep talking', async ({ browser, baseURL }) => {
  const { context, page, rooms } = await setup(browser, baseURL!)
  const peerContext = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' })
  try {
    const relay = new URL('/__test-relay', baseURL!); relay.protocol = 'wss:'
    await peerContext.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
    await peerContext.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
    const peer = await peerContext.newPage()
    await peer.goto(rooms[0].link)
    await peer.locator('#displayName').fill('Grace')
    await peer.locator('#join').click()
    await expect(peer.locator('#roomArea')).toBeVisible()
    await peer.locator('#chatInput').fill('Only for Town hall')
    await peer.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('Only for Town hall')
    await page.locator('#chatSearch').click()
    await page.locator('#messageSearchQuery').fill('Only for Town hall')
    await page.locator('#messageSearchResults button').first().click()
    await expect(page.locator('#backToSearch')).toBeVisible()
    await page.locator('#chatLog .msg').first().locator('.messageMore').click()
    await page.locator('#messageActionPanel').getByRole('button', { name: /^Reply to/ }).click()
    await page.locator('#chatInput').fill('A private unfinished reply')
    await page.locator('#backToRooms').click()
    await page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Project room', exact: true }).click()
    await expect(page.locator('#roomTitle')).toHaveText('Project room')
    await expect(page.locator('#chatLog')).not.toContainText('Only for Town hall')
    await expect(page.locator('#roomWho')).not.toContainText('Grace')
    await expect(page.locator('#backToSearch')).toBeHidden()
    await expect(page.locator('#composerContext')).toBeHidden()
    await peer.locator('#chatInput').fill('Grace is still here')
    await peer.locator('#chatInput').press('Enter')
    await page.locator('#chatInput').fill('Only for Project room')
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatLog')).toContainText('Only for Project room')
    await expect(peer.locator('#chatLog')).toContainText('Grace is still here')
    await expect(page.locator('#chatLog')).not.toContainText('Grace is still here')
    await expect(peer.locator('#chatLog')).not.toContainText('Only for Project room')
    await page.locator('#backToRooms').click()
    await page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Town hall', exact: true }).click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#chatInput')).toHaveValue('A private unfinished reply')
    await expect(page.locator('#composerContext')).toContainText('Replying to Grace')
    await expect(page.locator('#chatLog')).toContainText('Grace is still here')
    await expect(page.locator('#chatLog')).not.toContainText('Only for Project room')
  } finally { await peerContext.close(); await context.close() }
})

test('stopping an upload releases room switching and ignores its late result', async ({ browser, baseURL }) => {
  const { context, page } = await setup(browser, baseURL!)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let uploading = false
  await context.route('https://files.example/upload', async route => {
    uploading = true
    const hash = route.request().headers()['x-sha-256']
    const size = route.request().postDataBuffer()!.length
    await held
    await route.fulfill({ status: 201, json: { url: `https://files.example/${hash}`, sha256: hash, size } }).catch(() => {})
  })
  try {
    await page.locator('#chatInput').fill('Keep this while stopping the upload')
    await page.locator('#attachToggle').click()
    await page.locator('#attachServer').fill('https://files.example')
    await page.locator('#attachServer').press('Tab')
    await page.locator('#attachFile').setInputFiles({ name: 'late.txt', mimeType: 'text/plain', buffer: Buffer.from('Room-bound file') })
    await expect.poll(() => uploading).toBe(true)
    await page.locator('#backToRooms').click()
    await expect(page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Project room', exact: true })).toBeDisabled()
    await expect(page.locator('#roomSwitcherNote')).toContainText('stop adding files')
    await page.keyboard.press('Escape')
    await page.locator('#cancelFileWork').click()
    await expect(page.locator('#cancelFileWork')).toBeHidden()
    await page.locator('#backToRooms').click()
    await page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Project room', exact: true }).click()
    await expect(page.locator('#roomTitle')).toHaveText('Project room')
    release()
    await expect(page.locator('#attachStaged .attachChip')).toHaveCount(0)
    await page.locator('#backToRooms').click()
    await page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Town hall', exact: true }).click()
    await expect(page.locator('#chatInput')).toHaveValue('Keep this while stopping the upload')
    await expect(page.locator('#attachStaged .attachChip')).toHaveCount(0)
  } finally { release(); await context.close() }
})


test('a broken saved invitation offers a direct return to the previous room and its draft', async ({ browser, baseURL }) => {
  const { context, page, rooms } = await setup(browser, baseURL!)
  try {
    await page.evaluate(room => {
      localStorage.setItem('kithmoot.room.' + room.roomId, JSON.stringify({ ...room, link: location.origin + '/j/#broken' }))
    }, rooms[1])
    await page.locator('#chatInput').fill('Keep this through a failed invitation')
    await page.locator('#backToRooms').click()
    await page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Project room', exact: true }).click()
    await expect(page.locator('#arrivalTitle')).toHaveText('This invitation is incomplete')
    await expect(page.locator('#returnToPreviousRoom')).toBeVisible()
    await expect(page.locator('#returnToPreviousRoom')).toBeFocused()
    await page.locator('#returnToPreviousRoom').click()
    await expect(page.locator('#roomTitle')).toHaveText('Town hall')
    await expect(page.locator('#chatInput')).toHaveValue('Keep this through a failed invitation')
    await expect(page.locator('#roomArea')).toBeVisible()
  } finally { await context.close() }
})


test('a pending acknowledgement holds switching and releases the open picker when it arrives', async ({ browser, baseURL }) => {
  let acknowledge: (() => void) | undefined
  let sentId: string | undefined
  const { context, page } = await setup(browser, baseURL!, async (context, roomId, relay) => {
    await context.routeWebSocket(relay, ws => {
      const upstream = ws.connectToServer()
      ws.onMessage(raw => {
        const frame = JSON.parse(String(raw))
        if (frame[0] === 'EVENT' && frame[1].kind === 1460 && frame[1].tags.some((tag: string[]) => tag[0] === 'd' && tag[1] === roomId)) sentId ??= frame[1].id
        upstream.send(raw)
      })
      upstream.onMessage(raw => {
        const frame = JSON.parse(String(raw))
        if (frame[0] === 'OK' && frame[1] === sentId) acknowledge = () => ws.send(raw)
        else ws.send(raw)
      })
    })
  })
  try {
    await page.locator('#chatInput').fill('Wait for this acknowledgement')
    await page.locator('#chatInput').press('Enter')
    await expect.poll(() => Boolean(acknowledge)).toBe(true)
    await expect(page.locator('#outbox')).toContainText('Sending…')
    await page.locator('#backToRooms').click()
    const switchButton = page.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Project room', exact: true })
    await expect(switchButton).toBeDisabled()
    acknowledge!()
    await expect(switchButton).toBeEnabled()
    await switchButton.click()
    await expect(page.locator('#roomTitle')).toHaveText('Project room')
    await expect(page.locator('#chatLog')).not.toContainText('Wait for this acknowledgement')
  } finally { await context.close() }
})
