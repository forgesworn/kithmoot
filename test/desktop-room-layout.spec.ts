import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { generateSecretKey } from 'nostr-tools/pure'
import { RoomAgent } from '../src/agent.js'
import { localIdentity } from '../src/identity.js'
import { SYNTHETIC_MIC, createRoom, fakeMicMakesSound, inbound, joinWithMedia, newDeviceContext, open, openCall, remoteAudioCount, turnOnMedia, TEST_RELAY_WS } from './browser.js'

/**
 * Two screens on the stage, faces beside them, and a chat that slides.
 *
 * Two people each sharing a camera and a screen. This used to be "person
 * beside their screen": each sharer a row, their camera at the left of it.
 * The call stage replaced that in September 2026 (app/src/call-stage.ts):
 * shares go on a stage of their own and every face is one box in a strip.
 * What the owner asked for the first time round still holds, and is what
 * this measures:
 *
 *  - Every camera is the same size as every other camera.
 *  - A share's box is the shape of the picture in it: no black bands.
 *  - Nothing runs off the bottom of the window, at either of two window
 *    sizes a person actually uses, and nothing sits on a share.
 *  - The chat is a drawer, and it starts open, because a closed default
 *    silently takes chat away from everybody upgrading into this.
 *
 * Runs in the `chromium-desktop` project, against the VITE_DESKTOP build
 * served on 4174 - `html[data-desktop]` gates the drawer and the fixed
 * window height this whole layout divides up.
 */

const SHOTS = process.env.DESKTOP_LAYOUT_SHOTS ?? resolve('test-results/desktop-room-layout')

interface Box { x: number; y: number; width: number; height: number }

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('element has no box')
  return box
}

/** The share's picture, as the browser decoded it, so the test can work out
 *  how much of the element's box is actually picture and how much is band. */
async function naturalAspect(share: Locator): Promise<number> {
  return share.evaluate(el => {
    const video = el as HTMLVideoElement
    return video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 0
  })
}

/**
 * Everything the owner asked for, measured at one window size.
 *
 * Split out because "both people fit" is the assertion most likely to be
 * true at the size somebody happened to develop at and false everywhere
 * else, and asserting it once proves nothing.
 */
async function checkRoom(page: Page, label: string): Promise<void> {
  const viewport = page.viewportSize()!
  const shares = page.locator('#room video.screenPreview')
  await expect(shares, `${label}: both shares should be on screen`).toHaveCount(2, { timeout: 60_000 })
  await expect(page.locator('#room'), `${label}: two shares should put the room in Share view`).toHaveAttribute('data-layout', 'share')

  // Settle: the stage lays out on the next frame after a change.
  await expect.poll(async () => {
    const boxes = await shares.evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().width)))
    return boxes.join(',')
  }, { timeout: 30_000, message: `${label}: share boxes never settled` }).not.toBe('')
  await page.waitForTimeout(400)

  const cameras: Box[] = []
  for (const camera of await page.locator('#room > .participant:not([data-layout-hidden]) > .media > video:not(.screenPreview)').all()) {
    await expect(camera, `${label}: a camera should be visible`).toBeVisible()
    cameras.push(await boxOf(camera))
  }
  expect(cameras.length, `${label}: both cameras should be on screen`).toBe(2)
  const faces: Box[] = []
  for (const tile of await page.locator('#room > .participant:not([data-layout-hidden])').all()) faces.push(await boxOf(tile))

  const screens: Box[] = []
  for (let i = 0; i < 2; i++) {
    const share = shares.nth(i)
    await expect(share, `${label}: share ${i} should be visible`).toBeVisible()
    const scr = await boxOf(share)
    screens.push(scr)
    // The screen is the thing being read; the camera is context beside it.
    expect(scr.width, `${label}: share ${i} is not wider than a camera`).toBeGreaterThan(cameras[0].width)

    // No bands. The element's box has to be the shape of the picture, or
    // `object-fit: contain` pillarboxes or letterboxes the difference.
    const aspect = await naturalAspect(share)
    expect(aspect, `${label}: share ${i} never decoded a picture`).toBeGreaterThan(0)
    const drawnWidth = Math.min(scr.width, scr.height * aspect)
    const drawnHeight = Math.min(scr.height, scr.width / aspect)
    const filled = (drawnWidth * drawnHeight) / (scr.width * scr.height)
    expect(filled, `${label}: share ${i} is mostly empty box - ${scr.width.toFixed(0)}x${scr.height.toFixed(0)} around a ${aspect.toFixed(2)} picture`).toBeGreaterThanOrEqual(0.8)
    expect((scr.height - drawnHeight) / 2, `${label}: share ${i} has letterbox bands`).toBeLessThanOrEqual(scr.height * 0.1)
    expect((scr.width - drawnWidth) / 2, `${label}: share ${i} has pillarbox bands`).toBeLessThanOrEqual(scr.width * 0.1)

    // Nothing on it.
    for (const [j, face] of faces.entries()) {
      const overlapX = Math.min(face.x + face.width, scr.x + scr.width) - Math.max(face.x, scr.x)
      const overlapY = Math.min(face.y + face.height, scr.y + scr.height) - Math.max(face.y, scr.y)
      expect(overlapX > 1 && overlapY > 1, `${label}: tile ${j} sits on share ${i}`).toBe(false)
    }
  }
  const [s0, s1] = screens
  const overlapX = Math.min(s0.x + s0.width, s1.x + s1.width) - Math.max(s0.x, s1.x)
  const overlapY = Math.min(s0.y + s0.height, s1.y + s1.height) - Math.max(s0.y, s1.y)
  expect(overlapX > 1 && overlapY > 1, `${label}: the two shares overlap`).toBe(false)

  // Two faces the same size as each other, whoever is sharing what.
  expect(Math.abs(cameras[0].width - cameras[1].width), `${label}: camera tiles are not the same width`).toBeLessThanOrEqual(2)
  expect(Math.abs(cameras[0].height - cameras[1].height), `${label}: camera tiles are not the same height`).toBeLessThanOrEqual(2)
  for (const [i, cam] of cameras.entries()) {
    expect(cam.width, `${label}: camera ${i} is ${cam.width.toFixed(0)}px wide, too small to read a face`).toBeGreaterThanOrEqual(160)
  }

  // Everything on the screen, measured against the stage's own visible
  // bottom edge as well as the window's, because the stage scrolls. A box
  // can sit inside an 880px window and still be clipped off the bottom of a
  // 741px stage, which is exactly what happened here first time round.
  const stage = await page.locator('#callStage').evaluate(el => {
    const box = el.getBoundingClientRect()
    return { bottom: box.bottom, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
  })
  expect(stage.scrollHeight, `${label}: the call stage has to scroll to show the room, so something is off the bottom of it`).toBeLessThanOrEqual(stage.clientHeight + 2)
  const floor = Math.min(viewport.height, stage.bottom)
  for (const [i, box] of [...faces, ...screens].entries()) {
    expect(box.y, `${label}: box ${i} starts above the window`).toBeGreaterThanOrEqual(-1)
    expect(box.y + box.height, `${label}: box ${i} runs ${(box.y + box.height - floor).toFixed(0)}px past the visible bottom of a ${viewport.width}x${viewport.height} window`).toBeLessThanOrEqual(floor + 1)
  }
}

test('two people each share a screen: both on the stage, faces one size beside them, chat on a drawer', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved - run the chromium-desktop project against a VITE_DESKTOP=true build')
  await mkdir(SHOTS, { recursive: true })

  const a = await newDeviceContext(browser, baseURL!)
  const b = await newDeviceContext(browser, baseURL!)
  try {
    const pageA = await a.newPage()
    const pageB = await b.newPage()
    await pageA.setViewportSize({ width: 1320, height: 880 })
    await pageB.setViewportSize({ width: 1320, height: 880 })

    const link = await createRoom(pageA, baseURL!)
    await joinWithMedia(pageA, link, 'Ada')
    await open(pageB, link, 'Bob')
    await pageB.locator('#join').click()
    await expect(pageB.locator('#roomArea')).toBeVisible()
    await turnOnMedia(pageB)

    await openCall(pageA)
    await openCall(pageB)
    await pageA.locator('#toggleScreen').click()
    await expect(pageA.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')
    await pageB.locator('#toggleScreen').click()
    await expect(pageB.locator('#toggleScreen')).toHaveAttribute('data-on', 'true')

    // The drawer, before anything touches it: open, because chat has always
    // been there on desktop and a closed default would quietly remove it.
    // On a call with pictures the call comes first (app/src/call-focus.ts),
    // and the drawer's control is the Chat button in the call's own bar.
    await expect(pageA.locator('html')).toHaveAttribute('data-call-first', '')
    await expect(pageA.locator('#chatDrawerToggle')).toBeHidden()
    const toggle = pageA.locator('#callChatToggle')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(pageA.locator('html')).toHaveAttribute('data-call-chat', 'open')

    await checkRoom(pageA, '1320x880')
    await pageA.screenshot({ path: `${SHOTS}/1320x880.png` })

    await pageA.setViewportSize({ width: 1600, height: 1000 })
    await checkRoom(pageA, '1600x1000')
    await pageA.screenshot({ path: `${SHOTS}/1600x1000.png` })

    // Closing the drawer gives the room the width back rather than floating
    // over it, and opening it takes that width again.
    const stage = pageA.locator('#callStage')
    const openWidth = (await boxOf(stage)).width
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(pageA.locator('html')).toHaveAttribute('data-call-chat', 'closed')
    await expect.poll(async () => (await boxOf(stage)).width).toBeGreaterThan(openWidth + 20)
    await checkRoom(pageA, '1600x1000, drawer closed')
    await pageA.screenshot({ path: `${SHOTS}/1600x1000-drawer-closed.png` })

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(async () => (await boxOf(stage)).width).toBeLessThanOrEqual(openWidth + 2)
  } finally {
    await a.close()
    await b.close()
  }
})

/**
 * The second pass, from the owner using the installed window:
 *
 *  - "if work and chat are enabled, chat is too small and is unusable. yet
 *    there's loads of free space in call (we aren't running a call)."
 *  - "if I start a call, I expect the button to change to leave call, if I
 *    click leave call today, there's a flick where you can see I'm asked to
 *    join which is weird!"
 *  - "the projects on the left hand side we should be able to show/hide."
 *
 * Nobody is on camera in any of this, which is the point: every one of
 * these failures is about what the panels do with space when there is
 * nothing to put in them, and about what the controls say while that is
 * true. None of it needs a picture, and a spec that needed one would be
 * measuring the wrong thing.
 */

/** Every window the owner named, and then the width at which Shared Work,
 *  the conversation and the call pane first cannot all have what they want
 *  - which is the one where the order of precedence is actually tested. */
const SIZES = [
  { width: 1320, height: 880 },
  { width: 1100, height: 700 },
  { width: 1600, height: 1000 },
  { width: 1280, height: 860 },
]

/** Mirrors CHAT_MIN_WIDTH_PX and CHAT_MIN_HEIGHT_FRACTION in
 *  app/src/desktop-panes.ts. Written out rather than imported so that a
 *  change to the constants has to be made here too, in front of somebody. */
const CHAT_MIN = 360
const CHAT_MIN_HEIGHT = 0.6

async function checkChatIsUsable(page: Page, label: string): Promise<void> {
  const viewport = page.viewportSize()!
  const chat = await boxOf(page.locator('#chatDrawer'))
  expect(chat.width, `${label}: the conversation is ${chat.width.toFixed(0)}px wide, below the ${CHAT_MIN}px floor`).toBeGreaterThanOrEqual(CHAT_MIN - 1)
  expect(chat.height, `${label}: the conversation is ${chat.height.toFixed(0)}px tall, below ${(CHAT_MIN_HEIGHT * 100).toFixed(0)}% of a ${viewport.height}px window`)
    .toBeGreaterThanOrEqual(viewport.height * CHAT_MIN_HEIGHT - 1)
  // And on the screen, not a box of the right size somewhere off the edge.
  expect(chat.x, `${label}: the conversation starts off the left of the window`).toBeGreaterThanOrEqual(-1)
  expect(chat.x + chat.width, `${label}: the conversation runs past the right of the window`).toBeLessThanOrEqual(viewport.width + 1)
}

test('an empty call pane costs nothing, the call control says what it does, and the rail folds away', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved - run the chromium-desktop project against a VITE_DESKTOP=true build')
  await mkdir(SHOTS, { recursive: true })

  const a = await newDeviceContext(browser, baseURL!)
  const b = await newDeviceContext(browser, baseURL!)
  try {
    const page = await a.newPage()
    await page.setViewportSize({ width: 1320, height: 880 })
    const link = await createRoom(page, baseURL!)
    await open(page, link, 'Ada')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()

    // Nobody on a call: one strip, and a control that offers to start one.
    const strip = page.locator('#callStrip')
    const toggle = page.locator('#callToggle')
    await expect(page.locator('html')).toHaveAttribute('data-call-pane', 'resting')
    await expect(strip).toBeVisible()
    await expect(toggle).toHaveText('Start call')
    await expect(page.locator('#callBanner')).toBeHidden()
    const stripBox = await boxOf(strip)
    expect(stripBox.height, `the resting call strip is ${stripBox.height.toFixed(0)}px tall`).toBeLessThan(80)
    const stageBox = await boxOf(page.locator('#callStage'))
    expect(stageBox.height, `the resting call pane is ${stageBox.height.toFixed(0)}px tall around a ${stripBox.height.toFixed(0)}px strip`).toBeLessThan(120)

    // Work and Chat both open, at every window size. This is the case the
    // owner called unusable: 32% of what Shared Work left was 197px.
    await page.locator('#openAssignments').click()
    await expect(page.locator('#assignmentPanel')).toBeVisible()
    for (const size of SIZES) {
      await page.setViewportSize(size)
      await page.waitForTimeout(150)
      await checkChatIsUsable(page, `${size.width}x${size.height}, no call, Work and Chat`)
      if (size.width >= 1280) {
        const work = await boxOf(page.locator('#assignmentPanel'))
        expect(work.width, `${size.width}x${size.height}: Shared Work narrowed below its own floor`).toBeGreaterThanOrEqual(319)
        expect(work.width, `${size.width}x${size.height}: Shared Work took more than it asked for`).toBeLessThanOrEqual(449)
      }
      if (SIZES.indexOf(size) < 3) await page.screenshot({ path: `${SHOTS}/no-call-work-chat-${size.width}x${size.height}.png` })
    }

    // Chat alone: the same floors, with the whole window to spend.
    await page.locator('#assignmentClose').click()
    await expect(page.locator('#assignmentPanel')).toBeHidden()
    for (const size of SIZES.slice(0, 3)) {
      await page.setViewportSize(size)
      await page.waitForTimeout(150)
      await checkChatIsUsable(page, `${size.width}x${size.height}, no call, Chat only`)
      await page.screenshot({ path: `${SHOTS}/no-call-chat-${size.width}x${size.height}.png` })
    }

    // Start a call from the room bar. The same button becomes the way out.
    await page.setViewportSize({ width: 1320, height: 880 })
    await toggle.click()
    await expect(toggle).toHaveText('Leave call')
    // On the call with nothing switched on, so the pane is the controls
    // strip rather than an empty video grid - see `CallPane`. The resting
    // strip gives way to it.
    await expect(page.locator('html')).toHaveAttribute('data-call-pane', 'controls')
    await expect(page.locator('#deviceControls')).toBeVisible()
    await expect(strip).toBeHidden()
    for (const size of SIZES.slice(0, 3)) {
      await page.setViewportSize(size)
      await page.waitForTimeout(150)
      await checkChatIsUsable(page, `${size.width}x${size.height}, on a call, Chat`)
      await page.screenshot({ path: `${SHOTS}/on-call-chat-${size.width}x${size.height}.png` })
    }
    await page.setViewportSize({ width: 1320, height: 880 })

    // The flicker, recorded rather than looked for: every change to the
    // join door's `hidden` through the whole of Leave. It was never once
    // shown - see app/src/call-stance.ts for why it used to be.
    await page.evaluate(() => {
      const seen: boolean[] = []
      const banner = document.getElementById('callBanner') as HTMLElement
      seen.push(banner.hidden)
      const observer = new MutationObserver(records => {
        for (const record of records) if (record.attributeName === 'hidden') seen.push((record.target as HTMLElement).hidden)
      })
      observer.observe(banner, { attributes: true, attributeFilter: ['hidden'] })
      Object.assign(window as unknown as Record<string, unknown>, { joinDoorSeen: seen, stopJoinDoor: () => observer.disconnect() })
    })
    await toggle.click()
    await expect(toggle).toHaveText('Start call')
    await expect(page.locator('html')).toHaveAttribute('data-call-pane', 'resting')
    await expect(page.locator('#callBay')).toBeHidden()
    await page.waitForTimeout(600)
    const door = await page.evaluate(() => {
      const w = window as unknown as { joinDoorSeen: boolean[]; stopJoinDoor: () => void }
      w.stopJoinDoor()
      return w.joinDoorSeen
    })
    expect(door.length, 'the join door was never observed at all, so this proves nothing').toBeGreaterThan(0)
    expect(door.every(hidden => hidden), `the join door was painted during Leave: ${JSON.stringify(door)}`).toBe(true)

    // Somebody else starts one, and the same control offers to join it.
    const other = await b.newPage()
    await other.setViewportSize({ width: 1320, height: 880 })
    await open(other, link, 'Bob')
    await other.locator('#join').click()
    await expect(other.locator('#roomArea')).toBeVisible()
    await other.locator('#callToggle').click()
    await expect(other.locator('#callToggle')).toHaveText('Leave call')

    await expect(toggle).toHaveText('Join call', { timeout: 60_000 })
    await expect(page.locator('#callBanner')).toBeVisible()
    // Bob is on a call with nothing switched on, so there is nothing to
    // show: the pane stays a strip and the banner carries the whole offer.
    await expect(page.locator('html')).toHaveAttribute('data-call-pane', 'resting')
    await toggle.click()
    await expect(toggle).toHaveText('Leave call')
    // Still nobody on camera, so joining swaps one strip for the other.
    await expect(page.locator('html')).toHaveAttribute('data-call-pane', 'controls')
    await expect(page.locator('#callBanner')).toBeHidden()
    // Off it again with Bob still on it: the door is the honest answer now,
    // so it comes back rather than being suppressed for ever.
    await toggle.click()
    await expect(toggle).toHaveText('Join call', { timeout: 60_000 })

    // The rail. Collapsed it keeps its control, the room takes the width,
    // and this device remembers.
    const railToggle = page.locator('#projectsRailToggle')
    await expect(railToggle).toBeVisible()
    await expect(railToggle).toHaveAttribute('aria-expanded', 'true')
    const roomBefore = (await boxOf(page.locator('#roomArea'))).width
    const railBefore = (await boxOf(page.locator('#workspaceNav'))).width
    // Keyboard-reachable, and worked from the keyboard.
    await railToggle.focus()
    await expect(railToggle).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('html')).toHaveAttribute('data-rail', 'collapsed')
    await expect(railToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('#workspaceRailBody')).toBeHidden()
    await expect(railToggle).toBeVisible()
    const railAfter = (await boxOf(page.locator('#workspaceNav'))).width
    expect(railAfter, `the collapsed rail is ${railAfter.toFixed(0)}px against ${railBefore.toFixed(0)}px open`).toBeLessThan(railBefore - 60)
    await expect.poll(async () => (await boxOf(page.locator('#roomArea'))).width).toBeGreaterThan(roomBefore + 60)
    await checkChatIsUsable(page, '1320x880, rail collapsed')
    await page.screenshot({ path: `${SHOTS}/rail-collapsed-1320x880.png` })

    // Remembered on this device, across a reload, and reversible. A visitor
    // with no account is asked for their name again on the way back in,
    // which is the room's business and not the rail's: the rail's own state
    // is already restored by then.
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-rail', 'collapsed', { timeout: 60_000 })
    await page.locator('#displayName').fill('Ada')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('html')).toHaveAttribute('data-rail', 'collapsed')
    await page.locator('#projectsRailToggle').click()
    await expect(page.locator('html')).toHaveAttribute('data-rail', 'open')
    await expect(page.locator('#workspaceRailBody')).toBeVisible()
  } finally {
    await a.close()
    await b.close()
  }
})

/**
 * The drawer had one job too many.
 *
 * Reported from the installed window at 1744x850 with Call off, Work off
 * and Chat on: the conversation was still the ~300px right-hand drawer,
 * about 1150px of the window was empty, and messages wrapped at three or
 * four words a line. The same room in a 986px window was fine, because
 * below the drawer's breakpoint the conversation is simply the page.
 *
 * So a drawer is a drawer only while something is showing beside it. With
 * nothing beside it, it is the main column and fills the available room.
 * Individual messages retain their reading-width limit.
 */

/** How many lines a piece of text actually occupies, which is the thing
 *  being complained about and cannot be inferred from a width. */
async function lineCount(text: Locator): Promise<number> {
  return text.evaluate(el => {
    const range = document.createRange()
    range.selectNodeContents(el)
    return range.getClientRects().length
  })
}

/** Twenty words. Long enough that a strip wraps it to five lines or more
 *  and a readable column does not. */
const TWENTY_WORDS = 'Please could somebody check the probe failure before the workshop on Thursday because the results need writing up first'

test('with nothing beside it the conversation is the main column, not a strip', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved - run the chromium-desktop project against a VITE_DESKTOP=true build')
  await mkdir(SHOTS, { recursive: true })

  const a = await newDeviceContext(browser, baseURL!)
  let writer: RoomAgent | undefined
  try {
    const page = await a.newPage()
    await page.setViewportSize({ width: 1744, height: 850 })
    const link = await createRoom(page, baseURL!)
    await open(page, link, 'Ada')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()

    // Enough conversation that the log genuinely scrolls: a scroll position
    // that is always zero proves nothing about keeping one.
    writer = await RoomAgent.join({ link, identity: localIdentity(generateSecretKey()), relays: [TEST_RELAY_WS], name: 'Rowan' })
    for (let i = 1; i <= 24; i++) await writer.chat.send(`Note ${i}: ${TWENTY_WORDS}`)
    const rows = page.locator('#chatLog .msg')
    await expect(rows).toHaveCount(24, { timeout: 60_000 })

    const log = page.locator('#chatLog')
    for (const size of [{ width: 1920, height: 1120 }, { width: 1744, height: 850 }, { width: 1320, height: 880 }, { width: 1100, height: 700 }]) {
      await page.setViewportSize(size)
      await page.waitForTimeout(200)
      const label = `${size.width}x${size.height}, Chat only`
      const room = await boxOf(page.locator('#roomArea'))
      const column = await boxOf(log)
      expect(column.width, `${label}: the message column is ${column.width.toFixed(0)}px wide`).toBeGreaterThanOrEqual(600)
      expect(column.width, `${label}: chat must use the available room width`).toBeGreaterThanOrEqual(room.width - 4)
      const composer = await boxOf(page.locator('#chatInput'))
      expect(composer.x + composer.width, `${label}: composer must reach the room edge`).toBeGreaterThanOrEqual(room.x + room.width - 4)
      expect(composer.y + composer.height, `${label}: composer must stay in the window`).toBeLessThanOrEqual(size.height)
      // Left-aligned, so the window is not a column adrift in empty black.
      const gap = column.x - room.x
      expect(gap, `${label}: ${gap.toFixed(0)}px of empty room to the left of the conversation, of ${room.width.toFixed(0)}px`).toBeLessThan(room.width * 0.15)
      const lines = await lineCount(rows.first().locator('.bubble .text'))
      expect(lines, `${label}: a twenty-word message wrapped to ${lines} lines`).toBeLessThanOrEqual(3)
      if (size.width === 1744) await page.screenshot({ path: `${SHOTS}/chat-only-1744x850.png` })
    }

    // Opening and closing Shared Work must not cost the reader their place
    // or their half-written message. Nothing here rebuilds the log or the
    // composer, and this is what proves it stayed that way.
    await page.setViewportSize({ width: 1744, height: 850 })
    await page.waitForTimeout(200)
    await page.locator('#chatInput').fill('Half a thought, still being written')
    await log.evaluate(el => { el.scrollTop = Math.round(el.scrollHeight / 3) })
    const before = await log.evaluate(el => el.scrollTop)
    expect(before, 'the log never scrolled, so keeping its position proves nothing').toBeGreaterThan(10)
    const readingAnchor = await log.evaluate(el => {
      const edge = el.getBoundingClientRect().top
      const row = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find(row => row.getBoundingClientRect().bottom > edge)!
      return { id: row.dataset.messageId!, offset: row.getBoundingClientRect().top - edge }
    })
    const readingOffset = () => log.evaluate((el, id) => {
      const row = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find(row => row.dataset.messageId === id)!
      return row.getBoundingClientRect().top - el.getBoundingClientRect().top
    }, readingAnchor.id)
    await page.locator('#openAssignments').click()
    await expect(page.locator('#assignmentPanel')).toBeVisible()
    await page.waitForTimeout(300)
    expect(Math.abs(await readingOffset() - readingAnchor.offset), 'opening Shared Work moved the visible reading anchor').toBeLessThanOrEqual(2)
    await page.locator('#assignmentClose').click()
    await expect(page.locator('#assignmentPanel')).toBeHidden()
    await page.waitForTimeout(300)
    expect(Math.abs(await readingOffset() - readingAnchor.offset), 'closing Shared Work moved the visible reading anchor').toBeLessThanOrEqual(2)
    await expect(page.locator('#chatInput')).toHaveValue('Half a thought, still being written')

    // A picture puts something beside it, and the drawer is right again.
    // A call on its own does not: a voice call has nothing to show either,
    // so it is the controls strip and the conversation stays the column.
    await page.locator('#callToggle').click()
    await expect(page.locator('#callToggle')).toHaveText('Leave call')
    await expect(page.locator('html')).toHaveAttribute('data-call-pane', 'controls')
    await expect.poll(async () => (await boxOf(log)).width, { message: 'a voice call should not turn the conversation back into a strip' })
      .toBeGreaterThanOrEqual(600)
    await page.locator('#toggleCamera').click()
    await expect(page.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')
    await expect(page.locator('html')).toHaveAttribute('data-call-pane', 'live')
    await expect.poll(async () => (await boxOf(log)).width).toBeLessThan(600)
    await checkChatIsUsable(page, '1744x850, on a call with a camera')
    // And leaving gives the column back - Leave takes the camera with it.
    // With a picture on screen the call comes first, and its one Leave is
    // in the call's own bar.
    await page.locator('#leaveCall').click()
    await expect(page.locator('#callToggle')).toHaveText('Start call')
    await expect.poll(async () => (await boxOf(log)).width).toBeGreaterThanOrEqual(600)
    await expect(page.locator('#chatInput')).toHaveValue('Half a thought, still being written')
  } finally {
    await writer?.leave()
    await a.close()
  }
})

/**
 * The last place the owner's complaint still showed: a call with every
 * camera off.
 *
 * The pane had something to draw - this device's own controls - so it kept
 * the row layout, and the conversation sat at its 360px floor beside an
 * empty video grid. A voice call is now a strip too: who is on it by name,
 * the four controls, and Leave.
 *
 * The half of this that would be worth catching in the night is the sound.
 * The grid is hidden, never unmounted, because the remote `<audio>`
 * elements live inside those tiles and Chromium pauses a media element that
 * leaves the document. So the hear half is measured in every state this
 * walks through, with the same `inbound` statistics the media acceptance
 * test uses rather than a new measurement invented here.
 */

/** Sound actually arriving at this page, not merely an element that could
 *  carry some. Silent fake microphones are an environment fault and say so
 *  rather than failing, exactly as `expectToSeeAndHear` does. */
async function expectToStillHear(page: Page, label: string): Promise<void> {
  expect(await page.evaluate(remoteAudioCount), `${label}: no remote <audio> element is wired to a stream`).toBeGreaterThan(0)
  if (!(await page.evaluate(fakeMicMakesSound))) {
    test.info().annotations.push({ type: 'audio not checked', description: `${label}: this browser's fake microphone is emitting silence` })
    return
  }
  await expect.poll(async () => (await page.evaluate(inbound)).audioEnergy, {
    message: `${label}: the call is carrying no sound`,
    timeout: 60_000,
  }).toBeGreaterThan(0)
}

test('a call with no cameras is a strip of names, and a camera brings the pane back', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved - run the chromium-desktop project against a VITE_DESKTOP=true build')
  await mkdir(SHOTS, { recursive: true })

  const a = await newDeviceContext(browser, baseURL!)
  const b = await newDeviceContext(browser, baseURL!)
  // A microphone that genuinely makes a noise, so "can they hear each
  // other" is a measurement rather than a hope.
  await a.addInitScript(SYNTHETIC_MIC)
  await b.addInitScript(SYNTHETIC_MIC)
  try {
    const ada = await a.newPage()
    const bob = await b.newPage()
    await ada.setViewportSize({ width: 1320, height: 880 })
    await bob.setViewportSize({ width: 1320, height: 880 })

    const link = await createRoom(ada, baseURL!)
    await open(ada, link, 'Ada')
    await ada.locator('#join').click()
    await expect(ada.locator('#roomArea')).toBeVisible()
    await open(bob, link, 'Bob')
    await bob.locator('#join').click()
    await expect(bob.locator('#roomArea')).toBeVisible()

    // Both on the call, microphones on, nobody on camera.
    for (const page of [ada, bob]) {
      await page.locator('#callToggle').click()
      await expect(page.locator('#callToggle')).toHaveText('Leave call')
      await page.locator('#toggleMic').click()
      await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
      await expect(page.locator('#toggleCamera')).toHaveAttribute('data-on', 'false')
    }

    await expect(ada.locator('html')).toHaveAttribute('data-call-pane', 'controls', { timeout: 60_000 })
    const chips = ada.locator('#callChips .callChip')
    await expect(chips, 'both people should be named on the strip').toHaveCount(2, { timeout: 60_000 })
    await expect(ada.locator('#callChips')).toContainText('Ada')
    await expect(ada.locator('#callChips')).toContainText('Bob')
    // Everything a voice call needs, still to hand.
    for (const id of ['toggleMic', 'toggleCamera', 'toggleScreen', 'leaveCall']) {
      await expect(ada.locator(`#${id}`), `${id} should be on the strip`).toBeVisible()
    }
    await expectToStillHear(ada, 'voice call, pane collapsed')

    for (const size of [{ width: 1320, height: 880 }, { width: 1744, height: 850 }]) {
      await ada.setViewportSize(size)
      await ada.waitForTimeout(250)
      const label = `${size.width}x${size.height}, voice call`
      const pane = await boxOf(ada.locator('#callStage'))
      expect(pane.height, `${label}: the call pane is ${pane.height.toFixed(0)}px tall with nothing to show in it`).toBeLessThan(140)
      const chat = await boxOf(ada.locator('#chatLog'))
      expect(chat.width, `${label}: the conversation is ${chat.width.toFixed(0)}px wide`).toBeGreaterThanOrEqual(600)
      await ada.screenshot({ path: `${SHOTS}/voice-call-strip-${size.width}x${size.height}.png` })
    }
    await ada.setViewportSize({ width: 1320, height: 880 })

    // A camera comes on and the pane has something to hold again.
    await bob.locator('#toggleCamera').click()
    await expect(bob.locator('#toggleCamera')).toHaveAttribute('data-on', 'true')
    await expect(ada.locator('html'), 'a camera should grow the pane').toHaveAttribute('data-call-pane', 'live', { timeout: 5_000 })
    await expect(ada.locator('#room .participant video'), 'a tile should appear for the camera').toHaveCount(1, { timeout: 5_000 })
    await expect.poll(async () => (await boxOf(ada.locator('#callStage'))).height).toBeGreaterThan(140)
    await expect.poll(async () => (await boxOf(ada.locator('#chatDrawer'))).width, { message: 'the conversation should be the drawer again' })
      .toBeLessThan(600)
    await expectToStillHear(ada, 'camera on, pane expanded')
    for (const size of [{ width: 1320, height: 880 }, { width: 1744, height: 850 }]) {
      await ada.setViewportSize(size)
      await ada.waitForTimeout(250)
      await ada.screenshot({ path: `${SHOTS}/voice-call-live-${size.width}x${size.height}.png` })
    }
    await ada.setViewportSize({ width: 1320, height: 880 })

    // And off again: back to the strip, after the wait that stops a
    // flickering picture moving the layout.
    await bob.locator('#toggleCamera').click()
    await expect(bob.locator('#toggleCamera')).toHaveAttribute('data-on', 'false')
    await expect(ada.locator('html'), 'the last camera going should give the room back').toHaveAttribute('data-call-pane', 'controls', { timeout: 60_000 })
    await expect(chips).toHaveCount(2)
    const back = await boxOf(ada.locator('#callStage'))
    expect(back.height, `the pane came back as ${back.height.toFixed(0)}px rather than a strip`).toBeLessThan(140)
    await expectToStillHear(ada, 'camera off again, pane collapsed')
  } finally {
    await a.close()
    await b.close()
  }
})
