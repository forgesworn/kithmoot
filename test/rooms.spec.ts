import { test, expect, type Page } from '@playwright/test'
import { openRoomUrl, pinToTestRelays } from './relays.js'
import { newDeviceContext, openNewRoomForm } from './browser.js'

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
  await openNewRoomForm(page)
  await page.locator('#roomName').fill(name)
  await page.locator('#create').click()
  // The link exists the moment the room does, but the drawer holding it
  // stays shut until somebody is inside. So this waits for the value, not
  // for the box: waiting for it to be on screen would be waiting for a
  // thing the page deliberately does not do until a person has gone in.
  const share = page.locator('#shareUrl')
  await expect.poll(async () => (await share.inputValue()).length, { timeout: 30_000 }).toBeGreaterThan(0)
  await expect(page.locator('#roomTitle')).toHaveText(name)
  return pinToTestRelays(await share.inputValue())
}

/** The room page is up and this device is at the door. The way in is the
 *  only control out here now, so it is the only honest thing to wait on. */
async function expectAtTheDoor(page: Page): Promise<void> {
  await expect(page.locator('#join')).toBeVisible({ timeout: 60_000 })
}

/** Opens a row's `⋯` menu, the native popover built by `roomRowMenu` in
 *  app/src/main.ts. */
async function openRowMenu(row: ReturnType<Page['locator']>): Promise<void> {
  await row.locator('.rowMenu').click()
}

test('opening an older conversation keeps its message time and position until a new message arrives', async ({ browser, baseURL }) => {
  const principal = await newDeviceContext(browser, baseURL!)
  try {
    const page = await principal.newPage()
    const now = Date.now()
    await page.clock.setFixedTime(now)
    const post = async (text: string) => {
      await page.locator('#chatInput').fill(text)
      await page.locator('#chatInput').press('Enter')
      await expect(page.locator('#chatLog')).toContainText(text)
    }
    const home = async () => {
      await page.locator('#backToRooms').click()
      await page.locator('#roomSwitcherHome').click()
      await expect(page.locator('#rooms')).toBeVisible()
    }
    const enter = async (link: string) => {
      await openRoomUrl(page, link)
      await expectAtTheDoor(page)
      await page.locator('#join').click()
      await expect(page.locator('#roomArea')).toBeVisible()
    }
    const older = await startNamedRoom(page, baseURL!, 'Older conversation')
    await enter(older)
    await post('First conversation message')
    await home()
    await page.clock.setFixedTime(now + 65_000)
    const newer = await startNamedRoom(page, baseURL!, 'Newer conversation')
    await enter(newer)
    await post('Second conversation message')
    await home()
    const rows = page.locator('#roomList .roomRow')
    const names = rows.locator('.roomName')
    const olderRow = rows.filter({ has: page.locator('.roomName', { hasText: 'Older conversation' }) })
    await expect(names).toHaveText(['Newer conversation', 'Older conversation'])
    const originalTime = await olderRow.locator('.roomTime').textContent()
    expect(originalTime).toBeTruthy()
    await page.clock.setFixedTime(now + 130_000)
    await olderRow.locator('button.open').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#chatLog')).toContainText('First conversation message')
    await home()
    await expect(names).toHaveText(['Newer conversation', 'Older conversation'])
    await expect(olderRow.locator('.roomTime')).toHaveText(originalTime!)
    await olderRow.locator('button.open').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await post('A genuinely new message')
    await home()
    await expect(names).toHaveText(['Older conversation', 'Newer conversation'])
    await expect(olderRow.locator('.roomPreview')).toContainText('A genuinely new message')
    await expect(olderRow.locator('.roomTime')).not.toHaveText(originalTime!)
  } finally {
    await principal.close()
  }
})

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
    await expect(page.locator('#roomTitle')).toHaveText('Town hall')

    // The tab that answers the town hall's link. It stays put.
    const hall = await principal.newPage()
    await openRoomUrl(hall, townHall)
    await expectAtTheDoor(hall)

    const bench = await startNamedRoom(page, url, 'Bench')
    await openRoomUrl(page, bench)
    await expectAtTheDoor(page)

    // Back to the front page: both rooms, by name. From the DOOR of a
    // room, which is where this page is. Once you are inside, the room's
    // own bar carries the way out; this is the way out before that.
    await page.locator('#doorToRooms').click()
    await page.locator('#roomSwitcherHome').click()
    await expect(page.locator('#rooms')).toBeVisible()
    const rows = page.locator('#roomList .roomRow')
    await expect(rows).toHaveCount(2)
    expect((await rows.locator('.roomName').allTextContents()).sort()).toEqual(['Bench', 'Town hall'])
    // No hex id beside a room name: two rooms with the same name is rare,
    // and the id lives in Room details.
    expect((await rows.locator('.roomName').allTextContents()).join(' ')).not.toMatch(/\b[0-9a-f]{8}\b/)
    const townHallRow = page.locator('#roomList .roomRow', { has: page.locator('.roomName', { hasText: 'Town hall' }) })
    const benchRow = page.locator('#roomList .roomRow', { has: page.locator('.roomName', { hasText: 'Bench' }) })
    // Read with the creator's key, which this device holds: nothing new in
    // either, and nobody has been heard from.
    // An empty room is one line; the row's description still says why.
    await expect(townHallRow.locator('.roomPreview')).toHaveCount(0)
    await expect(townHallRow.locator('.sr-only')).toContainText('No messages yet')
    // An empty room is one line; the row's description still says why.
    await expect(benchRow.locator('.roomPreview')).toHaveCount(0)
    await expect(benchRow.locator('.sr-only')).toContainText('No messages yet')
    await expect(townHallRow.locator('.unread')).toHaveCount(0)
    await expect(townHallRow.locator('.here')).toHaveCount(0)

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
    // unread pill, a preview of the newest message, and one person here.
    // The bench is untouched.
    await expect(townHallRow.locator('.unread')).toHaveText('1', { timeout: 60_000 })
    await expect(townHallRow.locator('.unread')).toHaveAttribute('aria-label', '1 unread')
    await expect(townHallRow.locator('.roomPreview')).toHaveText('Ada: hello town hall')
    await expect(townHallRow.locator('.here')).toHaveText('1 here')
    await expect(townHallRow.locator('.here')).toHaveAttribute('aria-label', '1 person here')
    // An empty room is one line; the row's description still says why.
    await expect(benchRow.locator('.roomPreview')).toHaveCount(0)
    await expect(benchRow.locator('.sr-only')).toContainText('No messages yet')

    // Opening a saved room now joins it directly. Seeing the message is
    // reading it, and the list says so on the way back.
    await townHallRow.locator('button.open').click()
    await expect(page.locator('#roomTitle')).toHaveText('Town hall')
    await expect(page.locator('#roomArea')).toBeVisible()
    await expect(page.locator('#chatLog')).toContainText('hello town hall', { timeout: 60_000 })
    await page.locator('#backToRooms').click()
    await page.locator('#roomSwitcherHome').click()
    await expect(page.locator('#rooms')).toBeVisible()
    await expect(townHallRow.locator('.unread')).toHaveCount(0, { timeout: 60_000 })

    // Forgetting a room, from its `⋯` menu, takes it off this device's
    // list and nothing else: the room, and everybody in it, are untouched.
    await openRowMenu(benchRow)
    await page.getByRole('menuitem', { name: 'Forget this room' }).click()
    await page.locator('#actionConfirm').click()
    await expect(page.locator('#roomList .roomRow')).toHaveCount(1)
    await expect(page.locator('#roomList .roomName')).toHaveText(['Town hall'])
    await expect(other.locator('#roomArea')).toBeVisible()
  } finally {
    await Promise.all([principal.close(), visitor.close()])
  }
})

// Acceptance check 9: a room the list would otherwise promote to the top
// must not move, or steal focus, while a person's focus or pointer is
// still inside #roomList. Section 7 of the spec.
//
// openedAt is Unix seconds, and three rooms made back to back in a test
// often land in the same second - so rather than assume which order three
// freshly made rooms start in, this reads whatever order the list actually
// gives them, bumps the room that is NOT under focus, and checks the held
// and the released order against that same starting point.
test('rows do not reorder while focus is inside the list', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')
  const url = baseURL!
  const principal = await newDeviceContext(browser, url)
  const visitor = await newDeviceContext(browser, url)

  try {
    const page = await principal.newPage()

    // Three standing rooms; the order they end up in is whatever the list
    // says once they all exist, not assumed from the order made here.
    const links = new Map<string, string>()
    for (const name of ['Room A', 'Room B', 'Room C']) {
      const link = await startNamedRoom(page, url, name)
      await openRoomUrl(page, link)
      await expectAtTheDoor(page)
      links.set(name, link)
    }

    await page.locator('#doorToRooms').click()
    await page.locator('#roomSwitcherHome').click()
    await expect(page.locator('#rooms')).toBeVisible()
    const startOrder = await page.locator('#roomList .roomName').allTextContents()
    expect(startOrder.sort()).toEqual(['Room A', 'Room B', 'Room C'])
    const initialOrder = await page.locator('#roomList .roomName').allTextContents()

    // Focus the row NOT being bumped, in the middle of the list - a new
    // message in either neighbour must not move it or steal its focus.
    const heldName = initialOrder[1]!
    const bumpedName = initialOrder[2]!
    const heldRow = page.getByRole('button', { name: `Open ${heldName}`, exact: true })
    await heldRow.focus()
    await expect(heldRow).toBeFocused()

    // Somebody joins the last room in the list and says something - on its
    // own this would jump that room to the top of the list.
    const other = await visitor.newPage()
    await openRoomUrl(other, links.get(bumpedName)!)
    await other.locator('#displayName').fill('Rowan')
    await expectAtTheDoor(other)
    await expect(other.locator('#join')).toBeEnabled({ timeout: 60_000 })
    await other.locator('#join').click()
    await expect(other.locator('#roomArea')).toBeVisible()
    await other.locator('#chatInput').fill('new message while you are focused elsewhere')
    await other.locator('#chatInput').press('Enter')
    await expect(other.locator('#chatLog')).toContainText('new message while you are focused elsewhere', { timeout: 30_000 })

    // Give the list every chance to have redrawn (it also redraws on a
    // 5-second timer) and confirm it held its order and this device's focus.
    await page.waitForTimeout(6000)
    await expect(page.locator('#roomList .roomName')).toHaveText(initialOrder)
    await expect(heldRow).toBeFocused()

    // Focus leaves the list: the next render is free to catch up, and the
    // bumped room - now with an unread message - moves to the top.
    await page.locator('#openAppSettings').focus()
    await expect
      .poll(async () => (await page.locator('#roomList .roomName').allTextContents())[0], { timeout: 10_000 })
      .toBe(bumpedName)
    // The other two rooms are still exactly the two that were not bumped -
    // nothing was lost or duplicated in reordering.
    expect((await page.locator('#roomList .roomName').allTextContents()).sort()).toEqual(['Room A', 'Room B', 'Room C'])
  } finally {
    await Promise.all([principal.close(), visitor.close()])
  }
})
