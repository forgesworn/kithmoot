import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { closeCallView, createRoom, joinWithMedia, newDeviceContext, open, openCallView } from './browser.js'

/**
 * The call first, on a wide screen.
 *
 * The owner's complaint: on a 1440 by 900 laptop the call got a small panel
 * under the agents notice and a card of controls with a second Leave, while
 * the chat took a third of the width. The desktop call apps people know put
 * the call in the whole window, one bar of controls along the bottom, and
 * the chat in a panel you open. This measures that: the stage is the height
 * of the window, there is exactly one Leave, the bar is a toolbar a
 * keyboard can walk, and the chat panel remembers whether it was left open
 * and counts what arrived while it was shut.
 *
 * Runs in both Chromium projects: the ordinary build lays the room area out
 * as a column, the installed window as a row of panels, and the call has to
 * come first in both.
 *
 * Screenshots go to CALL_FOCUS_SHOTS when it is set.
 */

test.use({ actionTimeout: 30_000 })

const SHOTS = process.env.CALL_FOCUS_SHOTS ?? resolve('test-results/call-focus')
const STAND_INS: [string, boolean][] = [['Cy', true], ['Di', false], ['Ed', true], ['Flo', false], ['Gus', true], ['Hal', false]]

async function shot(page: Page, name: string): Promise<void> {
  const size = page.viewportSize()!
  await page.mouse.move(0, 0)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${size.width}x${size.height}-${name}.png` })
}

async function joinCall(browser: Browser, baseURL: string, url: string, name: string, contexts: BrowserContext[]): Promise<Page> {
  const context = await newDeviceContext(browser, baseURL)
  contexts.push(context)
  const page = await context.newPage()
  await page.setViewportSize({ width: 1440, height: 900 })
  await open(page, url, name)
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  await expect(page.locator('#callToggle')).toHaveText('Join call', { timeout: 60_000 })
  await page.locator('#callToggle').click()
  await expect(page.locator('#deviceControls')).toBeVisible()
  await page.locator('#toggleCamera').click()
  await expect(page.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')
  return page
}

/** Stand-in tiles past the two real people, shaped the way `render()`
 *  shapes one: the stage lays out what is in `#room`, wherever it came
 *  from. See test/call-layout.spec.ts. */
async function addStandIns(page: Page, people: [string, boolean][]): Promise<void> {
  await page.evaluate(list => {
    const room = document.getElementById('room')!
    for (const [index, [name, camera]] of list.entries()) {
      const box = document.createElement('div')
      box.className = 'participant onCall'
      box.dataset.participant = `stand-in-${name}`
      box.dataset.self = 'false'
      box.dataset.name = name
      const heading = document.createElement('h3')
      const label = document.createElement('span')
      label.className = 'name'
      label.textContent = name
      heading.append(label)
      box.append(heading)
      if (camera) {
        const canvas = document.createElement('canvas')
        canvas.width = 640; canvas.height = 480
        const ctx = canvas.getContext('2d')!
        const hue = (index * 67) % 360
        const draw = () => {
          ctx.fillStyle = `hsl(${hue} 35% 30%)`; ctx.fillRect(0, 0, 640, 480)
          ctx.fillStyle = `hsl(${hue} 45% 70%)`; ctx.beginPath(); ctx.arc(320, 260, 110, 0, Math.PI * 2); ctx.fill()
        }
        draw(); setInterval(draw, 500)
        const video = document.createElement('video')
        video.muted = true; video.autoplay = true; video.playsInline = true
        video.srcObject = canvas.captureStream(2)
        const media = document.createElement('div')
        media.className = 'media'
        media.append(video)
        box.append(media)
      }
      room.append(box)
    }
  }, people)
}

async function visibleTiles(page: Page): Promise<number> {
  return page.locator('#room[data-layout] > .participant:not([data-layout-hidden])').count()
}

/** Everything the layout promises, at the window size the page has now. */
async function expectCallFirst(page: Page, label: string): Promise<void> {
  const viewport = page.viewportSize()!
  await expect(page.locator('html'), `${label}: the call should come first`).toHaveAttribute('data-call-first', '')
  await page.waitForTimeout(300)

  // The stage runs from under the room bar to the bottom of the window.
  const stage = (await page.locator('#callStage').boundingBox())!
  const bar = (await page.locator('#roomArea > .roomBar').boundingBox())!
  expect(stage.y, `${label}: the stage starts ${stage.y.toFixed(0)}px down, under more than the room bar`).toBeLessThanOrEqual(bar.y + bar.height + 24)
  expect(stage.y + stage.height, `${label}: the stage stops ${(viewport.height - stage.y - stage.height).toFixed(0)}px short of the bottom`).toBeGreaterThanOrEqual(viewport.height - 48)
  expect(stage.y + stage.height, `${label}: the stage runs off the bottom of the window`).toBeLessThanOrEqual(viewport.height + 1)
  const room = (await page.locator('#room').boundingBox())!
  expect(room.height, `${label}: the pictures get ${room.height.toFixed(0)}px of a ${viewport.height}px window`).toBeGreaterThanOrEqual(viewport.height * 0.6)

  // Nothing above the stage but the room bar: no agents notice, no card.
  await expect(page.locator('#agentActivity'), `${label}: the agents notice should step aside`).toBeHidden()

  // Exactly one way off the call, and it is in the bar.
  const toolbar = page.getByRole('toolbar', { name: 'Call controls' })
  await expect(toolbar).toBeVisible()
  const leaves = page.getByRole('button', { name: /^leave/i })
  const shown = []
  for (const button of await leaves.all()) if (await button.isVisible()) shown.push(await button.getAttribute('id'))
  expect(shown, `${label}: visible Leave buttons`).toEqual(['leaveCall'])
  await expect(toolbar.locator('#leaveCall')).toBeVisible()

  // The bar is along the bottom of the stage, one row, every target 44px.
  const barBox = (await page.locator('#callBay').boundingBox())!
  expect(barBox.y + barBox.height, `${label}: the bar is not at the bottom of the stage`).toBeGreaterThanOrEqual(stage.y + stage.height - 2)
  // Two lines at most: the status line may sit over the buttons on a
  // narrower stage, but the buttons themselves are one row.
  expect(barBox.height, `${label}: the bar is ${barBox.height.toFixed(0)}px tall`).toBeLessThanOrEqual(100)
  const rows = new Set<number>()
  for (const id of ['toggleMic', 'toggleCamera', 'toggleScreen', 'leaveCall', 'callChatToggle', 'callFullscreen']) {
    const box = (await page.locator(`#${id}`).boundingBox())!
    expect(box.height, `${label}: #${id} is ${box.height}px tall`).toBeGreaterThanOrEqual(44)
    expect(box.y, `${label}: #${id} is not in the bar`).toBeGreaterThanOrEqual(barBox.y - 1)
    rows.add(Math.round(box.y / 4))
  }
  expect(rows.size, `${label}: the bar's buttons wrapped onto ${rows.size} rows`).toBe(1)
  for (const summary of ['#callViewMenu > summary', '#callExtras > summary']) {
    const box = (await page.locator(summary).boundingBox())!
    expect(box.height, `${label}: ${summary} is ${box.height}px tall`).toBeGreaterThanOrEqual(44)
  }
  // What the microphone is doing, still said.
  await expect(page.locator('#micIndicator')).toBeVisible()
}

test('the call has the window: a full-height stage, one bar, one Leave', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved')
  test.setTimeout(300_000)
  await mkdir(SHOTS, { recursive: true })
  const contexts: BrowserContext[] = []
  try {
    const context = await newDeviceContext(browser, baseURL!)
    contexts.push(context)
    const ada = await context.newPage()
    await ada.setViewportSize({ width: 1440, height: 900 })
    const url = await createRoom(ada, baseURL!)
    await joinWithMedia(ada, url, 'Ada')
    const bob = await joinCall(browser, baseURL!, url, 'Bob', contexts)
    await expect.poll(() => visibleTiles(ada), { timeout: 90_000 }).toBe(2)

    // Two: a FaceTime call, at both window sizes, chat open and shut.
    for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
      await ada.setViewportSize(size)
      await expect(ada.locator('#callChatToggle')).toHaveAttribute('aria-expanded', 'true')
      await shot(ada, '1-one-to-one-chat-open')
      await expectCallFirst(ada, `${size.width}x${size.height}, chat open`)
      await expect(ada.locator('#chatInput')).toBeVisible()
    }
    await ada.locator('#callChatToggle').click()
    for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
      await ada.setViewportSize(size)
      await expect(ada.locator('#callChatToggle')).toHaveAttribute('aria-expanded', 'false')
      await shot(ada, '1-one-to-one-chat-closed')
      await expectCallFirst(ada, `${size.width}x${size.height}, chat closed`)
      await expect(ada.locator('#chatInput')).toBeHidden()
    }

    // The bar from the keyboard: arrows walk it and wrap, Home and End go
    // to its ends, and the focus ring is there to see.
    await ada.locator('#toggleMic').focus()
    await ada.keyboard.press('ArrowRight')
    await expect(ada.locator('#toggleCamera')).toBeFocused()
    await ada.keyboard.press('ArrowLeft')
    await ada.keyboard.press('ArrowLeft')
    await expect(ada.locator('#toggleMic')).not.toBeFocused()
    await ada.keyboard.press('Home')
    await expect(ada.locator('#toggleMic')).toBeFocused()
    const ring = await ada.locator('#toggleMic').evaluate(el => getComputedStyle(el).outlineStyle)
    expect(ring, 'a focused bar button should show its focus').not.toBe('none')
    await ada.keyboard.press('End')
    const last = await ada.evaluate(() => document.activeElement?.id)
    expect(['callFullscreen', 'callChatToggle']).toContain(last)

    // The view switcher is behind View, and choosing puts the menu away.
    await openCallView(ada)
    await ada.locator('.callViewOptions > summary').click()
    await shot(ada, 'view-menu-open')
    await ada.locator('.callViewOptions > summary').click()
    await ada.locator('#callView').getByRole('button', { name: 'Speaker', exact: true }).click()
    await expect(ada.locator('#callViewMenu')).not.toHaveAttribute('open', '')
    await expect(ada.locator('#room')).toHaveAttribute('data-layout', 'solo')
    await openCallView(ada)
    await ada.locator('#callView').getByRole('button', { name: 'Gallery', exact: true }).click()
    await closeCallView(ada)

    // Full screen: the room area, and back.
    if (await ada.locator('#callFullscreen').isVisible()) {
      await ada.locator('#callFullscreen').click()
      await expect(ada.locator('#callFullscreen')).toHaveAttribute('aria-pressed', 'true')
      expect(await ada.evaluate(() => document.fullscreenElement?.id)).toBe('roomArea')
      await ada.locator('#callFullscreen').click()
      await expect(ada.locator('#callFullscreen')).toHaveAttribute('aria-pressed', 'false')
    }

    // Eight, then a share, at both sizes and in both themes.
    await ada.locator('#callChatToggle').click()
    await addStandIns(ada, STAND_INS)
    await expect.poll(() => visibleTiles(ada), { timeout: 60_000 }).toBe(8)
    for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
      await ada.setViewportSize(size)
      await shot(ada, '8-gallery')
      await expectCallFirst(ada, `${size.width}x${size.height}, eight`)
    }
    await bob.locator('#toggleScreen').click()
    await expect(bob.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
    await expect(ada.locator('#room')).toHaveAttribute('data-layout', 'share', { timeout: 60_000 })
    for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
      await ada.setViewportSize(size)
      await shot(ada, '8-share')
      await expectCallFirst(ada, `${size.width}x${size.height}, a share`)
      await ada.emulateMedia({ colorScheme: 'dark' })
      await shot(ada, '8-share-dark')
      await ada.locator('#callChatToggle').click()
      await shot(ada, '8-share-dark-chat-closed')
      await ada.locator('#callChatToggle').click()
      await ada.emulateMedia({ colorScheme: 'light' })
    }
    // Bob's own view of his share, with the settings open over the stage.
    await bob.locator('#callExtras > summary').click()
    await expect(bob.locator('#callExtrasContent')).toBeVisible()
    await shot(bob, 'sharer-settings-open')
    await bob.keyboard.press('Escape')
    await expect(bob.locator('#callExtras')).not.toHaveAttribute('open', '')
    await expect(bob.locator('#callExtras > summary')).toBeFocused()
  } finally {
    for (const context of contexts) await context.close()
  }
})

test('the chat panel opens from the bar, counts what arrived while shut, and is remembered', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved')
  test.setTimeout(300_000)
  await mkdir(SHOTS, { recursive: true })
  const contexts: BrowserContext[] = []
  try {
    const context = await newDeviceContext(browser, baseURL!)
    contexts.push(context)
    const ada = await context.newPage()
    await ada.setViewportSize({ width: 1440, height: 900 })
    const url = await createRoom(ada, baseURL!)
    await joinWithMedia(ada, url, 'Ada')
    const bob = await joinCall(browser, baseURL!, url, 'Bob', contexts)
    await expect(ada.locator('html')).toHaveAttribute('data-call-first', '', { timeout: 60_000 })

    // Open by default from 1280px, shut below, until this device says.
    await expect(bob.locator('#callChatToggle')).toHaveAttribute('aria-expanded', 'true')
    await bob.setViewportSize({ width: 1200, height: 800 })
    await expect(bob.locator('#callChatToggle')).toHaveAttribute('aria-expanded', 'false')
    await bob.setViewportSize({ width: 1440, height: 900 })
    await expect(bob.locator('#callChatToggle')).toHaveAttribute('aria-expanded', 'true')

    // Shut, and the stage takes the width back.
    const toggle = ada.locator('#callChatToggle')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const openWidth = (await ada.locator('#callStage').boundingBox())!.width
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(async () => (await ada.locator('#callStage').boundingBox())!.width).toBeGreaterThan(openWidth + 200)
    await expect(ada.locator('#chatInput')).toBeHidden()
    expect(await ada.evaluate(() => localStorage.getItem('kithmoot.call-chat-panel'))).toBe('closed')

    // Bob says two things; Ada's Chat button counts them, and says so.
    const badge = toggle.locator('.callChatUnread')
    await expect(badge).toBeHidden()
    for (const text of ['Can you see my slides?', 'Second slide now']) {
      await bob.locator('#chatInput').fill(text)
      await bob.locator('#chatInput').press('Enter')
    }
    await expect(badge).toHaveText('2', { timeout: 60_000 })
    await expect(toggle).toHaveAttribute('aria-label', 'Chat, 2 unread')
    await expect(ada.locator('#callChatAnnounce')).toHaveText('2 new messages in the chat')
    await expect(ada.locator('#callChatAnnounce')).toHaveAttribute('aria-live', 'polite')
    await shot(ada, 'chat-closed-unread')

    // Opening reads them, and puts the cursor in the box to answer.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(badge).toBeHidden()
    await expect(toggle).toHaveAttribute('aria-label', 'Chat')
    await expect(ada.locator('#chatInput')).toBeFocused()
    await expect(ada.locator('#chatLog')).toContainText('Second slide now')
    // Escape from the conversation goes back to the bar.
    await ada.keyboard.press('Escape')
    await expect(toggle).toBeFocused()

    // Shut again, and still shut after a reload and a rejoin.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await ada.reload()
    await ada.locator('#displayName').fill('Ada')
    await ada.locator('#join').click()
    await expect(ada.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    await expect(ada.locator('#callToggle')).toHaveText('Join call', { timeout: 60_000 })
    await ada.locator('#callToggle').click()
    await ada.locator('#toggleCamera').click()
    await expect(ada.locator('html')).toHaveAttribute('data-call-first', '', { timeout: 60_000 })
    await expect(ada.locator('#callChatToggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(ada.locator('#chatInput')).toBeHidden()

    // Leaving hands the room back: the conversation, and the room bar's
    // own call control.
    await ada.locator('#leaveCall').click()
    await expect(ada.locator('html')).not.toHaveAttribute('data-call-first', '')
    await expect(ada.locator('#callToggle')).toBeVisible()
    await expect(ada.locator('#chatInput')).toBeVisible()
  } finally {
    for (const context of contexts) await context.close()
  }
})
