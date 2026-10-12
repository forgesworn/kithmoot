import {test, expect, type Browser, type BrowserContext, type Frame, type Page} from '@playwright/test'
import {generateSecretKey, getPublicKey, finalizeEvent} from 'nostr-tools/pure'
import {encrypt, decrypt, getConversationKey} from 'nostr-tools/nip44'
import {RoomAgent} from '../src/agent.js'
import {agentRelaysFor, TEST_RELAY_HTTP} from './relays.js'
import {npubEncode} from 'nostr-tools/nip19'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import {resolve, extname} from 'node:path'

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
  return {base: `http://127.0.0.1:${(server.address() as {port: number}).port}/j/`, close: async () => {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))}}
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
        const known = ['wss://nostr.mom', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es', 'wss://relay.damus.io', 'wss://nostr.oxtr.dev']
        if (!known.includes(String(url).replace(/\/$/, '')) && String(url) !== relay) throw new Error('External relay refused by board acceptance')
        super(relay, protocols)
      }
    }
  }, relay.href)
  await context.route(/^https:\/\/(relay\.damus\.io|nos\.lol|relay\.primal\.net|nostr\.oxtr\.dev)\/?$/, route => route.fulfill({status: 200, contentType: 'application/nostr+json', body: JSON.stringify({limitation: {max_message_length: 131072}})}))
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
  await page.locator('#homeWork').click()
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
  if (await reminder.isVisible()) await reminder.click()
  await frame.getByRole('link', {name: /^Create (a )?board$/}).click()
  await frame.getByRole('textbox', {name: 'Board name', exact: true}).fill(name)
  await frame.getByRole('button', {name: 'Create board', exact: true}).click()
  await expect(frame.getByRole('heading', {name, exact: true})).toBeVisible()
}
async function addCard(frame: Frame, text: string) {
  const composer = frame.getByRole('textbox', {name: 'Add a card to To do', exact: true})
  await composer.fill(text); await composer.press('Enter')
  await expect(frame.getByRole('link', {name: text, exact: true})).toBeVisible()
}

test('Boards replaces Work, edits durable cards and opens several independently labelled windows', async ({browser, baseURL}, info) => {
  const {context, page, pubkey} = await device(browser, baseURL!)
  const keepers = await Promise.all(['Design chat', 'Release chat'].map(roomName => RoomAgent.create({base: baseURL!, name: 'Keeper', roomName, agent: false, ...agentRelaysFor(baseURL!)})))
  await page.evaluate(({pubkey, rooms}) => {for (const room of rooms) localStorage.setItem(`kithmoot.account.${pubkey}.kithmoot.room.${room.roomId}`, JSON.stringify(room))}, {pubkey, rooms: keepers.map((k, i) => ({roomId: k.roomId, name: ['Design chat', 'Release chat'][i], link: k.url, openedAt: 1, readAt: 0}))})
  await page.reload()
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  try {
    await page.locator('#homeSharedProjects').click()
    for (const [i, name] of ['Design project', 'Release project'].entries()) {
      await page.locator('#sharedProjectNew').click(); await page.locator('#sharedProjectName').fill(name)
      await page.locator('#sharedProjectNpub').fill(npubEncode(keepers[i]!.participant)); await page.locator('#sharedProjectAddPerson').click()
      await page.locator('#sharedProjectRooms').getByRole('checkbox', {name: ['Design chat', 'Release chat'][i], exact: true}).check()
      await page.locator('#sharedProjectSave').click(); await expect(page.locator('#sharedProjectEditor')).toBeHidden()
    }
    await page.locator('#sharedProjectsClose').click()
    await expect(page.locator('#homeWork')).toHaveText('Boards')
    let frame = await openBoards(page)
    await createBoard(frame, 'Design board'); await addCard(frame, 'Review the design')
    await page.locator('#boardsProject').selectOption({label: 'Design project'}); await page.locator('#boardsRoom').selectOption({label: 'Design chat'}); await page.locator('#boardsAssociate').click()
    await expect(page.locator('#boardsContext')).toContainText('Design board')
    const firstPopup = page.waitForEvent('popup'); await page.locator('#boardsPopOut').click(); const first = await firstPopup
    await expect(first).toHaveTitle('KithMoot · Design project · Design chat · Design board')
    await expect(first.locator('.boardsContext')).toHaveText('KithMoot · Design project · Design chat · Design board')
    let one = (await (await first.locator('iframe').elementHandle())!.contentFrame())!
    await expect(one.getByRole('heading', {name: 'Design board', exact: true})).toBeVisible()
    expect(await first.locator('iframe').evaluate(frame => Math.abs(frame.getBoundingClientRect().width - innerWidth) < 2)).toBe(true)
    await page.getByRole('button', {name: 'Choose another board', exact: true}).click()
    frame = (await (await page.locator('#boardsPanel iframe').elementHandle())!.contentFrame())!
    await createBoard(frame, 'Release board'); await addCard(frame, 'Check release evidence')
    await page.locator('#boardsProject').selectOption({label: 'Release project'}); await page.locator('#boardsRoom').selectOption({label: 'Release chat'}); await page.locator('#boardsAssociate').click()
    const secondPopup = page.waitForEvent('popup'); await page.locator('#boardsPopOut').click(); const second = await secondPopup
    await expect(second).toHaveTitle('KithMoot · Release project · Release chat · Release board')
    await expect(first).toHaveTitle('KithMoot · Design project · Design chat · Design board')
    await page.locator('#boardsClose').click()
    await page.locator('#homeSharedProjects').click()
    await page.locator('.sharedProjectCard').filter({has: page.getByRole('heading', {name: 'Release project', exact: true})}).getByRole('button', {name: 'Release chat', exact: true}).click()
    if (await page.locator('#displayName').isVisible()) {await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()}
    await expect(page.locator('#chatInput')).toBeEditable()
    await expect(page.locator('#openAssignments')).toHaveText(/^Boards/)
    await page.locator('#chatInput').fill('Keep the release chat draft')
    await expect(first).toHaveTitle('KithMoot · Design project · Design chat · Design board')
    await expect(second).toHaveTitle('KithMoot · Release project · Release chat · Release board')
    await addCard(one, 'Design continues independently')
    await first.reload()
    await expect(first.locator('iframe')).toBeVisible()
    one = (await (await first.locator('iframe').elementHandle())!.contentFrame())!
    await expect(one.getByRole('link', {name: 'Design continues independently', exact: true})).toBeVisible()
    await first.screenshot({path: info.outputPath('design-board-popout.png'), fullPage: true})
    await first.getByRole('button', {name: 'Return to workspace', exact: true}).click()
    await expect(page.locator('#boardsContext')).toContainText('Design board')
    frame = (await (await page.locator('#boardsPanel iframe').elementHandle())!.contentFrame())!
    await expect(frame.getByRole('link', {name: 'Design continues independently', exact: true})).toBeVisible()
    await frame.getByRole('link', {name: 'Review the design', exact: true}).click()
    await frame.getByRole('button', {name: 'Discuss in chat', exact: true}).click()
    await expect(page.locator('#chatInput')).toHaveValue(/Review the design\nhttps:.*#\/b\/.*\/c\//)
    expect(keepers[0]!.chat.messages().some(message => message.text?.includes('Review the design'))).toBe(false)
    await page.locator('#chatInput').fill('')
    await page.locator('#backToRooms').click()
    await page.locator('#switcherSharedProjects').click()
    await page.locator('.sharedProjectCard').filter({has: page.getByRole('heading', {name: 'Release project', exact: true})}).getByRole('button', {name: 'Release chat', exact: true}).click()
    await expect(page.locator('#chatInput')).toHaveValue('Keep the release chat draft')
    await page.locator('#chatInput').fill('')
    await page.locator('#backToRooms').click()
    await expect(page.locator('#roomSwitcherHome')).toBeEnabled()
    await page.locator('#roomSwitcherHome').click()
    await page.locator('#openAppSettings').click(); await page.locator('#signOut').click()
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
    const owner = await openBoards(ada.page); await createBoard(owner, 'Team delivery')
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
    const guest = (await (await bo.page.locator('#boardsPanel iframe').elementHandle())!.contentFrame())!
    await expect(guest.locator('#app')).not.toContainText('Opening board…')
    const reminder = guest.getByRole('button', {name: 'Not yet, remind me', exact: true}); if (await reminder.isVisible()) await reminder.click()
    await guest.getByRole('button', {name: 'Join board', exact: true}).click()
    await expect(guest.getByRole('link', {name: 'Design task', exact: true})).toBeVisible()
    const boardHash = new URL(owner.url()).hash
    const connect = async (title: string) => {
      await owner.goto(new URL(boardHash, owner.url()).href)
      await owner.getByRole('link', {name: title, exact: true}).click()
      await owner.getByRole('button', {name: 'Ask an agent', exact: true}).click()
      const dialog = owner.getByRole('dialog', {name: 'Ask an agent', exact: true})
      await expect(dialog.getByLabel('Chosen room invitation', {exact: true})).toHaveValue(keeper.url)
      await dialog.getByRole('button', {name: 'Connect to the chosen room', exact: true}).click()
      await expect(dialog.getByRole('heading', {name: 'Room audience', exact: true})).toBeVisible()
      await Promise.all(workers.map((_, i) => advertise(i)))
      await expect(dialog.getByText(/^Design agent .*installation/)).toBeVisible()
      await expect(dialog.getByText(/^Release agent .*installation/)).toBeVisible()
      await dialog.getByRole('button', {name: 'Refresh room audience and installations', exact: true}).click()
      return dialog
    }
    for (const [i, title] of ['Design task', 'Release task'].entries()) {
      const dialog = await connect(title)
      await dialog.getByRole('combobox', {name: /^Agent installation/}).selectOption(`${workers[i]!.participant}/${workers[i]!.device}`)
      await expect(dialog.getByRole('combobox', {name: /^Agent action/}).locator('option[value="card-review"]')).toHaveCount(1)
      await dialog.getByRole('combobox', {name: /^Agent action/}).selectOption('card-review')
      await dialog.getByLabel('Acceptance criteria shared with the room', {exact: true}).fill('Return a description proposal for review')
      await dialog.getByRole('button', {name: 'Review disclosure', exact: true}).click()
      await dialog.getByRole('button', {name: 'Send exactly this disclosure', exact: true}).click()
      await expect(dialog.getByText('Room status: offered. Attempt 1.', {exact: true})).toBeVisible()
      await dialog.getByRole('button', {name: 'Disconnect and close', exact: true}).click()
      await expect(dialog).toHaveCount(0)
    }
    await expect.poll(() => logs[0]!.snapshot().assignments.length).toBe(2)
    await expect.poll(() => logs[1]!.snapshot().assignments.length).toBe(2)
    const tasks = logs.map((log, i) => log.snapshot().assignments.find(task => task.owner === workers[i]!.participant)!)
    await Promise.all(logs.map((log, i) => log.submit(tasks[i]!.id, {op: 'claim', executor: `board-agent-executor-${i}`, next: 'Review the selected card'}, `board-agent-claim-${i}`)))
    expect(logs.map((log, i) => log.snapshot().assignments.find(task => task.id === tasks[i]!.id)?.status)).toEqual(['running', 'running'])
    await addCard(guest, 'Bo edits while agents work')
    await owner.goto(new URL(boardHash, owner.url()).href)
    await expect(owner.getByRole('link', {name: 'Bo edits while agents work', exact: true})).toBeVisible()
    await Promise.all(logs.map((log, i) => log.submit(tasks[i]!.id, {op: 'result', executor: `board-agent-executor-${i}`, summary: 'Card reviewed', evidence: JSON.stringify({format: 'girnel-card-proposal', version: 1, change: {description: `Approved proposal ${i}`}})}, `board-agent-result-${i}`)))
    for (const [i, title] of ['Design task', 'Release task'].entries()) {
      const dialog = await connect(title)
      await expect(dialog.getByText('Room status: review. Attempt 1.', {exact: true})).toBeVisible()
      await expect(owner.getByRole('textbox', {name: 'Description', exact: true})).toHaveValue('')
      await dialog.getByRole('button', {name: 'Accept this result in the room', exact: true}).click()
      await expect(dialog.getByText('Room status: accepted. Attempt 1.', {exact: true})).toBeVisible()
      await expect(owner.getByRole('textbox', {name: 'Description', exact: true})).toHaveValue('')
      await dialog.getByRole('button', {name: 'Review changes to this card', exact: true}).click()
      await dialog.getByLabel('Approve description', {exact: true}).check()
      await dialog.getByRole('button', {name: 'Apply selected changes to this card', exact: true}).click()
      await expect(dialog.getByText(/Approved card application saved locally at/)).toBeVisible()
      await dialog.getByRole('button', {name: 'Disconnect and close', exact: true}).click()
      await guest.getByRole('link', {name: title, exact: true}).click()
      await expect(guest.getByRole('textbox', {name: 'Description', exact: true})).toHaveValue(`Approved proposal ${i}`)
      await guest.goto(new URL(boardHash, guest.url()).href)
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
    await page.locator('#boardsClose').click(); await page.locator('#openAppSettings').click(); await page.locator('#signOut').click()
    await expect(page.locator('#signOut')).toBeVisible()
    await page.locator('#appSettingsClose').click()
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
    await context.setOffline(true); await page.reload()
    frame = await openBoards(page)
    await frame.getByRole('link', {name: 'Offline board', exact: true}).click()
    await expect(frame.getByRole('link', {name: 'Saved before disconnecting', exact: true})).toBeVisible()
    await addCard(frame, 'Saved while offline')
  } finally {await context.setOffline(false); await context.close(); await release.close()}
})
