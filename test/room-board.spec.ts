import { test, expect, type Page } from '@playwright/test'
import type * as Y from 'yjs'
import { RoomAgent } from '../src/agent.js'
import { memoryRoomBoardStorage } from '../src/room-board-wire.js'
import { createRoom, join, leaveToChats, newDeviceContext, open, openRoomBoard } from './browser.js'
import { agentRelaysFor, testRelaysFor } from './relays.js'

// The room's own board, walked the way people meet it: nobody creates it,
// shares it or joins it. Each person here is a visitor with a name and the
// room's link, with no Nostr account, and each has a browser of their own.
// The board is asserted from the LAST arrival, after the people who wrote
// it have gone: a board that only its author can see proves nothing.

const board = (page: Page) => page.frameLocator('#roomBoardPanel iframe')
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

  // A room nobody has put anything on keeps its screen for the conversation:
  // no tab yet, and the board one step away in the room's menu.
  await expect(ada.locator('#conversationNav button[data-board]')).toHaveCount(0)
  await openRoomBoard(ada)
  for (const column of ['To do', 'Doing', 'Done']) {
    await expect(board(ada).getByRole('heading', { name: column, exact: true })).toBeVisible()
  }
  await expect(board(ada).getByText('On this device only')).toHaveCount(0)
  await addCard(ada, 'Book the hall')
  await expect(ada.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.')
  // Now that something is on it, the room has a Board tab.
  await ada.locator('#roomBoardClose').click()
  await expect(ada.locator('#conversationNav button[data-board]')).toBeVisible()
  await openRoomBoard(ada)

  // Bob has only the link and a name. The board is simply there, and its
  // tab with it, before he has opened anything.
  const bobContext = await newDeviceContext(browser, baseURL!)
  const bob = await bobContext.newPage()
  await enter(bob, url, 'Bob')
  await expect(bob.locator('#conversationNav button[data-board]')).toBeVisible()
  await bob.locator('#conversationNav button[data-board]').click()
  await expect(bob.locator('#roomBoardPanel')).toBeVisible()
  await expect(card(bob, 'Book the hall')).toBeVisible()
  await expect(board(bob).getByRole('heading', { name: 'To do', exact: true })).toHaveCount(1)

  // What Bob adds reaches Ada's open board without her doing anything.
  await addCard(bob, 'Order the tea')
  await expect(card(ada, 'Order the tea')).toBeVisible()
  await expect(bob.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.')

  // Both write at the same moment; both cards are kept, on both boards.
  await Promise.all([addCard(ada, 'Print the notices'), addCard(bob, 'Find the urn')])
  for (const page of [ada, bob]) {
    await expect(card(page, 'Print the notices')).toBeVisible()
    await expect(card(page, 'Find the urn')).toBeVisible()
  }

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
  await cy.locator('#roomBoardClose').click()
  await expect(cy.locator('#roomBoardPanel')).toBeHidden()
  await openRoomBoard(cy)
  await expect(card(cy, 'Find the urn')).toBeVisible()
  await cy.reload()
  await expect(cy.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
  await openRoomBoard(cy)
  await expect(card(cy, 'Book the hall')).toBeVisible()
  await cyContext.close()
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
  await page.locator('#roomBoardClose').click()
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
