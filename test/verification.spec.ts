import { test, expect, type Page } from '@playwright/test'
import { createRoom, joinWithMedia, newDeviceContext } from './browser.js'

/**
 * Do the two sides actually say the same words?
 *
 * The unit tests prove the derivation is stable, directional and bound to
 * the pair. None of them can prove the thing the ritual depends on: that
 * the word on Ada's screen is the word Bob is waiting to hear. That is a
 * claim about two independent browsers agreeing, and only two independent
 * browsers can answer it.
 *
 * It is also the failure that would be invisible. A verification panel that
 * shows confident, well-formatted, mutually inconsistent words looks exactly
 * like one that works, right up until two people read them out and conclude
 * that somebody is an impostor.
 */

/** Read the verification panel by clicking the chip, and hand back its text. */
async function openVerification(page: Page, tileText: string): Promise<string> {
  const dialog = new Promise<string>((resolve) => {
    page.once('dialog', async (d) => {
      const message = d.message()
      await d.dismiss()
      resolve(message)
    })
  })
  await page.locator('#room .participant', { hasText: tileText }).locator('.verifyChip').click()
  return dialog
}

/** "Say to X: a b c" -> "a b c" */
function saidWords(panel: string, label: string): string {
  const line = panel.split('\n').find((l) => l.startsWith(label))
  expect(line, `no "${label}" line in:\n${panel}`).toBeTruthy()
  return line!.slice(label.length).trim()
}

test('both sides are shown the same words, and verifying is remembered', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')

  const contextA = await newDeviceContext(browser, baseURL!)
  const contextB = await newDeviceContext(browser, baseURL!)
  try {
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    const url = await createRoom(pageA, baseURL!)
    await joinWithMedia(pageA, url, 'Ada')
    await joinWithMedia(pageB, url, 'Bob')

    const bobOnAda = pageA.locator('#room .participant', { hasText: 'Bob' })
    const adaOnBob = pageB.locator('#room .participant', { hasText: 'Ada' })
    await expect(bobOnAda).toBeVisible({ timeout: 30_000 })
    await expect(adaOnBob).toBeVisible({ timeout: 30_000 })

    // Nobody has been checked yet, and that is not a warning.
    await expect(bobOnAda.locator('.verifyChip')).toHaveText('not verified')
    await expect(adaOnBob.locator('.verifyChip')).toHaveText('not verified')

    const panelA = await openVerification(pageA, 'Bob')
    const panelB = await openVerification(pageB, 'Ada')

    const adaSays = saidWords(panelA, 'Say to Bob:')
    const adaExpects = saidWords(panelA, 'They should say back:')
    const bobSays = saidWords(panelB, 'Say to Ada:')
    const bobExpects = saidWords(panelB, 'They should say back:')

    // The whole ritual, in two assertions: what each says is what the other
    // is waiting to hear.
    expect(adaSays, "Ada's word is not what Bob is expecting").toBe(bobExpects)
    expect(bobSays, "Bob's word is not what Ada is expecting").toBe(adaExpects)

    // Directional, so a parrot fails: the two words differ.
    expect(adaSays).not.toBe(bobSays)

    // Three words, not one. One is 11 bits, which is a coin toss somebody
    // would go on to call "verified".
    expect(adaSays.split(' ')).toHaveLength(3)

    // Now actually verify, and check it sticks.
    pageA.once('dialog', (d) => void d.accept())
    await bobOnAda.locator('.verifyChip').click()
    await expect(bobOnAda.locator('.verifyChip'), 'verifying Bob did not stick').toHaveText('verified', {
      timeout: 10_000,
    })

    // And it is this device's memory, not the room's: Bob's view of Ada is
    // untouched by Ada verifying Bob.
    await expect(adaOnBob.locator('.verifyChip')).toHaveText('not verified')
  } finally {
    await contextA.close()
    await contextB.close()
  }
})
