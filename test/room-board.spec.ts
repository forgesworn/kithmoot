import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { crc32, deflateSync } from 'node:zlib'
import type * as Y from 'yjs'
import { RoomAgent } from '../src/agent.js'
import { memoryRoomBoardStorage } from '../src/room-board-wire.js'
import { TEST_RELAY_HTTP, allowTestFileStorage, closeRoomBoard, createRoom, join, leaveRoom, leaveToChats, newDeviceContext, open, openRoomBoard } from './browser.js'
import { agentRelaysFor, testRelaysFor } from './relays.js'

// The room's own board, walked the way people meet it: nobody creates it,
// shares it or joins it. Each person here is a visitor with a name and the
// room's link, with no Nostr account, and each has a browser of their own.
// The board is asserted from the LAST arrival, after the people who wrote
// it have gone: a board that only its author can see proves nothing.

const board = (page: Page) => page.frameLocator('#roomBoardPanel iframe')
/** The public server a device that has chosen nothing would send files to. No test lets a request reach it. */
const DEFAULT_FILE_SERVER = 'https://blossom.yakihonne.com'
const card = (page: Page, title: string) => board(page).getByRole('link', { name: title, exact: true })

async function addCard(page: Page, title: string): Promise<void> {
  const composer = board(page).getByRole('textbox', { name: 'Add a card to To do', exact: true })
  await composer.fill(title)
  await composer.press('Enter')
  await expect(card(page, title)).toBeVisible()
}

/** The names of this browser's saved board records. */
const keptRecords = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('kithmoot.room-board.v1.')))

async function enter(page: Page, url: string, name: string): Promise<void> {
  await open(page, url, name)
  await join(page)
  await expect(page.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
}

test('every room has a board that everybody in it shares, with nothing to set up', async ({ browser, baseURL }) => {
  const adaContext = await newDeviceContext(browser, baseURL!)
  const ada = await adaContext.newPage()
  const url = await createRoom(ada, baseURL!, testRelaysFor(baseURL!))

  await expect(ada.getByRole('button', { name: 'Room board', exact: true })).toBeVisible()
  await openRoomBoard(ada)
  for (const column of ['To do', 'Doing', 'Done']) {
    await expect(board(ada).getByRole('heading', { name: column, exact: true })).toBeVisible()
  }
  await expect(board(ada).getByText('On this device only')).toHaveCount(0)
  await addCard(ada, 'Book the hall')
  await expect(ada.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.')
  await closeRoomBoard(ada)
  await openRoomBoard(ada)

  // Bob has only the room link and a name.
  const bobContext = await newDeviceContext(browser, baseURL!)
  const bob = await bobContext.newPage()
  await bob.setViewportSize({ width: 390, height: 760 })
  await enter(bob, url, 'Bob')
  await openRoomBoard(bob)
  await expect(card(bob, 'Book the hall')).toBeVisible()
  await expect(board(bob).getByRole('heading', { name: 'To do', exact: true })).toHaveCount(1)

  // What Bob adds reaches Ada's open board without her doing anything.
  await addCard(bob, 'Order the tea')
  await expect(card(ada, 'Order the tea')).toBeVisible()
  await expect(bob.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.')

  // The same live conversation is below both boards, including on a phone.
  const bobComposer = bob.locator('#chatInput')
  const divider = bob.getByRole('separator', { name: 'Resize chat' })
  await expect(divider).toBeVisible()
  await expect(bob.getByRole('slider', { name: 'Chat size' })).toHaveCount(0)
  await expect(bobComposer).toBeInViewport()
  await bobComposer.fill('I moved the planning into this room.')
  await bobComposer.press('Enter')
  await expect(ada.locator('#chatLog').getByText('I moved the planning into this room.', { exact: true })).toBeVisible()
  await expect(card(ada, 'Order the tea')).toBeVisible()
  const chatHeight = async () => (await bob.locator('#chatViewport').boundingBox())!.height
  const before = await chatHeight()
  const handle = (await divider.boundingBox())!
  await bob.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await bob.mouse.down()
  await bob.mouse.move(handle.x + handle.width / 2, handle.y - 90, { steps: 6 })
  await bob.mouse.up()
  await expect.poll(chatHeight).toBeGreaterThan(before + 50)
  const stretched = await chatHeight()
  await divider.press('ArrowDown')
  await expect.poll(chatHeight).toBeLessThan(stretched)
  const heightPreference = (await divider.getAttribute('aria-valuenow'))!
  await bob.getByRole('button', { name: 'Hide chat', exact: true }).click()
  await expect(bobComposer).toBeHidden()
  await expect(divider).toBeHidden()
  await expect(card(bob, 'Order the tea')).toBeVisible()
  await bob.getByRole('button', { name: 'Show chat', exact: true }).click()
  await expect(divider).toHaveAttribute('aria-valuenow', heightPreference)

  // Both write at the same moment; both cards are kept, on both boards.
  await Promise.all([addCard(ada, 'Print the notices'), addCard(bob, 'Find the urn')])
  for (const page of [ada, bob]) {
    await expect(card(page, 'Print the notices')).toBeVisible()
    await expect(card(page, 'Find the urn')).toBeVisible()
  }

  await bobComposer.fill('Keep this draft.')
  await closeRoomBoard(bob)
  await expect(bobComposer).toHaveValue('Keep this draft.')
  await expect(divider).toBeHidden()

  // Everybody who wrote the board goes. Nobody is left to hand it over.
  await adaContext.close()
  await bobContext.close()

  const cyContext = await newDeviceContext(browser, baseURL!)
  const cy = await cyContext.newPage()
  await enter(cy, url, 'Cy')
  await openRoomBoard(cy)
  for (const title of ['Book the hall', 'Order the tea', 'Print the notices', 'Find the urn']) {
    await expect(card(cy, title)).toBeVisible()
  }
  for (const column of ['To do', 'Doing', 'Done']) {
    await expect(board(cy).getByRole('heading', { name: column, exact: true })).toHaveCount(1)
  }

  // Closed and opened again, and after a reload, it is the same board.
  await closeRoomBoard(cy)
  await expect(cy.locator('#roomBoardPanel')).toBeHidden()
  await openRoomBoard(cy)
  await expect(card(cy, 'Find the urn')).toBeVisible()
  await cy.reload()
  await expect(cy.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
  await openRoomBoard(cy)
  await expect(card(cy, 'Book the hall')).toBeVisible()
  await cyContext.close()
})

test('the room’s board opens from its chat for people with only the link', async ({ browser, baseURL }) => {
  const adaContext = await newDeviceContext(browser, baseURL!)
  const ada = await adaContext.newPage()
  await ada.setViewportSize({ width: 1440, height: 900 })
  const url = await createRoom(ada, baseURL!, testRelaysFor(baseURL!))
  await openRoomBoard(ada)
  await expect(ada.locator('#workspaceWorkPanel')).toBeHidden()
  await expect(ada.locator('#chatInput')).toBeVisible()
  for (const column of ['To do', 'Doing', 'Done']) await expect(board(ada).getByRole('heading', { name: column, exact: true })).toBeVisible()
  await addCard(ada, 'Book the hall')
  await addCard(ada, 'Order the tea')

  const bobContext = await newDeviceContext(browser, baseURL!)
  const bob = await bobContext.newPage()
  await bob.setViewportSize({ width: 1440, height: 900 })
  await enter(bob, url, 'Bob')
  await openRoomBoard(bob)
  await expect(card(bob, 'Book the hall')).toBeVisible()
  const tool = (page: Page, name: string) => board(page).getByRole('button', { name, exact: true })

  // The same cards as a table and on a calendar.
  await tool(bob, 'Table view').click()
  const table = board(bob).getByRole('region', { name: 'Cards table', exact: true })
  await expect(table.getByRole('table')).toContainText('Book the hall')
  await expect(table.getByRole('table')).toContainText('Order the tea')
  await tool(bob, 'Calendar view').click()
  await expect(board(bob).getByRole('region', { name: 'Cards calendar', exact: true })).toBeVisible()
  await tool(bob, 'Board view').click()

  // Filters.
  await tool(bob, 'Filter cards').click()
  const filters = board(bob).getByRole('dialog', { name: 'Filter cards', exact: true })
  await filters.getByRole('searchbox').fill('tea')
  await filters.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await expect(board(bob).getByText('1 matching card')).toBeVisible()
  await expect(card(bob, 'Order the tea')).toBeVisible()
  await expect(card(bob, 'Book the hall')).toHaveCount(0)
  await tool(bob, 'Clear filters').click()
  await expect(card(bob, 'Book the hall')).toBeVisible()

  // An edit says who made it, to the other person, by the name the room knows them by.
  await card(bob, 'Book the hall').click()
  await board(bob).getByRole('combobox', { name: /^Column/ }).selectOption({ label: 'Doing' })
  await expect(board(bob).getByText('Bob moved this from To do to Doing.')).toBeVisible()
  await expect(board(ada).getByRole('list', { name: 'Doing', exact: true }).getByRole('link', { name: 'Book the hall', exact: true })).toBeVisible()
  await card(ada, 'Book the hall').click()
  await expect(board(ada).getByText('Bob moved this from To do to Doing.')).toBeVisible()
  await expect(board(ada).getByRole('combobox', { name: /^Column/ })).toHaveValue('doing')

  // Undo takes back Bob's move and nothing of Ada's, on both boards.
  await board(ada).getByRole('textbox', { name: 'Description', exact: true }).fill('Ring the caretaker first')
  await board(ada).getByRole('textbox', { name: 'Description', exact: true }).blur()
  await expect(board(bob).getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('Ring the caretaker first')
  await tool(bob, 'Back to board').click()
  await tool(bob, 'Undo').click()
  await card(bob, 'Book the hall').click()
  await expect(board(bob).getByRole('combobox', { name: /^Column/ })).toHaveValue('todo')
  await expect(board(ada).getByRole('combobox', { name: /^Column/ })).toHaveValue('todo')
  await expect(board(ada).getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('Ring the caretaker first')

  // Export hands over a file made in the frame.
  await tool(bob, 'Back to board').click()
  const download = bob.waitForEvent('download')
  await tool(bob, 'Export board').click()
  const exporting = board(bob).getByRole('dialog', { name: 'Export this board', exact: true })
  // No bundle of file contents is offered: nothing in the frame can read a
  // card's file, so one could only list every file as missing.
  await expect(exporting.getByRole('button', { name: /bundle/i })).toHaveCount(0)
  await expect(exporting).toContainText('It includes the names of files on cards, not the files.')
  await exporting.getByRole('button', { name: 'Save readable JSON', exact: true }).click()
  const saved = await download
  expect(saved.suggestedFilename()).toBe('girnel-board.json')
  const exported = JSON.parse((await (await saved.createReadStream()).toArray()).join('')) as { cards: Array<{ title: string }> }
  expect(exported.cards.map(entry => entry.title).sort()).toEqual(['Book the hall', 'Order the tea'])
  await exporting.getByRole('button', { name: 'Close', exact: true }).click()

  // A card deleted by one is gone for both.
  await card(bob, 'Book the hall').click()
  await tool(bob, 'Delete card').click()
  await board(bob).getByRole('dialog', { name: 'Delete Book the hall?', exact: true }).getByRole('button', { name: 'Delete card', exact: true }).click()
  await expect(card(bob, 'Book the hall')).toHaveCount(0)
  await expect(card(ada, 'Book the hall')).toHaveCount(0)
  await expect(card(ada, 'Order the tea')).toBeVisible()
  await expect(bob.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.')

  // What the room has and a board alone has not: its invitation, which is
  // how somebody comes to have the board, and its conversation, where a card
  // goes as a draft for the person to finish.
  await tool(bob, 'Invite people').click()
  await expect(bob.locator('#inviteDialog')).toBeVisible()
  await bob.keyboard.press('Escape')
  await expect(bob.locator('#inviteDialog')).toBeHidden()
  await openRoomBoard(bob)
  await card(bob, 'Order the tea').click()
  await tool(bob, 'Discuss in chat').click()
  await expect(bob.locator('#roomArea')).toBeVisible()
  await expect(bob.locator('#chatInput')).toHaveValue('About “Order the tea” on the board: ')
  await expect(bob.locator('#chatInput')).toBeFocused()
  // Reopening the board leads back to the same card.
  await openRoomBoard(bob)
  await expect(board(bob).getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Order the tea')
  // The room's agents are asked through the room's tasks: the task form
  // opens filled in from the card, for the person to choose who and share.
  // A pause to think while typing leaves the description as a draft.
  await card(ada, 'Order the tea').click()
  const description = board(bob).getByRole('textbox', { name: 'Description', exact: true })
  const descriptionActivity = (page: Page) => board(page).getByText('Bob changed the description.', { exact: true })
  await description.click()
  await description.pressSequentially('Enough for ')
  await bob.waitForTimeout(600)
  await expect(descriptionActivity(bob)).toHaveCount(0)
  await description.pressSequentially('forty')
  await bob.waitForTimeout(600)
  await expect(descriptionActivity(bob)).toHaveCount(0)
  await tool(bob, 'Save description').click()
  await expect(board(ada).getByRole('textbox', { name: 'Description', exact: true })).toHaveValue('Enough for forty')
  await expect(descriptionActivity(ada)).toHaveCount(1)

  const checklist = (page: Page) => board(page).getByRole('region', { name: 'Checklist', exact: true })
  const item = 'Confirm the caretaker has the hall keys for Friday'
  const itemInput = checklist(bob).getByRole('textbox', { name: 'New checklist item' })
  await itemInput.fill(item)
  await itemInput.press('Enter')
  await expect(checklist(ada).getByRole('checkbox', { name: item, exact: true })).toBeVisible()
  await checklist(bob).getByRole('checkbox', { name: item, exact: true }).check()
  await expect(checklist(ada).getByRole('checkbox', { name: item, exact: true })).toBeChecked()
  await expect(tool(bob, 'Back to board')).toBeInViewport()
  await tool(bob, 'Back to board').click()
  await expect(card(bob, 'Order the tea')).toBeVisible()
  await card(bob, 'Order the tea').click()

  // The task form is filled in from the saved card.
  await tool(bob, 'Assign to agent').click()
  await expect(bob.locator('#assignmentPanel')).toBeVisible()
  await expect(bob.locator('#assignmentCreate textarea[name="objective"]')).toHaveValue('Order the tea')
  await expect(bob.locator('#assignmentCreate textarea[name="criteria"]')).toHaveValue('Enough for forty')
  await expect(bob.locator('#assignmentPanel')).toContainText('No agent is currently here. Invite an agent to the room before assigning this work.')
  await expect(bob.locator('#roomArea')).toBeVisible()
  await adaContext.close(); await bobContext.close()
})

test('on a phone the board opens from the chat header and returns to the same conversation', async ({ browser, baseURL }) => {
  const context = await newDeviceContext(browser, baseURL!, { viewport: { width: 320, height: 640 }, hasTouch: true })
  const page = await context.newPage()
  await createRoom(page, baseURL!, testRelaysFor(baseURL!))
  // The phone can open the board directly from this room's chat header.
  await expect(page.locator('#railBoards')).toBeHidden()
  await openRoomBoard(page)
  await addCard(page, 'Bring the urn')
  await expect(card(page, 'Bring the urn')).toBeInViewport({ ratio: 0.5 })
  const tools = board(page).getByRole('button', { name: 'Board tools', exact: true })
  const search = board(page).getByRole('button', { name: 'Search', exact: true })
  await expect(search).toBeHidden()
  await tools.click()
  await expect(search).toBeInViewport()
  await tools.press('Escape')
  await expect(search).toBeHidden()
  await expect(page.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.')
  await page.getByRole('slider', { name: 'Chat size' }).fill('24')
  await page.getByRole('button', { name: 'Hide chat', exact: true }).click()
  await page.reload()
  await expect(page.locator('#roomArea')).toBeVisible()
  await openRoomBoard(page)
  await page.getByRole('button', { name: 'Show chat', exact: true }).click()
  await expect(page.getByRole('slider', { name: 'Chat size' })).toHaveValue('24')
  // Nothing of the board is wider than the phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)

  // Back to chat is the conversation and its composer, not the list of chats.
  await closeRoomBoard(page)
  await expect(page.locator('#chatInput')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Room board', exact: true })).toBeFocused()
  await expect(page.locator('#rooms')).toBeHidden()

  // So is Discuss in chat, with the card's title in the draft.
  await openRoomBoard(page)
  await card(page, 'Bring the urn').click()
  await board(page).getByRole('button', { name: 'Discuss in chat', exact: true }).click()
  await expect(page.locator('#roomArea')).toBeVisible()
  await expect(page.locator('#chatInput')).toBeVisible()
  await expect(page.locator('#chatInput')).toHaveValue('About “Bring the urn” on the board: ')
  await expect(page.locator('#rooms')).toBeHidden()
  await context.close()
})

for (const [label, viewport, hasTouch] of [['1440 by 900', { width: 1440, height: 900 }, false], ['390 by 844', { width: 390, height: 844 }, true]] as const) {
  test(`axe finds nothing with the room’s board showing at ${label}`, async ({ browser, baseURL }) => {
    const context = await newDeviceContext(browser, baseURL!, { viewport, hasTouch })
    const page = await context.newPage()
    await createRoom(page, baseURL!, testRelaysFor(baseURL!))
    await openRoomBoard(page)
    await addCard(page, 'Bring the urn')
    await expect(page.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.')
    // The page around the board. What is inside the frame is Girnel's own
    // screen, scanned where Girnel is tested.
    const scan = await new AxeBuilder({ page }).exclude('#roomBoardPanel iframe').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
    expect(scan.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([])
    await context.close()
  })
}

test('another chat is one click from the board, and what is half typed there is not thrown away unasked', async ({ browser, baseURL }) => {
  const context = await newDeviceContext(browser, baseURL!)
  const page = await context.newPage()
  await page.setViewportSize({ width: 1440, height: 900 })
  await createRoom(page, baseURL!, testRelaysFor(baseURL!))
  await createRoom(page, baseURL!, testRelaysFor(baseURL!))
  const other = page.locator('#roomList .open:not([aria-current="true"])')
  await expect(other).toHaveCount(1)
  await openRoomBoard(page)
  const composer = board(page).getByRole('textbox', { name: 'Add a card to To do', exact: true })
  await composer.fill('Half a thought')
  // The other chat, in the list beside the board.
  await other.click()
  const asking = page.locator('#actionDialog')
  await expect(asking).toBeVisible()
  await expect(asking).toContainText('Leave what you were typing on the board?')
  await asking.getByRole('button', { name: 'Stay', exact: true }).click()
  await expect(asking).toBeHidden()
  await expect(composer).toHaveValue('Half a thought')
  await composer.press('Enter')
  await expect(card(page, 'Half a thought')).toBeVisible()
  // With nothing half typed there is nothing to ask, and the other chat's
  // board is its own: this card is not on it.
  await other.click()
  await expect(page.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
  await expect(asking).toBeHidden()
  await openRoomBoard(page)
  await expect(board(page).getByRole('heading', { name: 'To do', exact: true })).toBeVisible()
  await expect(card(page, 'Half a thought')).toHaveCount(0)
  await context.close()
})

/** A file server at the app's own address that keeps each file at its hash,
 *  as a Blossom server does, in front of the acceptance store. What it was
 *  asked to delete is kept in `deleted`. An upload waits for `hold`, when
 *  one is set, so a test can look at the card while a file is on its way. */
async function fileServer(context: BrowserContext, origin: string): Promise<{ uploaded: string[]; deleted: string[]; hold?: Promise<void> }> {
  const seen: { uploaded: string[]; deleted: string[]; hold?: Promise<void> } = { uploaded: [], deleted: [] }
  await context.route(url => url.origin === origin && (url.pathname === '/upload' || /^\/[0-9a-f]{64}$/.test(url.pathname)), async route => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'DELETE') seen.deleted.push(url.pathname.slice(1))
    if (url.pathname === '/upload' && route.request().method() === 'PUT') await seen.hold
    const response = await route.fetch({ url: TEST_RELAY_HTTP + (url.pathname === '/upload' ? '/upload' : '/blossom' + url.pathname), headers: { ...route.request().headers(), origin } })
    if (url.pathname !== '/upload' || !response.ok()) { await route.fulfill({ response }); return }
    const descriptor = await response.json() as { sha256: string; url: string }
    seen.uploaded.push(descriptor.sha256)
    await route.fulfill({ response, json: { ...descriptor, url: `${origin}/${descriptor.sha256}` } })
  })
  return seen
}

test('a file goes onto a card through the room’s own file sharing, somebody else opens it after its sender has gone, and the sender’s tidy-up deletes it', async ({ browser, baseURL, browserName }) => {
  const origin = new URL(baseURL!).origin
  const adaContext = await newDeviceContext(browser, baseURL!)
  const store = await fileServer(adaContext, origin)
  const ada = await adaContext.newPage()
  await ada.setViewportSize({ width: 1440, height: 900 })
  const url = await createRoom(ada, baseURL!, testRelaysFor(baseURL!))
  await openRoomBoard(ada)
  await addCard(ada, 'Floor plan')
  await card(ada, 'Floor plan').click()
  const files = (page: Page) => board(page).locator('.card-files')
  const pick = async (page: Page, name: string, text: string) => {
    const choosing = page.waitForEvent('filechooser')
    await files(page).getByRole('button', { name: 'Add file', exact: true }).click()
    await (await choosing).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })
  }

  // Ada has never sent a file. The card asks her what a chat asks beside
  // Send, in the same words, and until she agrees nothing leaves the device.
  const reached: string[] = []
  await adaContext.route(address => address.origin === DEFAULT_FILE_SERVER, route => { reached.push(route.request().url()); return route.abort() })
  await pick(ada, 'plan.txt', 'Meet at the hall at seven')
  const asking = ada.locator('#actionDialog')
  await expect(asking).toBeVisible()
  await expect(asking).toContainText(`Store files you send on ${new URL(DEFAULT_FILE_SERVER).host}?`)
  await expect(asking).toContainText('Files are encrypted on this device first, so the server can’t open them, but anyone in this chat can.')
  await asking.getByRole('button', { name: 'Not now', exact: true }).click()
  // The file stays on the card, for her only, with the reason and a way to try again.
  const row = files(ada).locator('.file-list li')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('plan.txt')
  // Still where she was looking: the card has not jumped back to its top.
  await expect(row).toBeInViewport()
  await expect(row).toContainText('Not attached. Nothing is uploaded until you have said where files may go.')
  await expect(board(ada).getByText('Ada attached plan.txt.')).toHaveCount(0)
  expect(reached).toEqual([])
  expect(await ada.evaluate(() => localStorage.getItem('kithmoot.file-storage.v1'))).toBeNull()

  // She chooses a server of her own instead. The file she picked is still on
  // the card when she comes back, and Try again sends it without asking.
  await allowTestFileStorage(ada, origin)
  await openRoomBoard(ada)
  let release = (): void => {}
  store.hold = new Promise<void>(resolve => { release = resolve })
  await files(ada).getByRole('button', { name: 'Try again plan.txt', exact: true }).click()
  // While it is going the row says where it has got to, and offers only to stop it.
  await expect(row).toContainText(`Uploading to ${new URL(origin).hostname}…`)
  await expect(row.getByRole('button')).toHaveText(['Remove'])
  release()
  await expect(files(ada).getByRole('button', { name: 'Download plan.txt', exact: true })).toBeVisible()
  await expect(row).toHaveCount(1)
  expect(reached).toEqual([])
  await expect(board(ada).getByText('Ada attached plan.txt.')).toBeVisible()
  await expect(ada.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.')
  expect(store.uploaded).toHaveLength(1)
  // Ada is gone: no page, no connection.
  await ada.goto('about:blank')

  // Bob has only the link. The file's sender is gone; the card still has it.
  const bobContext = await newDeviceContext(browser, baseURL!)
  await fileServer(bobContext, origin)
  const bob = await bobContext.newPage()
  await bob.setViewportSize({ width: 1440, height: 900 })
  await enter(bob, url, 'Bob')
  await openRoomBoard(bob)
  await card(bob, 'Floor plan').click()
  await files(bob).getByRole('button', { name: 'Download plan.txt', exact: true }).click()
  // It opens in the room's own file card: nothing is fetched until asked for.
  const dialog = bob.locator('#boardFileDialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).not.toContainText('Meet at the hall at seven')
  await dialog.getByRole('button', { name: /^Show/ }).click()
  await expect(dialog).toContainText('Meet at the hall at seven')
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toBeHidden()

  // The upload is this room's like any file Ada sent here: when she leaves
  // and asks for what she left to be deleted, it is.
  await enter(ada, url, 'Ada')
  await leaveRoom(ada, { tidy: true })
  await ada.locator('#tidyUpRun').click()
  // The card's upload is among the files this device shared in the room.
  await expect(ada.locator('#tidyUpSteps li[data-step="files"] .tidyResult')).toContainText('Deleted 1 of 1.', { timeout: 60_000 })
  // WebKit sends that request past the test's stand-in file server, so what
  // the server was asked, and the file being gone, are checked in the engines
  // where the stand-in sees it.
  if (browserName !== 'webkit') {
    await expect.poll(() => store.deleted, { timeout: 60_000 }).toEqual(store.uploaded)
    // The card still names the file, and says plainly that it cannot be had.
    await files(bob).getByRole('button', { name: 'Download plan.txt', exact: true }).click()
    await dialog.getByRole('button', { name: /^Show/ }).click()
    await expect(dialog.getByRole('button', { name: /^Try again/ })).toBeVisible()
    await expect(dialog).not.toContainText('Meet at the hall at seven')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  }

  // Taken off the card by somebody else, with a line saying who.
  await files(bob).getByRole('button', { name: 'Remove plan.txt', exact: true }).click()
  await board(bob).getByRole('button', { name: 'Take it off', exact: true }).click()
  await expect(files(bob).locator('.file-list li')).toHaveCount(0)
  await expect(board(bob).getByText('Bob removed plan.txt.')).toBeVisible()
  await bobContext.close(); await adaContext.close()
})

/** A still PNG of one grey colour, carrying a text chunk: what a camera or an editor leaves in a file. */
function pictureWithNote(width: number, height: number, note: string): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const check = Buffer.alloc(4); check.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, check])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7f)])))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
    chunk('tEXt', Buffer.from(`Comment\0${note}`, 'latin1')), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

test('a picture on a card gives one size: the cleaned file’s, on the card, before it is opened and after', async ({ browser, baseURL }) => {
  const origin = new URL(baseURL!).origin
  const adaContext = await newDeviceContext(browser, baseURL!)
  await fileServer(adaContext, origin)
  const ada = await adaContext.newPage()
  await ada.setViewportSize({ width: 1440, height: 900 })
  await createRoom(ada, baseURL!, testRelaysFor(baseURL!))
  await allowTestFileStorage(ada, origin)
  await openRoomBoard(ada)
  await addCard(ada, 'Hall photo')
  await card(ada, 'Hall photo').click()
  const files = board(ada).locator('.card-files')
  const picked = pictureWithNote(48, 32, 'Taken in the hall, with the camera’s notes')
  const choosing = ada.waitForEvent('filechooser')
  await files.getByRole('button', { name: 'Add file', exact: true }).click()
  await (await choosing).setFiles({ name: 'hall.png', mimeType: 'image/png', buffer: picked })
  await expect(files.getByRole('button', { name: 'Download hall.png', exact: true })).toBeVisible({ timeout: 60_000 })
  // Its metadata is taken off on this device before it is sealed, so what goes up is not what was picked.
  const stated = Number(/(\d+) bytes/.exec(await files.locator('.file-list li').innerText())?.[1])
  expect(stated).toBeGreaterThan(0)
  expect(stated).not.toBe(picked.length)
  await files.getByRole('button', { name: 'Download hall.png', exact: true }).click()
  const dialog = ada.locator('#boardFileDialog')
  await expect(dialog).toBeVisible()
  // Not the padded size of its sealed copy.
  await expect(dialog).toContainText(`· ${stated} B`)
  await dialog.getByRole('button', { name: /^Show/ }).click()
  await expect(dialog.locator('iframe.attachmentPreviewFrame')).toBeVisible({ timeout: 60_000 })
  await expect(dialog).toContainText(`· ${stated} B`)
  await adaContext.close()
})

test('a card written with the relay unreachable is kept, and sent when it is back', async ({ browser, baseURL }) => {
  const adaContext = await newDeviceContext(browser, baseURL!)
  // Ada's line to the relay, with a switch on it. A browser's own "offline"
  // setting does not cut a socket that is already open in every engine, so
  // the line itself is what goes quiet: nothing passes either way.
  const relay = new URL('/__test-relay', baseURL)
  relay.protocol = 'wss:'
  let cut = false
  await adaContext.routeWebSocket(relay.href, ws => {
    const upstream = ws.connectToServer()
    ws.onMessage(frame => { if (!cut) upstream.send(frame) })
    upstream.onMessage(frame => { if (!cut) ws.send(frame) })
  })
  const ada = await adaContext.newPage()
  const url = await createRoom(ada, baseURL!, testRelaysFor(baseURL!))
  const bobContext = await newDeviceContext(browser, baseURL!)
  const bob = await bobContext.newPage()
  await enter(bob, url, 'Bob')
  await openRoomBoard(ada)
  await openRoomBoard(bob)
  await addCard(ada, 'Before the tunnel')
  await expect(card(bob, 'Before the tunnel')).toBeVisible()

  cut = true
  await addCard(ada, 'Written in the tunnel')
  await expect(ada.locator('#roomBoardStatus')).toContainText('kept on this device', { timeout: 90_000 })
  await expect(card(bob, 'Written in the tunnel')).toHaveCount(0)

  cut = false
  await expect(card(bob, 'Written in the tunnel')).toBeVisible({ timeout: 120_000 })
  await expect(ada.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.', { timeout: 120_000 })
  await adaContext.close()
  await bobContext.close()
})

test('the board follows the room through a removal, with nobody in charge of handing it over', async ({ browser, baseURL }) => {
  // A keeper that never opens the board until the end: it can remove a
  // member, which is all it is here for, and it holds no copy to hand on.
  const keeper = await RoomAgent.create({ base: baseURL!, name: 'Keeper', roomName: 'Committee', agent: false, ...agentRelaysFor(baseURL!) })
  const contexts = await Promise.all([1, 2, 3].map(() => newDeviceContext(browser, baseURL!)))
  try {
    const [ada, bob, cy] = await Promise.all(contexts.map(context => context.newPage()))
    await enter(ada!, keeper.url, 'Ada')
    await enter(bob!, keeper.url, 'Bob')
    await enter(cy!, keeper.url, 'Cy')
    for (const page of [ada!, bob!, cy!]) await openRoomBoard(page)
    await addCard(cy!, 'Cy wrote this while a member')
    await expect(card(ada!, 'Cy wrote this while a member')).toBeVisible()
    await expect(card(bob!, 'Cy wrote this while a member')).toBeVisible()
    await expect(cy!.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.')

    await expect.poll(() => keeper.roster().find(person => person.name === 'Cy')?.participant).toBeTruthy()
    await keeper.remove(keeper.roster().find(person => person.name === 'Cy')!.participant)
    expect(keeper.session.epoch).toBe(1)

    // Those who stay go on sharing the board in the new epoch.
    await addCard(ada!, 'Agreed after Cy left')
    await expect(card(bob!, 'Agreed after Cy left')).toBeVisible({ timeout: 90_000 })
    await expect(ada!.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.', { timeout: 90_000 })
    // Cy is put out of the room, and the board goes with the room.
    await expect(cy!.getByText('You were removed from this room.')).toBeVisible()
    await expect(cy!.locator('#roomBoardPanel')).toBeHidden()
    await expect(cy!.locator('#roomBoardPanel iframe')).toHaveCount(0)

    // The keeper opens the board for the first time, knowing only the new
    // epoch's stream. What was written before the rekey is there, by the
    // author who has gone: the browsers that stayed handed it over.
    const log = await keeper.session.board(memoryRoomBoardStorage())
    const titles = () => [...log.doc.getMap('records').values()].map(record => (record as Y.Map<unknown>).get('title')).sort()
    await expect.poll(titles, { timeout: 60_000 }).toEqual(['Agreed after Cy left', 'Cy wrote this while a member'])
    expect([...log.doc.getMap('columns').keys()].sort()).toEqual(['doing', 'done', 'todo'])
  } finally {
    await keeper.leave()
    await Promise.all(contexts.map(context => context.close()))
  }
})

test('two tabs of one browser in one room share the board and one saved copy', async ({ browser, baseURL }) => {
  const context = await newDeviceContext(browser, baseURL!)
  const one = await context.newPage()
  const url = await createRoom(one, baseURL!, testRelaysFor(baseURL!))
  await openRoomBoard(one)
  await addCard(one, 'From the first tab')

  // The same person, the same browser, the same room, in a second tab.
  const two = await context.newPage()
  await two.goto(url)
  await expect(two.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
  await openRoomBoard(two)
  await expect(card(two, 'From the first tab')).toBeVisible()

  // Both write, a good many times, into the one copy the browser keeps.
  for (let i = 0; i < 20; i++) {
    await addCard(one, `One ${i}`)
    await addCard(two, `Two ${i}`)
  }
  await expect(card(two, 'One 19')).toBeVisible()
  await expect(card(one, 'Two 19')).toBeVisible()
  for (const page of [one, two]) await expect(page.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.')
  const kept = await keptRecords(one)
  expect(kept.length).toBeGreaterThan(0)
  // Every record is named for what it holds; there is no head for two tabs to disagree about.
  expect(kept.every(key => /\.r\.[0-9a-f]{64}$/.test(key))).toBe(true)

  // Reloaded, each tab opens the whole board from that copy with nothing wrong with it.
  for (const page of [one, two]) {
    await page.reload()
    await expect(page.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    await openRoomBoard(page)
    for (const title of ['From the first tab', 'One 0', 'One 19', 'Two 0', 'Two 19']) await expect(card(page, title)).toBeVisible()
    await expect(page.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.')
  }
  await context.close()
})

test('forgetting a room removes this browser\u2019s copy of its board, and nothing written later brings it back', async ({ browser, baseURL }) => {
  const context = await newDeviceContext(browser, baseURL!)
  const page = await context.newPage()
  const url = await createRoom(page, baseURL!, testRelaysFor(baseURL!))
  await openRoomBoard(page)
  await addCard(page, 'Gone with the room')
  await expect(page.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.')
  await expect.poll(async () => (await keptRecords(page)).length).toBeGreaterThan(0)
  await closeRoomBoard(page)
  // Somebody else is in the room and goes on using its board afterwards.
  const bobContext = await newDeviceContext(browser, baseURL!)
  const bob = await bobContext.newPage()
  await enter(bob, url, 'Bob')
  await openRoomBoard(bob)
  await expect(card(bob, 'Gone with the room')).toBeVisible()

  await leaveToChats(page)
  await page.locator('#roomList .rowMenu').first().click()
  await page.getByRole('menu', { name: /More for/ }).getByRole('menuitem', { name: 'Forget this room', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Forget room', exact: true }).click()
  await expect.poll(async () => (await keptRecords(page)).length).toBe(0)

  await addCard(bob, 'Written after it was forgotten')
  await expect(bob.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.')
  // Long enough for a board still listening here to have saved it.
  await page.waitForTimeout(4_000)
  expect(await keptRecords(page)).toEqual([])
  await context.close()
  await bobContext.close()
})
