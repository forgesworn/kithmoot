import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateRoomSecret } from '../../src/room.js'
import { encodeRoomLink } from '../../src/link.js'
import { openRoomUrl } from '../../test/relays.js'
import { stopIsolatedApp } from './isolated-app.mjs'
import { HOME } from '../policy.mjs'

// The room's own board in the real desktop app: two copies of the app, each
// with a profile of its own and a visitor with only the room's link. The
// board is read from the second, who arrived after the card was written.

const desktop = fileURLToPath(new URL('../', import.meta.url))
const relay = 'ws://127.0.0.1:17777'
const executablePath = process.env.ELECTRON_EXECUTABLE ?? join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')

interface Person { app: ElectronApplication; page: Page; profile: string; errors: string[] }

async function person(name: string, link: string): Promise<Person> {
  const profile = await mkdtemp(join(tmpdir(), 'kithmoot-room-board-'))
  const app = await electron.launch({ executablePath, args: [desktop], env: { ...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile } })
  const context = app.context()
  // The room's relay is the local fixture; nothing else is reached.
  await context.routeWebSocket(url => url.href !== relay + '/', socket => socket.close())
  await context.routeWebSocket(relay, socket => { socket.connectToServer() })
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 860))
  await page.addInitScript(relay => {
    localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: [{ url: relay, read: true, write: true }] }))
  }, relay)
  await openRoomUrl(page, link)
  await page.locator('#displayName').fill(name)
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible()
  return { app, page, profile, errors }
}

const board = (page: Page) => page.frameLocator('#roomBoardPanel iframe')
const card = (page: Page, title: string) => board(page).getByRole('link', { name: title, exact: true })

test('the desktop app opens the room’s board from Boards, two people share it, and export saves a file', async ({}, info) => {
  const link = encodeRoomLink(HOME, { secret: generateRoomSecret(), name: 'Hall committee', relays: [relay], iceUrls: [] })
  const people: Person[] = []
  try {
    const ada = await person('Ada', link)
    people.push(ada)
    // One click from the rail, with no account: the first tab is the room's.
    await ada.page.locator('#railBoards').click()
    await expect(ada.page.locator('#workspaceRoomTab')).toHaveAttribute('aria-pressed', 'true')
    await expect(ada.page.locator('#workspaceRoomTab')).toHaveText('Hall committee')
    await expect(board(ada.page).getByRole('heading', { name: 'To do', exact: true })).toBeVisible()
    const composer = board(ada.page).getByRole('textbox', { name: 'Add a card to To do', exact: true })
    await composer.fill('Book the hall')
    await composer.press('Enter')
    await expect(card(ada.page, 'Book the hall')).toBeVisible()
    await expect(ada.page.locator('#roomBoardStatus')).toHaveText('Shared with everyone in this room.')

    // Bob arrives afterwards, in another copy of the app, and finds it.
    const bob = await person('Bob', link)
    people.push(bob)
    await bob.page.locator('#railBoards').click()
    await expect(card(bob.page, 'Book the hall')).toBeVisible()
    // The frame is an ordinary sandboxed page: no Node, no service worker.
    const frame = await board(bob.page).locator('#app').evaluate(async () => ({
      secure: isSecureContext, node: typeof (window as typeof window & { require?: unknown }).require,
      workers: (await navigator.serviceWorker.getRegistrations()).length,
    }))
    expect(frame).toEqual({ secure: true, node: 'undefined', workers: 0 })

    // He moves it; she sees who did.
    await card(bob.page, 'Book the hall').click()
    await board(bob.page).getByRole('combobox', { name: /^Column/ }).selectOption({ label: 'Doing' })
    await card(ada.page, 'Book the hall').click()
    await expect(board(ada.page).getByText('Bob moved this from To do to Doing.')).toBeVisible()

    // Export hands the app a file made in the frame. The app would ask where
    // to put it; the test answers for the person.
    const saved = join(bob.profile, 'girnel-board.json')
    await bob.app.evaluate(({ BrowserWindow }, path) => {
      BrowserWindow.getAllWindows()[0]!.webContents.session.on('will-download', (_event: unknown, item: { setSavePath(to: string): void }) => { item.setSavePath(path) })
    }, saved)
    await board(bob.page).getByRole('button', { name: 'Export board', exact: true }).click()
    await board(bob.page).getByRole('dialog', { name: 'Export this board', exact: true }).getByRole('button', { name: 'Save readable JSON', exact: true }).click()
    await expect.poll(async () => {
      try { return (JSON.parse(await readFile(saved, 'utf8')) as { cards: Array<{ title: string }> }).cards.map(entry => entry.title) } catch { return null }
    }).toEqual(['Book the hall'])

    await info.attach('the board in the desktop app', { path: await bob.page.screenshot({ path: info.outputPath('desktop-room-board.png') }).then(() => info.outputPath('desktop-room-board.png')) })
    // Back to the conversation, with the room as it was.
    await bob.page.locator('#roomBoardBack').click()
    await expect(bob.page.locator('#roomArea')).toBeVisible()
    await expect(bob.page.locator('#roomBoardPanel')).toBeHidden()
    for (const each of people) expect(each.errors).toEqual([])
  } finally {
    for (const each of people) { await stopIsolatedApp(each.app, each.profile); await rm(each.profile, { recursive: true, force: true }) }
  }
})
