import { test, expect, type Page } from '@playwright/test'
import { createRoom, newDeviceContext, offerPairing, open, openCall, openRoomDetails } from './browser.js'

/**
 * The per-person volume slider (2026-09-13 dogfood feedback, item 6): one
 * slider per PERSON in Room details, not per device, because in this app
 * the person is the member - a laptop and a phone of the same person are
 * already one tile (see e2e.spec.ts and media.spec.ts's own linked-device
 * case). It sets how loud that person is on this device only; nothing is
 * published and nobody else's screen changes because of it.
 *
 * Audio only, deliberately: these tests care about `<audio>` elements and
 * `localStorage`, not decoded pixels, so no camera is ever turned on here -
 * media.spec.ts already proves the picture side of a call at real cost, and
 * there is nothing this file needs to re-prove about it.
 *
 * Sets the slider's value directly with `input`/`change` events rather than
 * dragging it: this is a test of the application's own event handling, not
 * of the browser's range-input rendering, and a real drag would tell it
 * nothing a dispatched event does not.
 */

/** In, with a microphone only - no camera, no screen. */
async function joinWithMic(page: Page, url: string, name: string): Promise<void> {
  await open(page, url, name)
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  await openCall(page)
  await page.locator('#toggleMic').click()
  await expect(page.locator('#toggleMic')).toHaveAttribute('data-on', 'true')
}

/** Sets a range input's value and fires the events the app's own listeners
 *  are wired to, without simulating a pixel-accurate drag. */
async function setSlider(page: Page, name: string, percent: number): Promise<void> {
  const slider = page.getByRole('slider', { name })
  await slider.evaluate((el, value) => {
    const input = el as HTMLInputElement
    input.value = String(value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, percent)
}

test('one slider governs every device of a paired person, and nobody else changes', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')

  const laptop = await newDeviceContext(browser, baseURL!)
  const phone = await newDeviceContext(browser, baseURL!)
  const watcher = await newDeviceContext(browser, baseURL!)
  try {
    const pageLaptop = await laptop.newPage()
    const pagePhone = await phone.newPage()
    const pageCara = await watcher.newPage()

    const url = await createRoom(pageLaptop, baseURL!)

    // Ada's laptop: it goes in first, since the pass for a second device is
    // offered from inside the room and the offer lives only as long as this
    // page, which stays put from here on.
    await joinWithMic(pageLaptop, url, 'Ada')
    const pairUrl = await offerPairing(pageLaptop)

    // Ada's phone: a separate context, so separate localStorage - it opens
    // the PAIRING link and becomes a second device of Ada rather than a
    // second Ada. Approving it on the laptop is a live exchange, so both
    // sides run together.
    await Promise.all([
      open(pagePhone, pairUrl, 'Ada'),
      pageLaptop.getByRole('button', { name: 'Add device', exact: true }).click(),
    ])
    await pagePhone.locator('#join').click()
    await expect(pagePhone.locator('#roomArea')).toBeVisible()
    await openCall(pagePhone)
    await pagePhone.locator('#toggleMic').click()
    await expect(pagePhone.locator('#toggleMic')).toHaveAttribute('data-on', 'true')

    // Cara: somebody else entirely, and the only screen that matters here.
    await joinWithMic(pageCara, url, 'Cara')

    // One person, two devices - the grouping e2e.spec.ts guards, restated
    // here only because the slider assertion below is meaningless without
    // it: a slider per device would be the bug this feature exists to avoid.
    const grouped = pageCara.locator('#room .participant.linked')
    await expect(grouped).toHaveCount(1, { timeout: 90_000 })
    await expect(grouped.locator('h3')).toContainText('2 devices')
    await expect(grouped.locator('audio')).toHaveCount(2, { timeout: 60_000 })

    await openRoomDetails(pageCara)
    // Exactly one slider for Ada - the roster already groups her by
    // participant, not by device, and this is the same claim restated at
    // the control a person actually touches.
    await expect(pageCara.getByRole('slider', { name: 'Volume for Ada' })).toHaveCount(1)

    await setSlider(pageCara, 'Volume for Ada', 50)
    await pageCara.locator('#roomSheetClose').click()

    await expect
      .poll(
        () => grouped.locator('audio').evaluateAll((els) => els.map((e) => (e as HTMLAudioElement).volume)),
        { message: "Ada's two devices did not both take the new level" },
      )
      .toEqual([0.5, 0.5])

    // Isolation: this is a record about Ada, not a global switch. Only one
    // participant's level is ever written to this device's storage.
    const volumeKeys = await pageCara.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.startsWith('kithmoot.volume.v1.')),
    )
    expect(volumeKeys, 'a level for one person leaked into the record of another').toHaveLength(1)
  } finally {
    await laptop.close()
    await phone.close()
    await watcher.close()
  }
})

test('a level survives a track handed over on renegotiation, and a reload', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')

  const deviceA = await newDeviceContext(browser, baseURL!)
  const deviceB = await newDeviceContext(browser, baseURL!)
  try {
    const pageA = await deviceA.newPage()
    const pageB = await deviceB.newPage()
    const url = await createRoom(pageA, baseURL!)

    await joinWithMic(pageA, url, 'Ada')
    await joinWithMic(pageB, url, 'Bob')

    const bobAudio = pageA.locator('#room .participant audio').first()
    await expect(pageA.locator('#room .participant audio')).toHaveCount(1, { timeout: 60_000 })

    await openRoomDetails(pageA)
    await setSlider(pageA, 'Volume for Bob', 50)
    await pageA.locator('#roomSheetClose').click()

    await expect.poll(() => bobAudio.evaluate((el) => (el as HTMLAudioElement).volume)).toBe(0.5)

    // Renegotiation: Bob's mic goes off and on, handing a NEW
    // MediaStreamTrack object over the same advertised slot. The level must
    // still apply to whatever arrives on it.
    await pageB.locator('#toggleMic').click()
    await expect(pageB.locator('#toggleMic')).toHaveAttribute('data-on', 'false')
    await pageB.locator('#toggleMic').click()
    await expect(pageB.locator('#toggleMic')).toHaveAttribute('data-on', 'true')

    await expect
      .poll(() => bobAudio.evaluate((el) => (el as HTMLAudioElement).volume), {
        message: "Bob's level did not survive his renegotiated track",
        timeout: 30_000,
      })
      .toBe(0.5)

    // Reload: the level is remembered on this device, not only in memory.
    // A reload lands back at the door - the room is known, but rejoining is
    // still a click, same as any other visit.
    await pageA.reload()
    await expect(pageA.locator('#join')).toBeVisible({ timeout: 60_000 })
    await expect(pageA.locator('#join')).toBeEnabled({ timeout: 60_000 })
    await pageA.locator('#join').click()
    await expect(pageA.locator('#roomArea')).toBeVisible()

    await openRoomDetails(pageA)
    await expect(pageA.getByRole('slider', { name: 'Volume for Bob' })).toHaveValue('50', { timeout: 30_000 })
  } finally {
    await deviceA.close()
    await deviceB.close()
  }
})

test('a 200% level reaches the gain path for real, and Leave still outranks a custom level', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')

  const deviceA = await newDeviceContext(browser, baseURL!)
  const deviceB = await newDeviceContext(browser, baseURL!)
  try {
    const pageA = await deviceA.newPage()
    const pageB = await deviceB.newPage()
    const url = await createRoom(pageA, baseURL!)

    await joinWithMic(pageA, url, 'Ada')
    await joinWithMic(pageB, url, 'Bob')

    const bobAudio = pageA.locator('#room .participant audio').first()
    await expect(pageA.locator('#room .participant audio')).toHaveCount(1, { timeout: 60_000 })

    // 200% needs the gain path (see remote-volume.ts), and this exercises
    // it for real rather than only in remote-volume.test.ts. Its element is
    // ALWAYS left muted while that path is active - it is the decode sink,
    // never the speaker - so `.muted` reading true here is not yet evidence
    // about the one-speaker rule either way; that the rule still zeroes the
    // gain node itself, whatever the level, is what remote-volume.test.ts
    // proves directly.
    await openRoomDetails(pageA)
    await setSlider(pageA, 'Volume for Bob', 200)
    await pageA.locator('#roomSheetClose').click()
    await expect.poll(() => bobAudio.evaluate((el) => (el as HTMLAudioElement).muted)).toBe(true)

    // Back to a level the plain `.volume` path carries, where `.muted` is
    // the rule's own direct answer - the observable case for what Leave has
    // to override.
    await openRoomDetails(pageA)
    await setSlider(pageA, 'Volume for Bob', 50)
    await pageA.locator('#roomSheetClose').click()
    await expect.poll(() => bobAudio.evaluate((el) => (el as HTMLAudioElement).muted)).toBe(false)

    // Leave: the one-speaker rule's cousin, and the one nothing may
    // override. Bob must go silent for Ada even at a level she chose.
    await pageA.locator('#leaveCall').click()
    await expect
      .poll(() => bobAudio.evaluate((el) => (el as HTMLAudioElement).muted), {
        message: 'Leave did not override a custom level',
        timeout: 15_000,
      })
      .toBe(true)
  } finally {
    await deviceA.close()
    await deviceB.close()
  }
})
