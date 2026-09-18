import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { createRoom, joinWithMedia, newDeviceContext, open, openCall, turnOnMedia } from './browser.js'

/**
 * Person beside their screen, and a chat that slides rather than sits.
 *
 * Two people each sharing a camera and a screen. What the owner asked for,
 * and what three passes at this got wrong in three different ways:
 *
 *  - Each person is a ROW: their camera at the left of it, their own screen
 *    beside it on the right, and the rows stacked so both people are on the
 *    screen at once. (Pass one put the camera at 437px against a 225px
 *    screen and left half the window empty.)
 *  - Every camera is the same size as every other camera. (Pass two made
 *    each camera a ~130px full-height portrait strip.)
 *  - A share's box is the shape of the picture in it. (Pass two letterboxed
 *    every share inside ~100px black bands top and bottom.)
 *  - Neither row runs off the bottom of the window, at either of two window
 *    sizes a person actually uses.
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
  const tiles = page.locator('#room .participant:has(video.screenPreview)')
  await expect(tiles, `${label}: both shares should be on screen`).toHaveCount(2, { timeout: 60_000 })

  // Settle: the fit runs off a frame callback, so read the geometry only
  // once two consecutive reads agree.
  await expect.poll(async () => {
    const boxes = await tiles.locator('video.screenPreview').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().width)))
    return boxes.join(',')
  }, { timeout: 30_000, message: `${label}: share boxes never settled` }).not.toBe('')
  await page.waitForTimeout(400)

  if (process.env.DESKTOP_LAYOUT_DEBUG) {
    console.log(label, JSON.stringify(await page.evaluate(() => {
      const room = document.getElementById('room')!
      const stage = document.getElementById('callStage')!
      const r = (el: Element) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }
      return {
        stage: r(stage), stageScroll: stage.scrollHeight, room: r(room), innerHeight: window.innerHeight,
        tiles: Array.from(room.children).map(t => ({
          box: r(t), cls: t.className,
          media: Array.from(t.children).filter(c => c.classList.contains('media')).map(m => r(m)),
          share: t.querySelector('video.screenPreview') ? r(t.querySelector('video.screenPreview')!) : null,
          cam: t.querySelector('video:not(.screenPreview)') ? r(t.querySelector('video:not(.screenPreview)')!) : null,
        })),
      }
    }), null, 1))
  }

  const cameras: Box[] = []
  const rows: Box[] = []
  for (let i = 0; i < 2; i++) {
    const tile = tiles.nth(i)
    const camera = tile.locator('video:not(.screenPreview)')
    const share = tile.locator('video.screenPreview')
    await expect(camera, `${label}: camera ${i} should be visible`).toBeVisible()
    await expect(share, `${label}: share ${i} should be visible`).toBeVisible()

    const cam = await boxOf(camera)
    const scr = await boxOf(share)
    cameras.push(cam)
    rows.push(await boxOf(tile))

    // Camera on the left, that person's own screen on the right of it.
    expect(scr.x, `${label}: share ${i} is not to the right of its own camera`).toBeGreaterThanOrEqual(cam.x + cam.width - 2)
    // Top-aligned with each other: the camera does not stretch to match a
    // taller screen.
    expect(Math.abs(scr.y - cam.y), `${label}: share ${i} is not level with its camera`).toBeLessThanOrEqual(4)
    // The screen is the thing being read; the camera is context beside it.
    expect(scr.width, `${label}: share ${i} is not wider than its camera`).toBeGreaterThan(cam.width)

    // No bands. The element's box has to be the shape of the picture, or
    // `object-fit: contain` pillarboxes or letterboxes the difference - and
    // a share inside 100px of black top and bottom is worse than no layout
    // at all.
    const aspect = await naturalAspect(share)
    expect(aspect, `${label}: share ${i} never decoded a picture`).toBeGreaterThan(0)
    const drawnWidth = Math.min(scr.width, scr.height * aspect)
    const drawnHeight = Math.min(scr.height, scr.width / aspect)
    const filled = (drawnWidth * drawnHeight) / (scr.width * scr.height)
    expect(filled, `${label}: share ${i} is mostly empty box - ${scr.width.toFixed(0)}x${scr.height.toFixed(0)} around a ${aspect.toFixed(2)} picture`).toBeGreaterThanOrEqual(0.8)
    expect((scr.height - drawnHeight) / 2, `${label}: share ${i} has letterbox bands`).toBeLessThanOrEqual(scr.height * 0.1)
    expect((scr.width - drawnWidth) / 2, `${label}: share ${i} has pillarbox bands`).toBeLessThanOrEqual(scr.width * 0.1)
  }

  // Two faces the same size as each other, whoever is sharing what.
  expect(Math.abs(cameras[0].width - cameras[1].width), `${label}: camera tiles are not the same width`).toBeLessThanOrEqual(2)
  expect(Math.abs(cameras[0].height - cameras[1].height), `${label}: camera tiles are not the same height`).toBeLessThanOrEqual(2)
  // And the size the owner asked for, not a strip and not half the window.
  for (const [i, cam] of cameras.entries()) {
    expect(cam.width, `${label}: camera ${i} is ${cam.width.toFixed(0)}px wide, outside the 240-320px the owner asked for`).toBeGreaterThanOrEqual(240)
    expect(cam.width, `${label}: camera ${i} is ${cam.width.toFixed(0)}px wide, outside the 240-320px the owner asked for`).toBeLessThanOrEqual(320)
  }

  // Rows, stacked: one person per row rather than two people squeezed side
  // by side, and the second row genuinely below the first.
  const [first, second] = rows[0].y <= rows[1].y ? [rows[0], rows[1]] : [rows[1], rows[0]]
  expect(second.y, `${label}: the two sharers are not on separate rows`).toBeGreaterThanOrEqual(first.y + first.height - 4)

  // Both rows on the screen. This is the one that pushes back on "as tall
  // as the picture wants": the second row has to fit, so the first one
  // gives up height rather than the second one giving up its place.
  //
  // Measured against the stage's own visible bottom edge as well as the
  // window's, because the stage scrolls. A row can sit inside an 880px
  // window and still be clipped off the bottom of a 741px stage, which is
  // exactly what happened here first time round and looked perfect in every
  // number the test was reading.
  const stage = await page.locator('#callStage').evaluate(el => {
    const box = el.getBoundingClientRect()
    return { bottom: box.bottom, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
  })
  expect(stage.scrollHeight, `${label}: the call stage has to scroll to show the room, so something is off the bottom of it`).toBeLessThanOrEqual(stage.clientHeight + 2)
  const floor = Math.min(viewport.height, stage.bottom)
  for (const [i, row] of rows.entries()) {
    expect(row.y, `${label}: row ${i} starts above the window`).toBeGreaterThanOrEqual(-1)
    expect(row.y + row.height, `${label}: row ${i} runs ${(row.y + row.height - floor).toFixed(0)}px past the visible bottom of a ${viewport.width}x${viewport.height} window`).toBeLessThanOrEqual(floor + 1)
  }
}

test('two people each share a screen beside their own camera, both rows on screen, chat on a drawer', async ({ browser, baseURL }) => {
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
    const toggle = pageA.locator('#chatDrawerToggle')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(pageA.locator('#chatDrawer')).toHaveJSProperty('dataset.open', 'true')

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
    await expect(pageA.locator('#chatDrawer')).toHaveJSProperty('dataset.open', 'false')
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
    await expect(page.locator('html')).toHaveAttribute('data-call-pane', 'live')
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
    await expect(page.locator('html')).toHaveAttribute('data-call-pane', 'live')
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
