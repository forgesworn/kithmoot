import {test, expect, type Browser, type BrowserContext, type Frame, type Page} from '@playwright/test'
import {generateSecretKey, getPublicKey, finalizeEvent} from 'nostr-tools/pure'
import {encrypt, decrypt, getConversationKey} from 'nostr-tools/nip44'
import {RoomAgent} from '../src/agent.js'
import {decodeRoomBoard, ROOM_BOARDS_CHANNEL} from '../src/room-boards.js'
import {agentRelaysFor, TEST_RELAY_HTTP} from './relays.js'
import {npubEncode} from 'nostr-tools/nip19'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {resolve, extname} from 'node:path'
import { turnOnMedia, leaveToChats, openProjects, openBoardsPanel, openRoomBoards, openSettings, closeSettings } from './browser.js'

async function offlineRelease() {
  // HTTP loopback is secure for workers without weakening TLS in the browser.
  const root = resolve('app/dist')
  const caddy = await readFile('deploy/Caddyfile.kithmoot', 'utf8')
  const mainPolicy = caddy.match(/header @app \{[\s\S]*?Content-Security-Policy "([^"]+)"/)![1]!
  const boardPolicy = caddy.match(/header @boards \{[\s\S]*?Content-Security-Policy "([^"]+)"/)![1]!
  const mime: Record<string, string> = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png'}
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://localhost'), file = resolve(root, url.pathname.replace(/^\/j\//, '') || 'index.html')
      if (!url.pathname.startsWith('/j/') || !file.startsWith(root + '/')) {res.writeHead(404).end(); return}
      const body = await readFile(file)
      res.writeHead(200, {'content-type': mime[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'content-security-policy': url.pathname.startsWith('/j/girnel/') ? boardPolicy : mainPolicy}); res.end(body)
    } catch {res.writeHead(404).end()}
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  let closed = false
  return {base: `http://127.0.0.1:${(server.address() as {port: number}).port}/j/`, close: async () => {if (closed) return; closed = true; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))}}
}
async function device(browser: Browser, base: string, offline = false): Promise<{context: BrowserContext; page: Page; pubkey: string}> {
  const context = await browser.newContext({ignoreHTTPSErrors: true, serviceWorkers: offline ? 'allow' : 'block'})
  const secret = generateSecretKey(), pubkey = getPublicKey(secret), relay = new URL('/__test-relay', base); relay.protocol = 'wss:'
  await context.exposeFunction('boardsKey', () => pubkey)
  await context.exposeFunction('boardsSign', (event: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(event, secret))
  await context.exposeFunction('boardsEncrypt', (peer: string, text: string) => encrypt(text, getConversationKey(secret, peer)))
  await context.exposeFunction('boardsDecrypt', (peer: string, text: string) => decrypt(text, getConversationKey(secret, peer)))
  await context.addInitScript(relay => {
    const host = window as typeof window & {boardsKey(): Promise<string>; boardsSign(event: unknown): Promise<unknown>; boardsEncrypt(peer: string, text: string): Promise<string>; boardsDecrypt(peer: string, text: string): Promise<string>}
    Object.defineProperty(window, 'nostr', {configurable: true, value: {
      getPublicKey: () => host.boardsKey(), signEvent: (event: unknown) => host.boardsSign(event),
      nip44: {encrypt: (peer: string, text: string) => host.boardsEncrypt(peer, text), decrypt: (peer: string, text: string) => host.boardsDecrypt(peer, text)},
    }})
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        const known = ['wss://nostr.mom', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es', 'wss://relay.damus.io', 'wss://nostr.oxtr.dev', 'wss://relay.nostr.net']
        if (!known.includes(String(url).replace(/\/$/, '')) && String(url) !== relay) throw new Error('External relay refused by board acceptance')
        super(relay, protocols)
      }
    }
  }, relay.href)
  await context.route(/^https:\/\/(relay\.damus\.io|nos\.lol|relay\.primal\.net|nostr\.oxtr\.dev|relay\.nostr\.net)\/?$/, route => route.fulfill({status: 200, contentType: 'application/nostr+json', body: JSON.stringify({limitation: {max_message_length: 131072}})}))
  await context.route('**/turn', route => route.fulfill({status: 503, body: ''}))
  await context.route('https://board-files.test/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname === '/upload' ? '/upload' : '/blossom' + url.pathname
    const response = await route.fetch({url: TEST_RELAY_HTTP + path, headers: {...route.request().headers(), origin: 'https://board-files.test'}})
    if (url.pathname === '/upload' && response.ok()) {
      const descriptor = await response.json(); descriptor.url = `https://board-files.test/${descriptor.sha256}`
      await route.fulfill({response, json: descriptor})
    } else await route.fulfill({response})
  })
  const page = await context.newPage()
  await page.goto(base + '?signin=nostr')
  await page.getByRole('button', {name: /Browser extension/}).click()
  await expect(page.locator('#homeSignIn')).toBeHidden()
  return {context, page, pubkey}
}
async function openBoards(page: Page): Promise<Frame> {
  // Loading the module does not finish restoring the saved account. The
  // sign-in button is also hidden while restore is pending, so it cannot
  // establish the account this board journey requires. Settings is closed;
  // inspect its sign-out control's state rather than ancestor visibility.
  await expect(page.locator('html')).toHaveAttribute('data-ordinary-startup', 'ready')
  await expect(page.locator('#signOut')).toHaveJSProperty('hidden', false)
  await openBoardsPanel(page)
  await expect(page.locator('#boardsPanel')).toBeVisible()
  await expect(page.locator('#boardsPanel iframe')).toBeVisible()
  // Locator.contentFrame returns a FrameLocator in current Playwright; obtain
  // the actual frame for deliberate route changes in the invitation journey.
  const handle = await page.locator('#boardsPanel iframe').elementHandle()
  return (await handle!.contentFrame())!
}
async function createBoard(frame: Frame, name: string) {
  await expect(frame.locator('#app')).not.toContainText('Opening board…')
  const reminder = frame.getByRole('button', {name: 'Not yet, remind me', exact: true})
  await expect(reminder.or(frame.getByRole('link', {name: /^Create (a )?board$/})).first()).toBeVisible()
  if (await reminder.isVisible()) await reminder.click()
  await frame.getByRole('link', {name: /^Create (a )?board$/}).click()
  await frame.getByRole('textbox', {name: 'Board name', exact: true}).fill(name)
  const inRoom = await frame.getByText(/^This board will be shared with /).count()
  await frame.getByRole('button', {name: 'Create board', exact: true}).click()
  await expect(frame.getByRole('heading', {name, exact: true})).toBeVisible()
  if (inRoom) {
    const share = frame.getByRole('dialog', {name: new RegExp(`^Share ${name} with `)})
    await expect(share).toBeVisible()
    const server = share.getByLabel('Add a file server', {exact: true})
    if (await server.isVisible()) {await server.fill('https://board-files.test/'); await share.getByRole('button', {name: 'Add file server', exact: true}).click()}
    await expect(share.getByText(/^Shared with .+ People in the chat/)).toBeVisible({timeout: 60000})
    await share.getByRole('button', {name: 'Close', exact: true}).click()
  }
}
async function addCard(frame: Frame, text: string) {
  const composer = frame.getByRole('textbox', {name: 'Add a card to To do', exact: true})
  await composer.fill(text); await composer.press('Enter')
  await expect(frame.getByRole('link', {name: text, exact: true})).toBeVisible()
}

test('boards created in a chat are discovered on another device and edited together without copying an invitation', async ({browser, baseURL}) => {
  const ada = await device(browser, baseURL!), bo = await device(browser, baseURL!), outsider = await device(browser, baseURL!)
  const keeper = await RoomAgent.create({base: baseURL!, name: 'Keeper', roomName: 'Shared board room', agent: false, ...agentRelaysFor(baseURL!)})
  const enter = async (who: typeof ada, name: string) => {
    await who.page.evaluate(({pubkey, room}) => localStorage.setItem(`kithmoot.account.${pubkey}.kithmoot.room.${room.roomId}`, JSON.stringify(room)), {pubkey: who.pubkey, room: {roomId: keeper.roomId, name: 'Shared board room', link: keeper.url, openedAt: 1, readAt: 0}})
    await who.page.reload()
    await who.page.locator('#roomList').getByRole('button', {name: 'Open Shared board room', exact: true}).click()
    if (await who.page.locator('#join').isVisible()) {await who.page.locator('#displayName').fill(name); await who.page.locator('#join').click()}
    await expect(who.page.locator('#chatInput')).toBeEditable()
    // Editability alone also passes under the hidden/inert room while its
    // join is pending. Wait for the completed switch before toolbar input.
    await expect(who.page.locator('#roomArea')).toBeVisible()
    await expect(who.page.locator('#roomArea')).toHaveJSProperty('inert', false)
  }
  try {
    // Keep the second person offline until the board has been created/shared.
    await enter(ada, 'Ada')
    await openRoomBoards(ada.page)
    const owner = (await (await ada.page.locator('#boardsPanel iframe').elementHandle())!.contentFrame())!
    await createBoard(owner, 'Room delivery')
    await addCard(owner, 'Shared from the start')
    await expect.poll(() => keeper.session.channel(ROOM_BOARDS_CHANNEL).messages().some(message => decodeRoomBoard(message.text)?.op === 'share')).toBe(true)
    await enter(bo, 'Bo')
    await bo.page.locator('#roomBoards').getByRole('button', {name: 'Room delivery', exact: true}).click()
    let guest = (await (await bo.page.locator('#boardsPanel iframe').elementHandle())!.contentFrame())!
    const reminder = guest.getByRole('button', {name: 'Not yet, remind me', exact: true})
    await expect(reminder.or(guest.getByRole('button', {name: /^Join (?:board|Room delivery)$/})).first()).toBeVisible()
    if (await reminder.isVisible()) await reminder.click()
    await guest.getByRole('button', {name: /^Join (?:board|Room delivery)$/}).click()
    await expect(guest.getByRole('link', {name: 'Shared from the start', exact: true})).toBeVisible({timeout: 60000})
    await addCard(guest, 'Bo edits the room board')
    await expect(owner.getByRole('link', {name: 'Bo edits the room board', exact: true})).toBeVisible({timeout: 60000})
    const catalogue = await bo.page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('kithmoot.room-boards.v1.')).map(([, value]) => value))
    expect(catalogue.length).toBeGreaterThan(0)
    expect(catalogue.join('')).not.toContain('Room delivery')
    expect(catalogue.join('')).not.toContain('invitation')
    await bo.page.locator('#boardsClose').click(); await bo.page.reload()
    const openRoom = bo.page.locator('#roomList').getByRole('button', {name: 'Open Shared board room', exact: true})
    const joinRoom = bo.page.locator('#join')
    const room = bo.page.locator('#roomArea')
    await expect.poll(async () => await openRoom.isVisible() || await joinRoom.isVisible() || await room.isVisible()).toBe(true)
    if (await openRoom.isVisible()) await openRoom.click()
    await expect.poll(async () => await joinRoom.isVisible() || await room.isVisible()).toBe(true)
    if (await joinRoom.isVisible()) {await bo.page.locator('#displayName').fill('Bo'); await joinRoom.click()}
    await expect(room).toBeVisible()
    await expect(room).toHaveJSProperty('inert', false)
    await bo.page.locator('#roomBoards').getByRole('button', {name: 'Room delivery', exact: true}).click()
    guest = (await (await bo.page.locator('#boardsPanel iframe').elementHandle())!.contentFrame())!
    const join = guest.getByRole('button', {name: /^Join (?:board|Room delivery)$/}); if (await join.isVisible()) await join.click()
    await expect(guest.getByRole('link', {name: 'Bo edits the room board', exact: true})).toBeVisible({timeout: 60000})
    await openBoards(outsider.page)
    await expect(outsider.page.locator('#boardsSaved')).not.toContainText('Room delivery')
  } finally {await keeper.leave(); await ada.context.close(); await bo.context.close(); await outsider.context.close()}
})

test('call attribution stays below board shortcuts created during a desktop call', async ({browser, baseURL}, info) => {
  test.skip(!['chromium', 'chromium-desktop'].includes(info.project.name), 'Synthetic media needs Chromium')
  const ada = await device(browser, baseURL!)
  const keeper = await RoomAgent.create({base: baseURL!, name: 'Keeper', roomName: 'Private: Test contact', agent: false, ...agentRelaysFor(baseURL!)})
  try {
    await ada.page.setViewportSize({width: 1440, height: 900})
    await ada.page.evaluate(({pubkey, room}) => localStorage.setItem(`kithmoot.account.${pubkey}.kithmoot.room.${room.roomId}`, JSON.stringify(room)),
      {pubkey: ada.pubkey, room: {roomId: keeper.roomId, name: 'Private: Test contact', link: keeper.url, openedAt: 1, readAt: 0}})
    await ada.page.reload()
    await ada.page.locator('#roomList').getByRole('button', {name: 'Open Private: Test contact', exact: true}).click()
    if (await ada.page.locator('#join').isVisible()) {await ada.page.locator('#displayName').fill('Ada'); await ada.page.locator('#join').click()}
    await expect(ada.page.locator('#chatInput')).toBeEditable()
    await turnOnMedia(ada.page)
    await expect(ada.page.locator('html')).toHaveAttribute('data-call-first', '')
    await openRoomBoards(ada.page)
    const frame = (await (await ada.page.locator('#boardsPanel iframe').elementHandle())!.contentFrame())!
    await createBoard(frame, 'Private Board')
    await ada.page.locator('#boardsClose').click()
    const board = ada.page.locator('#roomBoards').getByRole('button', {name: 'Private Board', exact: true})
    await expect(board).toBeVisible()
    await expect(ada.page.locator('#callSurfaceOrigin')).toHaveText('Call in Private: Test contact')
    for (const size of [{width: 1440, height: 900}, {width: 1024, height: 768}]) {
      await ada.page.setViewportSize(size)
      for (const fontSize of ['', '200%']) {
        await ada.page.evaluate(fontSize => {document.documentElement.style.fontSize = fontSize}, fontSize)
        await expect.poll(() => ada.page.evaluate(() => {
          const boards = document.getElementById('roomBoards')!.getBoundingClientRect()
          const header = document.getElementById('callSurfaceHeader')!.getBoundingClientRect()
          return header.top >= boards.bottom - 1
        }), {message: 'Call attribution must not overlap the board shortcuts'}).toBe(true)
      }
    }
    await ada.page.evaluate(() => {document.documentElement.style.fontSize = ''})
    await ada.page.screenshot({path: info.outputPath('call-and-private-board.png')})
    await board.click()
    await expect(ada.page.locator('#boardsPanel')).toBeVisible()
    await expect(ada.page.frameLocator('#boardsPanel iframe').getByRole('heading', {name: 'Private Board', exact: true})).toBeVisible()
  } finally {await keeper.leave(); await ada.context.close()}
})

test('card colour saves when the colour label is clicked and survives reopening', async ({browser, baseURL}) => {
  const {context, page} = await device(browser, baseURL!)
  try {
    let frame = await openBoards(page)
    await createBoard(frame, 'Colour regression')
    await addCard(frame, 'Purple card')
    await frame.getByRole('link', {name: 'Purple card', exact: true}).click()
    // Click the label as a person would, rather than setting checked state.
    await frame.locator('fieldset').filter({has: frame.getByText('Note colour', {exact: true})}).getByText('Purple', {exact: true}).click()
    await expect(frame.locator('.detail-note')).toHaveAttribute('data-paper', 'purple')
    await expect(frame.getByRole('radio', {name: 'Purple', exact: true}).first()).toBeChecked()
    await frame.getByRole('radio', {name: 'Blue', exact: true}).first().check()
    await expect(frame.locator('.detail-note')).toHaveAttribute('data-paper', 'blue')
    await frame.getByRole('textbox', {name: 'Title', exact: true}).fill('Purple card renamed')
    const purple = frame.locator('fieldset').filter({has: frame.getByText('Note colour', {exact: true})}).getByText('Purple', {exact: true})
    // Editing the title can replace the label during WebKit's scroll check.
    // Settle only the setup; the delayed click must still exercise blur/save.
    await expect(async () => {
      await purple.scrollIntoViewIfNeeded({ timeout: 1_000 })
      await expect(purple).toBeInViewport({ timeout: 1_000 })
    }).toPass({ timeout: 5_000 })
    // The title's blur saves while the pointer is still activating the label.
    await purple.click({delay: 200})
    await expect(frame.locator('.detail-note')).toHaveAttribute('data-paper', 'purple')
    await page.reload()
    frame = await openBoards(page)
    await frame.getByRole('link', {name: /^Colour regression/}).click()
    await frame.getByRole('link', {name: 'Purple card renamed', exact: true}).click()
    await expect(frame.locator('.detail-note')).toHaveAttribute('data-paper', 'purple')
  } finally {await context.close()}
})

test('an existing private board keeps its cards and is shared only after the explicit room sharing action', async ({browser, baseURL}) => {
  const ada = await device(browser, baseURL!), bo = await device(browser, baseURL!)
  const keeper = await RoomAgent.create({base: baseURL!, name: 'Keeper', roomName: 'Existing board room', agent: false, ...agentRelaysFor(baseURL!)})
  const enter = async (who: typeof ada, name: string) => {
    await who.page.evaluate(({pubkey, room}) => localStorage.setItem(`kithmoot.account.${pubkey}.kithmoot.room.${room.roomId}`, JSON.stringify(room)), {pubkey: who.pubkey, room: {roomId: keeper.roomId, name: 'Existing board room', link: keeper.url, openedAt: 1, readAt: 0}})
    await who.page.reload()
    await who.page.locator('#roomList').getByRole('button', {name: 'Open Existing board room', exact: true}).click()
    if (await who.page.locator('#join').isVisible()) {await who.page.locator('#displayName').fill(name); await who.page.locator('#join').click()}
    await expect(who.page.locator('#chatInput')).toBeEditable()
    await expect(who.page.locator('#roomArea')).toBeVisible()
    await expect(who.page.locator('#roomArea')).toHaveJSProperty('inert', false)
  }
  try {
    let owner = await openBoards(ada.page)
    await createBoard(owner, 'Existing notes'); await addCard(owner, 'Keep my existing card')
    await ada.page.locator('#boardsClose').click()
    await enter(ada, 'Ada')
    await openRoomBoards(ada.page)
    await expect(ada.page.locator('#boardsPanel')).toBeVisible()
    await expect(ada.page.locator('#boardsPanel iframe')).toBeVisible()
    owner = (await (await ada.page.locator('#boardsPanel iframe').elementHandle())!.contentFrame())!
    await owner.getByRole('link', {name: /^Existing notes/}).click()
    await ada.page.locator('#boardsRoom').selectOption({label: 'Existing board room'}); await ada.page.locator('#boardsAssociate').click()
    expect(keeper.session.channel(ROOM_BOARDS_CHANNEL).messages().some(message => decodeRoomBoard(message.text)?.op === 'share')).toBe(false)
    await ada.page.locator('#boardsShareRoom').click()
    const share = owner.getByRole('dialog', {name: 'Share Existing notes with Existing board room', exact: true})
    await share.getByLabel('Add a file server', {exact: true}).fill('https://board-files.test/')
    await share.getByRole('button', {name: 'Add file server', exact: true}).click()
    await expect(share.getByText(/^Shared with Existing board room\. People in the chat/)).toBeVisible({timeout: 60000})
    await share.getByRole('button', {name: 'Close', exact: true}).click()
    await enter(bo, 'Bo')
    await expect(bo.page.locator('#chatLog')).toContainText('Shared board: Existing notes')
    await bo.page.locator('#roomBoards').getByRole('button', {name: 'Existing notes', exact: true}).click()
    const guest = (await (await bo.page.locator('#boardsPanel iframe').elementHandle())!.contentFrame())!
    const reminder = guest.getByRole('button', {name: 'Not yet, remind me', exact: true})
    await expect(reminder.or(guest.getByRole('button', {name: /^Join (?:board|Existing notes)$/})).first()).toBeVisible()
    if (await reminder.isVisible()) await reminder.click()
    await guest.getByRole('button', {name: /^Join (?:board|Existing notes)$/}).click()
    await expect(guest.getByRole('link', {name: 'Keep my existing card', exact: true})).toBeVisible({timeout: 60000})
  } finally {await keeper.leave(); await ada.context.close(); await bo.context.close()}
})

test('a room keeps its board discoverable after popping out, closing the window and reloading', async ({browser, baseURL}, info) => {
  const {context, page, pubkey} = await device(browser, baseURL!)
  const keeper = await RoomAgent.create({base: baseURL!, name: 'Keeper', roomName: 'Board workshop', agent: false, ...agentRelaysFor(baseURL!)})
  try {
    await page.evaluate(({pubkey, room}) => localStorage.setItem(`kithmoot.account.${pubkey}.kithmoot.room.${room.roomId}`, JSON.stringify(room)), {pubkey, room: {roomId: keeper.roomId, name: 'Board workshop', link: keeper.url, openedAt: 1, readAt: 0}})
    await page.reload()
    await page.locator('#roomList').getByRole('button', {name: 'Open Board workshop', exact: true}).click()
    if (await page.locator('#join').isVisible()) {await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()}
    await expect(page.locator('#chatInput')).toBeEditable()
    await page.locator('#chatInput').fill('Keep my room draft')
    await openRoomBoards(page)
    let frame = (await (await page.locator('#boardsPanel iframe').elementHandle())!.contentFrame())!
    await createBoard(frame, 'Workshop board'); await addCard(frame, 'Still here after closing')
    await expect(page.locator('#boardsContext')).toContainText('Board workshop')
    const opening = page.waitForEvent('popup'); await page.locator('#boardsPopOut').click(); const popup = await opening
    await expect(page.locator('#boardsPanel')).toBeHidden()
    await expect(page.locator('#chatInput')).toBeVisible()
    await expect(page.locator('#chatInput')).toBeEditable()
    await expect(page.locator('#chatInput')).toHaveValue('Keep my room draft')
    await expect(page.locator('#roomBoards').getByRole('button', {name: 'Workshop board · Open in window', exact: true})).toBeVisible()
    await popup.close()
    await page.locator('#roomBoards').getByRole('button', {name: 'Workshop board', exact: true}).click()
    frame = (await (await page.locator('#boardsPanel iframe').elementHandle())!.contentFrame())!
    await expect(frame.getByRole('link', {name: 'Still here after closing', exact: true})).toBeVisible()
    await frame.getByRole('link', {name: 'Open me to add a checklist', exact: true}).click()
    await frame.getByRole('button', {name: 'Delete card', exact: true}).click()
    const confirmation = frame.getByRole('dialog', {name: 'Delete Open me to add a checklist?', exact: true})
    await confirmation.press('Escape')
    await expect(frame.locator('.detail-note')).toBeVisible()
    await frame.getByRole('button', {name: 'Delete card', exact: true}).click()
    await confirmation.press('y')
    await expect(frame.getByRole('link', {name: 'Open me to add a checklist', exact: true})).toHaveCount(0)
    await page.locator('#boardsClose').click()
    await page.reload()
    const openRoom = page.locator('#roomList').getByRole('button', {name: 'Open Board workshop', exact: true})
    const join = page.locator('#join')
    const room = page.locator('#roomArea')
    await expect.poll(async () => await openRoom.isVisible() || await join.isVisible() || await room.isVisible()).toBe(true)
    if (await openRoom.isVisible()) await openRoom.click()
    await expect.poll(async () => await join.isVisible() || await room.isVisible()).toBe(true)
    if (await join.isVisible()) {await page.locator('#displayName').fill('Ada'); await join.click()}
    await expect(page.locator('#roomBoards').getByRole('button', {name: 'Workshop board', exact: true})).toBeVisible()
    await page.locator('#roomBoards').getByRole('button', {name: 'Workshop board', exact: true}).click()
    frame = (await (await page.locator('#boardsPanel iframe').elementHandle())!.contentFrame())!
    await expect(frame.getByRole('link', {name: 'Still here after closing', exact: true})).toBeVisible()
    await expect(frame.getByRole('link', {name: 'Open me to add a checklist', exact: true})).toHaveCount(0)
    await page.screenshot({path: info.outputPath('room-board-reopened.png')})
  } finally {await keeper.leave(); await context.close()}
})

test('Boards replaces Work, edits durable cards and opens several independently labelled windows', async ({browser, baseURL}, info) => {
  const {context, page, pubkey} = await device(browser, baseURL!)
  const keepers = await Promise.all(['Design chat', 'Release chat'].map(roomName => RoomAgent.create({base: baseURL!, name: 'Keeper', roomName, agent: false, ...agentRelaysFor(baseURL!)})))
  await page.evaluate(({pubkey, rooms}) => {for (const room of rooms) localStorage.setItem(`kithmoot.account.${pubkey}.kithmoot.room.${room.roomId}`, JSON.stringify(room))}, {pubkey, rooms: keepers.map((k, i) => ({roomId: k.roomId, name: ['Design chat', 'Release chat'][i], link: k.url, openedAt: 1, readAt: 0}))})
  await page.reload()
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  try {
    await openProjects(page)
    for (const [i, name] of ['Design project', 'Release project'].entries()) {
      await page.locator('#sharedProjectNew').click(); await page.locator('#sharedProjectName').fill(name)
      await page.locator('#sharedProjectNpub').fill(npubEncode(keepers[i]!.participant)); await page.locator('#sharedProjectAddPerson').click()
      await page.locator('#sharedProjectRooms').getByRole('checkbox', {name: ['Design chat', 'Release chat'][i], exact: true}).check()
      await page.locator('#sharedProjectSave').click(); await expect(page.locator('#sharedProjectEditor')).toBeHidden()
    }
    await page.locator('#sharedProjectsClose').click()
    await expect(page.locator('#railBoards')).toContainText('Boards')
    let frame = await openBoards(page)
    await createBoard(frame, 'Design board'); await addCard(frame, 'Review the design')
    await page.locator('#boardsProject').selectOption({label: 'Design project'}); await page.locator('#boardsRoom').selectOption({label: 'Design chat'}); await page.locator('#boardsAssociate').click()
    await expect(page.locator('#boardsContext')).toContainText('Design board')
    const firstPopup = page.waitForEvent('popup'); await page.locator('#boardsPopOut').click(); const first = await firstPopup
    await expect(first).toHaveTitle('KithMoot · Design project · Design chat · Design board')
    await expect(first.locator('.boardsContext')).toHaveText('KithMoot · Design project · Design chat · Design board')
    let one = (await (await first.locator('iframe').elementHandle())!.contentFrame())!
    await expect(one.getByRole('heading', {name: 'Design board', exact: true})).toBeVisible()
    await expect.poll(() => first.locator('iframe').evaluate(frame => Math.abs(frame.getBoundingClientRect().width - innerWidth) < 2), {message: 'The popped-out board must fill its window after the host styles load'}).toBe(true).catch(async error => {console.log('Board window bounds', await first.evaluate(() => JSON.stringify({viewport: innerWidth, body: document.body.getBoundingClientRect().toJSON(), frame: document.querySelector('iframe')?.getBoundingClientRect().toJSON(), maxWidth: getComputedStyle(document.body).maxWidth, width: getComputedStyle(document.body).width, padding: getComputedStyle(document.body).padding}))); throw error})
    await expect(page.locator('#boardsPanel')).toBeHidden()
    await openBoardsPanel(page)
    frame = (await (await page.locator('#boardsPanel iframe').elementHandle())!.contentFrame())!
    await createBoard(frame, 'Release board'); await addCard(frame, 'Check release evidence')
    await page.locator('#boardsProject').selectOption({label: 'Release project'}); await page.locator('#boardsRoom').selectOption({label: 'Release chat'}); await page.locator('#boardsAssociate').click()
    const secondPopup = page.waitForEvent('popup'); await page.locator('#boardsPopOut').click(); const second = await secondPopup
    await expect(second).toHaveTitle('KithMoot · Release project · Release chat · Release board')
    await expect(first).toHaveTitle('KithMoot · Design project · Design chat · Design board')
    await expect(page.locator('#boardsPanel')).toBeHidden()
    await openProjects(page)
    await page.locator('.sharedProjectCard').filter({has: page.getByRole('heading', {name: 'Release project', exact: true})}).getByRole('button', {name: 'Release chat', exact: true}).click()
    if (await page.locator('#displayName').isVisible()) {await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()}
    await expect(page.locator('#chatInput')).toBeEditable()
    await page.locator('#chatInput').fill('Keep the release chat draft')
    await expect(first).toHaveTitle('KithMoot · Design project · Design chat · Design board')
    await expect(second).toHaveTitle('KithMoot · Release project · Release chat · Release board')
    await addCard(one, 'Design continues independently')
    await first.reload()
    await expect(first.locator('iframe')).toBeVisible()
    one = (await (await first.locator('iframe').elementHandle())!.contentFrame())!
    await expect(one.getByRole('link', {name: 'Design continues independently', exact: true})).toBeVisible()
    await first.screenshot({path: info.outputPath('design-board-popout.png'), fullPage: true})
    // Firefox can report the intentional popup close before the click settles.
    await first.getByRole('button', {name: 'Return to workspace', exact: true}).click().catch((error: Error) => {
      if (!first.isClosed() || !/has been closed/.test(error.message)) throw error
    })
    await expect.poll(() => first.isClosed()).toBe(true)
    await expect(page.locator('#boardsContext')).toContainText('Design board')
    frame = (await (await page.locator('#boardsPanel iframe').elementHandle())!.contentFrame())!
    await expect(frame.getByRole('link', {name: 'Design continues independently', exact: true})).toBeVisible()
    await frame.getByRole('link', {name: 'Review the design', exact: true}).click()
    await frame.getByRole('button', {name: 'Discuss in chat', exact: true}).click()
    await expect(page.locator('#chatInput')).toHaveValue(/Review the design\nhttps:.*#\/b\/.*\/c\//)
    expect(keepers[0]!.chat.messages().some(message => message.text?.includes('Review the design'))).toBe(false)
    await page.locator('#chatInput').fill('')
    await openProjects(page)
    await page.locator('.sharedProjectCard').filter({has: page.getByRole('heading', {name: 'Release project', exact: true})}).getByRole('button', {name: 'Release chat', exact: true}).click()
    await expect(page.locator('#chatInput')).toHaveValue('Keep the release chat draft')
    await page.locator('#chatInput').fill('')
    await expect(page.locator('#appHome')).toHaveAttribute('aria-disabled', 'false')
    await leaveToChats(page)
    await openSettings(page, 'Account'); await page.locator('#signOut').click()
    await expect.poll(() => second.isClosed()).toBe(true)
    expect(errors).toEqual([])
  } finally {await context.close(); await Promise.all(keepers.map(k => k.leave()))}
})

test('two independently admitted people edit the same encrypted board and keep drafts through remote changes', async ({browser, baseURL}) => {
  const ada = await device(browser, baseURL!), bo = await device(browser, baseURL!)
  try {
    const owner = await openBoards(ada.page); await createBoard(owner, 'Shared delivery'); await addCard(owner, 'First card')
    await owner.getByRole('button', {name: 'Invite people', exact: true}).click()
    const share = owner.getByRole('dialog', {name: 'Invite people to Shared delivery', exact: true})
    await share.getByRole('textbox', {name: 'Add a file server', exact: true}).fill('https://board-files.test/')
    await share.getByRole('button', {name: 'Add file server', exact: true}).click()
    await expect(share.getByRole('textbox', {name: 'Invite link', exact: true})).toBeVisible()
    const link = await share.getByRole('textbox', {name: 'Invite link', exact: true}).inputValue()
    await share.getByRole('button', {name: 'Close', exact: true}).click()
    await openBoards(bo.page)
    await bo.page.getByRole('button', {name: 'Open board link', exact: true}).click()
    await bo.page.getByLabel('Board invitation or card link', {exact: true}).fill(link)
    await bo.page.getByRole('button', {name: 'Open this board link', exact: true}).click()
    const guest = (await (await bo.page.locator('#boardsPanel iframe').elementHandle())!.contentFrame())!
    await expect(guest.locator('#app')).not.toContainText('Opening board…')
    const reminder = guest.getByRole('button', {name: 'Not yet, remind me', exact: true})
    if (await reminder.isVisible()) await reminder.click()
    await guest.getByRole('button', {name: /Join.*board|Join Shared delivery/}).click()
    await expect(guest.getByRole('link', {name: 'First card', exact: true})).toBeVisible()
    const draft = owner.getByRole('textbox', {name: 'Add a card to To do', exact: true}); await draft.fill('Keep this draft')
    await addCard(guest, 'Bo’s card'); await expect(owner.getByRole('link', {name: 'Bo’s card', exact: true})).toBeVisible()
    await expect(draft).toHaveValue('Keep this draft'); await draft.press('Enter')
    await expect(guest.getByRole('link', {name: 'Keep this draft', exact: true})).toBeVisible()
    await ada.page.reload(); const restored = await openBoards(ada.page)
    await restored.getByRole('link', {name: 'Shared delivery', exact: true}).click()
    await expect(restored.getByRole('link', {name: 'Bo’s card', exact: true})).toBeVisible()
  } finally {await ada.context.close(); await bo.context.close()}
})

test('two agents handle separate cards while a second person edits the shared board, with explicit result approval', async ({browser, baseURL}) => {
  const ada = await device(browser, baseURL!), bo = await device(browser, baseURL!)
  const keeper = await RoomAgent.create({base: baseURL!, roomName: 'Delivery chat', name: 'Keeper', agent: false, ...agentRelaysFor(baseURL!)})
  const workers = await Promise.all(['Design agent', 'Release agent'].map(name => RoomAgent.join({link: keeper.url, name, agent: true, ...agentRelaysFor(baseURL!)})))
  const logs = await Promise.all(workers.map(async worker => {let journal: string | undefined; return worker.session.assignments({load: async () => journal, save: async value => {journal = value}})}))
  const advertise = (i: number) => workers[i]!.sendControl({op: 'catalogue', host: workers[i]!.participant, name: ['Design agent', 'Release agent'][i]!, agents: [{id: 'reviewer', name: ['Design agent', 'Release agent'][i]!, actions: [{id: 'card-review', label: 'Review a card', description: 'Return changes for human review', inputs: []}]}], running: []})
  const stops = workers.map((worker, i) => worker.onPresenceRequest(request => {if (request.op === 'catalogue?') void advertise(i)}))
  try {
    await ada.page.evaluate(({pubkey, room}) => localStorage.setItem(`kithmoot.account.${pubkey}.kithmoot.room.${room.roomId}`, JSON.stringify(room)), {pubkey: ada.pubkey, room: {roomId: keeper.roomId, name: 'Delivery chat', link: keeper.url, openedAt: 1, readAt: 0}})
    await ada.page.reload()
    let owner = await openBoards(ada.page); await createBoard(owner, 'Team delivery')
    await ada.page.locator('#boardsRoom').selectOption({label: 'Delivery chat'}); await ada.page.locator('#boardsAssociate').click()
    for (const title of ['Design task', 'Release task']) await addCard(owner, title)
    await owner.getByRole('button', {name: 'Invite people', exact: true}).click()
    const share = owner.getByRole('dialog', {name: 'Invite people to Team delivery', exact: true})
    await share.getByLabel('Add a file server', {exact: true}).fill('https://board-files.test/')
    await share.getByRole('button', {name: 'Add file server', exact: true}).click()
    const linkField = share.getByLabel('Invite link', {exact: true}); await expect(linkField).toBeVisible()
    const link = await linkField.inputValue(); await share.getByRole('button', {name: 'Close', exact: true}).click()
    await openBoards(bo.page); await bo.page.getByRole('button', {name: 'Open board link', exact: true}).click()
    await bo.page.getByLabel('Board invitation or card link', {exact: true}).fill(link)
    await bo.page.getByRole('button', {name: 'Open this board link', exact: true}).click()
    let guest = (await (await bo.page.locator('#boardsPanel iframe').elementHandle())!.contentFrame())!
    await expect(guest.locator('#app')).not.toContainText('Opening board…')
    const reminder = guest.getByRole('button', {name: 'Not yet, remind me', exact: true}); if (await reminder.isVisible()) await reminder.click()
    await guest.getByRole('button', {name: 'Join board', exact: true}).click()
    await expect(guest.getByRole('link', {name: 'Design task', exact: true})).toBeVisible()
    // The board borrows the person's existing room admission and writer. It
    // must not join another installation just to offer these two cards.
    await ada.page.locator('#boardsClose').click()
    await ada.page.locator('#roomList').getByRole('button', {name: 'Open Delivery chat', exact: true}).click()
    if (await ada.page.locator('#join').isVisible()) {await ada.page.locator('#displayName').fill('Ada'); await ada.page.locator('#join').click()}
    await expect(ada.page.locator('#chatInput')).toBeEditable()
    await openRoomBoards(ada.page)
    await expect.poll(() => keeper.roster().find(person => person.participant === ada.pubkey)?.devices.length).toBe(1)
    const originalDevices = keeper.roster().find(person => person.participant === ada.pubkey)!.devices
    const boardHash = new URL(owner.url()).hash, boardId = boardHash.split('/')[2]!
    // Return through the host's saved-board control. Reloading an embedded
    // document bypasses its move/custody handoff and can retire that view.
    const returnToBoard = async (page: Page): Promise<Frame> => {
      const panel = page.locator('#boardsPanel')
      if (!await panel.isVisible()) {
        const roomBoards = page.locator('#conversationNav button[data-board]')
        if (await roomBoards.isVisible()) {
          await expect(roomBoards).toHaveAttribute('aria-controls', 'boardsPanel')
          await roomBoards.click()
        } else await openBoardsPanel(page)
      }
      await expect(panel).toBeVisible()
      await expect(panel.locator('iframe')).toBeVisible()
      const currentFrame = async (): Promise<Frame | undefined> => {
        const handles = await panel.locator('iframe').elementHandles()
        try {return handles.length === 1 ? await handles[0]!.contentFrame() ?? undefined : undefined}
        finally {await Promise.all(handles.map(handle => handle.dispose()))}
      }
      // A distinct route proves the asynchronous host handoff has completed;
      // an old frame already on this board cannot satisfy that transition.
      await panel.getByRole('button', {name: 'Choose another board', exact: true}).click()
      await expect.poll(async () => {
        const frame = await currentFrame()
        return frame && !frame.isDetached() ? new URL(frame.url()).hash : undefined
      }).toBe('#/')
      const saved = panel.locator(`#boardsSaved button[data-board-id="${boardId}"]`)
      await expect(saved).toBeVisible()
      await saved.click()
      let selected: Frame | undefined
      await expect.poll(async () => {
        const frame = await currentFrame()
        if (!frame || frame.isDetached() || new URL(frame.url()).hash !== boardHash) return false
        try {
          if (!await frame.getByRole('link', {name: 'Design task', exact: true}).isVisible()) return false
        } catch (error) {if (frame.isDetached()) return false; throw error}
        selected = frame
        return true
      }).toBe(true)
      await expect(panel).toBeVisible()
      await expect(panel.locator('iframe')).toBeVisible()
      return selected!
    }
    const connect = async (title: string) => {
      owner = await returnToBoard(ada.page)
      await owner.getByRole('link', {name: title, exact: true}).click()
      await owner.getByRole('button', {name: 'Assign to agent', exact: true}).click()
      const dialog = owner.getByRole('dialog', {name: 'Assign to agent', exact: true})
      await expect(dialog.getByLabel('Chosen room invitation')).toHaveCount(0)
      await dialog.getByText('Sharing details', {exact: true}).click()
      await expect(dialog.getByRole('heading', {name: 'Room audience', exact: true})).toBeVisible()
      await Promise.all(workers.map((_, i) => advertise(i)))
      const audience = dialog.getByRole('heading', {name: 'Room audience', exact: true}).locator('..')
      // Signed presence can arrive after admission. Refresh the actual review
      // surface until both installations are in its current audience.
      await expect.poll(async () => {
        await dialog.getByRole('button', {name: 'Refresh room audience and installations', exact: true}).click()
        await dialog.getByText('Sharing details', {exact: true}).click()
        return [await audience.getByText(/^Design agent .*installation/).isVisible(), await audience.getByText(/^Release agent .*installation/).isVisible()]
      }).toEqual([true, true])
      return dialog
    }
    for (const [i, title] of ['Design task', 'Release task'].entries()) {
      const dialog = await connect(title)
      await expect.poll(async () => {
        await dialog.getByRole('button', {name: 'Refresh room audience and installations', exact: true}).click()
        await expect(dialog).not.toHaveAttribute('aria-busy', 'true')
        await dialog.getByRole('combobox', {name: /^Assign to/}).selectOption(`${workers[i]!.participant}/${workers[i]!.device}`)
        await dialog.getByText('Task details', {exact: true}).click()
        await expect(dialog.getByRole('combobox', {name: /^Agent action/}).locator('option[value="card-review"]')).toHaveCount(1)
        await dialog.getByRole('combobox', {name: /^Agent action/}).selectOption('card-review')
        await dialog.getByLabel('Acceptance criteria shared with the room', {exact: true}).fill('Return a description proposal for review')
        return dialog.getByRole('button', {name: 'Assign to agent', exact: true}).isEnabled()
      }).toBe(true)
      await dialog.getByRole('button', {name: 'Assign to agent', exact: true}).click()
      await expect(dialog.getByText('Room status: offered. Attempt 1.', {exact: true})).toBeVisible()
      await dialog.getByRole('button', {name: 'Close', exact: true}).click()
      await expect(dialog).toHaveCount(0)
      expect(keeper.roster().find(person => person.participant === ada.pubkey)!.devices).toEqual(originalDevices)
    }
    await expect.poll(() => logs[0]!.snapshot().assignments.length).toBe(2)
    await expect.poll(() => logs[1]!.snapshot().assignments.length).toBe(2)
    const tasks = logs.map((log, i) => log.snapshot().assignments.find(task => task.owner === workers[i]!.participant)!)
    await Promise.all(logs.map((log, i) => log.submit(tasks[i]!.id, {op: 'claim', executor: `board-agent-executor-${i}`, next: 'Review the selected card'}, `board-agent-claim-${i}`)))
    expect(logs.map((log, i) => log.snapshot().assignments.find(task => task.id === tasks[i]!.id)?.status)).toEqual(['running', 'running'])
    await addCard(guest, 'Bo edits while agents work')
    owner = await returnToBoard(ada.page)
    await expect(owner.getByRole('link', {name: 'Bo edits while agents work', exact: true})).toBeVisible()
    await Promise.all(logs.map((log, i) => log.submit(tasks[i]!.id, {op: 'result', executor: `board-agent-executor-${i}`, summary: 'Card reviewed', evidence: JSON.stringify({format: 'girnel-card-proposal', version: 1, change: {description: `Approved proposal ${i}`}})}, `board-agent-result-${i}`)))
    for (const [i, title] of ['Design task', 'Release task'].entries()) {
      const dialog = await connect(title)
      await expect(dialog.getByText('Room status: review. Attempt 1.', {exact: true})).toBeVisible()
      await expect(owner.getByRole('textbox', {name: 'Description', exact: true})).toHaveValue('')
      await dialog.getByRole('button', {name: 'Accept this result in the room', exact: true}).click()
      const accepted = dialog.getByText('Room status: accepted. Attempt 1.', {exact: true})
      // Presence can change while the exact decision enters durable custody.
      // Follow the actual held-action UI: review the same saved operation and
      // current audience explicitly, rather than create another accept or
      // bypass Girnel's audience/head guard. Repeated instability still fails.
      const saved = dialog.getByRole('button', {name: 'Review saved accept', exact: true})
      for (let review = 0; review < 3; review++) {
        await expect.poll(async () => await accepted.isVisible() || await saved.isVisible()).toBe(true)
        if (await accepted.isVisible()) break
        // The original send may become accepted after the visibility check,
        // removing this button. Only that exact accepted state ends the wait.
        try { await saved.click({timeout:2_000}) }
        catch (error) { if (await accepted.isVisible()) break; throw error }
        await expect(dialog.getByRole('heading', {name: 'Audience for this saved room decision', exact: true})).toBeVisible()
        const result = logs[i]!.snapshot().assignments.find(task => task.id === tasks[i]!.id)!.result!
        await expect(dialog.getByLabel('Exact saved room decision preview', {exact: true})).toHaveText(JSON.stringify({op: 'accept', result: result.id}, null, 2))
        await dialog.getByRole('button', {name: 'Send reviewed saved accept', exact: true}).click()
      }
      await expect(accepted).toBeVisible()
      await expect(owner.getByRole('textbox', {name: 'Description', exact: true})).toHaveValue('')
      await dialog.getByRole('button', {name: 'Review changes to this card', exact: true}).click()
      await dialog.getByLabel('Approve description', {exact: true}).check()
      await dialog.getByRole('button', {name: 'Apply selected changes to this card', exact: true}).click()
      await expect(dialog.getByText(/Approved card application saved locally at/)).toBeVisible()
      await dialog.getByRole('button', {name: 'Close', exact: true}).click()
      await guest.getByRole('link', {name: title, exact: true}).click()
      await expect(guest.getByRole('textbox', {name: 'Description', exact: true})).toHaveValue(`Approved proposal ${i}`)
      guest = await returnToBoard(bo.page)
    }
  } finally {
    stops.forEach(stop => stop()); logs.forEach(log => log.close())
    await Promise.all([ada.context.close(), bo.context.close(), ...workers.map(worker => worker.leave()), keeper.leave()])
  }
})

test('unfinished board drafts prevent pop-out, board switching and account sign-out', async ({browser, baseURL}) => {
  const {context, page} = await device(browser, baseURL!)
  try {
    const frame = await openBoards(page); await createBoard(frame, 'Draft protection')
    const draft = frame.getByRole('textbox', {name: 'Add a card to To do', exact: true}); await draft.fill('Keep my unfinished card')
    expect(await page.evaluate(() => {const event = new Event('beforeunload', {cancelable: true}); window.dispatchEvent(event); return event.defaultPrevented})).toBe(true)
    const closedPopup = page.waitForEvent('popup'); await page.locator('#boardsPopOut').click(); const popup = await closedPopup
    await expect.poll(() => popup.isClosed()).toBe(true)
    await expect(page.locator('#boardsStatus')).toContainText('Finish or save')
    await expect(draft).toHaveValue('Keep my unfinished card')
    await page.getByRole('button', {name: 'Choose another board', exact: true}).click()
    await expect(draft).toHaveValue('Keep my unfinished card')
    await page.locator('#boardsClose').click(); await openSettings(page, 'Account'); await page.locator('#signOut').click()
    await expect(page.locator('#signOut')).toBeVisible()
    await closeSettings(page)
    await openBoards(page); await expect(draft).toHaveValue('Keep my unfinished card')
    await draft.press('Enter'); await expect(frame.getByRole('link', {name: 'Keep my unfinished card', exact: true})).toBeVisible()
    // Closing Girnel's view leaves KithMoot's account usable and permits reopen.
    await frame.getByRole('link', {name: 'Boards', exact: true}).click()
    await frame.getByRole('button', {name: 'Sign out', exact: true}).click()
    const closeView = frame.getByRole('dialog', {name: 'Sign out of this device?', exact: true})
    await closeView.getByRole('button', {name: 'Sign out', exact: true}).click()
    await expect(page.locator('#boardsPanel')).toBeHidden()
    const reopened = await openBoards(page)
    await expect(reopened.getByRole('link', {name: 'Draft protection', exact: true})).toBeVisible()
  } finally {await context.close()}
})

test('Boards fits a narrow screen and reopens its durable board offline from cached local assets', async ({browser, baseURL}, info) => {
  const release = await offlineRelease()
  const {context, page} = await device(browser, release.base, true)
  try {
    await page.evaluate(async () => {await navigator.serviceWorker.ready})
    await page.reload()
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
    let frame = await openBoards(page); await createBoard(frame, 'Offline board'); await addCard(frame, 'Saved before disconnecting')
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({width: 320, height: 740}); await page.emulateMedia({colorScheme: scheme})
      expect(await page.locator('#boardsPanel').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
      await page.screenshot({path: info.outputPath(`boards-320-${scheme}.png`), fullPage: true})
    }
    // Stop the actual origin: all browsers must reopen from their cache.
    // WebKit's emulated-offline reload can fail inside its automation driver.
    await release.close(); await page.reload()
    // The saved account reconnects after the shell paints. Its sign-in flow
    // closes open panels; wait for the authenticated sync status before the
    // offline board action, just as this case does for the initial sign-in.
    await expect(page.locator('#homeSyncStatus')).toBeVisible()
    frame = await openBoards(page)
    await frame.getByRole('link', {name: 'Offline board', exact: true}).click()
    await expect(frame.getByRole('link', {name: 'Saved before disconnecting', exact: true})).toBeVisible()
    await addCard(frame, 'Saved while offline')
  } finally {await context.close(); await release.close()}
})
