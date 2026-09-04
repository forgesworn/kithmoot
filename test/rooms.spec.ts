import { test, expect, type Page } from '@playwright/test'
import { openRoomUrl, pinToTestRelays } from './relays.js'
import { newDeviceContext } from './browser.js'

/**
 * Your rooms: the front page remembers the rooms this device has been in.
 *
 * A person is in several standing rooms, and before this the app was one
 * room per tab with no memory of the others. This drives the whole loop
 * from one device's screen: two rooms started and named, the list showing
 * both, somebody else joining one and saying something, the list saying so
 * without this device being in the room, opening the room from the list,
 * reading, and coming back to a list that says there is nothing new.
 *
 * The counts are read with the key this device already holds. Here that
 * is the creator's, which the app keeps for twelve hours; the list holds
 * no key of its own, and nothing it does publishes anything - see
 * app/src/room-watch.ts.
 *
 * The creator answers the link from a tab that stays on the room, as the
 * README says to. The list is another tab of the same browser: a person
 * keeping their town hall open in one tab and looking at their rooms in
 * another, which is the ordinary shape of it.
 */

/** Starts a room named `name` from the front page, and returns its join
 *  link pinned to the test relays. The page is left on the unpinned link;
 *  the caller re-opens it on the pinned one. */
async function startNamedRoom(page: Page, baseURL: string, name: string): Promise<string> {
  await page.goto(baseURL)
  await page.locator('#roomName').fill(name)
  await page.locator('#create').click()
  // The link exists the moment the room does, but the drawer holding it
  // stays shut until somebody is inside. So this waits for the value, not
  // for the box: waiting for it to be on screen would be waiting for a
  // thing the page deliberately does not do until a person has gone in.
  const share = page.locator('#shareUrl')
  await expect.poll(async () => (await share.inputValue()).length, { timeout: 30_000 }).toBeGreaterThan(0)
  await expect(page.locator('#roomTitle .name')).toHaveText(name)
  return pinToTestRelays(await share.inputValue())
}

/** The room page is up and this device is at the door. The way in is the
 *  only control out here now, so it is the only honest thing to wait on. */
async function expectAtTheDoor(page: Page): Promise<void> {
  await expect(page.locator('#join')).toBeVisible({ timeout: 60_000 })
}

test('the front page lists every room this device has been in, with what is new and who is here', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')
  const url = baseURL!
  const principal = await newDeviceContext(browser, url)
  const visitor = await newDeviceContext(browser, url)

  try {
    const page = await principal.newPage()

    // Two standing rooms, made and named on this device. Each is re-opened
    // on its pinned link so the room lives on the test relays, and so the
    // link the list keeps is the one that works.
    const townHall = await startNamedRoom(page, url, 'Town hall')
    await openRoomUrl(page, townHall)
    await expectAtTheDoor(page)
    await expect(page.locator('#roomTitle .name')).toHaveText('Town hall')

    // The tab that answers the town hall's link. It stays put.
    const hall = await principal.newPage()
    await openRoomUrl(hall, townHall)
    await expectAtTheDoor(hall)

    const bench = await startNamedRoom(page, url, 'Bench')
    await openRoomUrl(page, bench)
    await expectAtTheDoor(page)

    // Back to the front page: both rooms, by name, with the room's id
    // beside each - two rooms can be called the same thing.
    await page.locator('#backToRooms').click()
    await expect(page.locator('#rooms')).toBeVisible()
    const rows = page.locator('#roomList .roomRow')
    await expect(rows).toHaveCount(2)
    expect((await rows.locator('.roomName').allTextContents()).sort()).toEqual(['Bench', 'Town hall'])
    await expect(rows.locator('.pubkey')).toHaveCount(2)
    const townHallRow = page.locator('#roomList .roomRow', { has: page.locator('.roomName', { hasText: 'Town hall' }) })
    const benchRow = page.locator('#roomList .roomRow', { has: page.locator('.roomName', { hasText: 'Bench' }) })
    // Read with the creator's key, which this device holds: nothing new
    // in either, and nobody has been heard from.
    await expect(townHallRow.locator('.unread')).toHaveText('nothing new')
    await expect(benchRow.locator('.unread')).toHaveText('nothing new')
    await expect(townHallRow.locator('.here')).toHaveAttribute('data-count', '0')

    // Somebody else joins the town hall from its link and says something.
    const other = await visitor.newPage()
    await openRoomUrl(other, townHall)
    await other.locator('#displayName').fill('Ada')
    await expectAtTheDoor(other)
    await expect(other.locator('#join')).toBeEnabled({ timeout: 60_000 })
    await other.locator('#join').click()
    await expect(other.locator('#roomArea')).toBeVisible()
    await other.locator('#chatInput').fill('hello town hall')
    await other.locator('#chatInput').press('Enter')
    await expect(other.locator('#chatLog')).toContainText('hello town hall', { timeout: 30_000 })

    // The list, still on screen and still not in the room, says so: one
    // unread, one person here, shown as a person is shown everywhere else
    // - a name beside a key - and not marked as an agent. The bench is
    // untouched.
    await expect(townHallRow.locator('.unread')).toHaveText('1 unread', { timeout: 60_000 })
    await expect(townHallRow.locator('.here')).toHaveText('1 person here:', { timeout: 60_000 })
    await expect(townHallRow.locator('.hereChip .name')).toHaveText('Ada')
    await expect(townHallRow.locator('.hereChip .pubkey')).toHaveCount(1)
    await expect(townHallRow.locator('.hereChip .badge.agent')).toHaveCount(0)
    await expect(benchRow.locator('.unread')).toHaveText('nothing new')

    // Opening a room from the list is opening its link. Joining and seeing
    // the message is reading it, and the list says so on the way back.
    await townHallRow.locator('button.open').click()
    await expect(page.locator('#roomTitle .name')).toHaveText('Town hall')
    await expect(page.locator('#join')).toBeEnabled({ timeout: 60_000 })
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#chatLog')).toContainText('hello town hall', { timeout: 60_000 })
    await page.locator('#backToRooms').click()
    await expect(page.locator('#rooms')).toBeVisible()
    await expect(townHallRow.locator('.unread')).toHaveText('nothing new', { timeout: 60_000 })

    // Forgetting a room takes it off this device's list and nothing else:
    // the room, and everybody in it, are untouched.
    page.on('dialog', (dialog) => void dialog.accept())
    await benchRow.locator('button.forget').click()
    await expect(page.locator('#roomList .roomRow')).toHaveCount(1)
    await expect(page.locator('#roomList .roomName')).toHaveText(['Town hall'])
    await expect(other.locator('#roomArea')).toBeVisible()
  } finally {
    await Promise.all([principal.close(), visitor.close()])
  }
})
