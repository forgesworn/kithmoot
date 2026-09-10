import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { npubEncode } from 'nostr-tools/nip19'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
import { RoomAgent } from '../src/agent.js'
import { generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { NostrRelayPool } from '../src/relay-pool.js'
import { createDeviceCredential } from '../src/credential.js'
import { localIdentity } from '../src/identity.js'
import { deriveRoom } from '../src/room.js'
import { memoryDeviceStore, deviceKeyFor, storeCredentialFor } from '../app/src/device-store.js'

/** A test NIP-07 provider: signing keys stay in Node, never in the app. */
async function device(browser: Browser, baseURL: string, secret = generateSecretKey(), nip44 = true, beforePublicKey = async () => {}): Promise<BrowserContext> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  const pubkey = getPublicKey(secret)
  await context.exposeFunction('testPublicKey', async () => { await beforePublicKey(); return pubkey })
  await context.exposeFunction('testSign', (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, secret))
  await context.exposeFunction('testEncrypt', (peer: string, plaintext: string) => encrypt(plaintext, getConversationKey(secret, peer)))
  await context.exposeFunction('testDecrypt', (peer: string, ciphertext: string) => decrypt(ciphertext, getConversationKey(secret, peer)))
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  await context.addInitScript(({ relay, nip44 }) => {
    const testWindow = window as typeof window & {
      testPublicKey(): Promise<string>; testSign(template: unknown): Promise<unknown>;
      testEncrypt(peer: string, text: string): Promise<string>; testDecrypt(peer: string, text: string): Promise<string>;
    }
    Object.defineProperty(window, 'nostr', { configurable: true, value: {
      getPublicKey: () => testWindow.testPublicKey(),
      signEvent: (event: unknown) => testWindow.testSign(event),
      ...(nip44 ? { nip44: {
        encrypt: (peer: string, text: string) => testWindow.testEncrypt(peer, text),
        decrypt: (peer: string, text: string) => testWindow.testDecrypt(peer, text),
      } } : {}),
    } })
    const NativeWebSocket = window.WebSocket
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        const defaults = ['wss://relay.trotters.cc', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es', 'wss://relay.damus.io']
        if (!defaults.includes(String(url).replace(/\/$/, '')) && String(url) !== relay) throw new Error('External relay blocked by acceptance test')
        super(defaults.includes(String(url).replace(/\/$/, '')) ? relay : url, protocols)
      }
    }
  }, { relay: relay.href, nip44 })
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  return context
}

async function signIn(page: Page, baseURL: string) {
  await page.goto(baseURL + '?signin=nostr')
  await page.getByRole('button', { name: /Browser extension/ }).click()
  await expect(page.locator('#signOut')).toBeVisible()
  await expect(page.locator('#roomsEmpty')).toBeVisible()
}

test('a returning visitor can choose their Nostr profile at the door and the clerk receives that key', async ({ browser, baseURL }) => {
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  const context = await device(browser, baseURL!, secret)
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Account choice', relays: [relay.href], iceUrls: [] })
  const clerk = await RoomAgent.join({ link, relays: ['ws://127.0.0.1:7777'], name: 'Tally' })
  const profiles = new NostrRelayPool(['ws://127.0.0.1:7777'])
  try {
    await profiles.publish(finalizeEvent({ kind: 0, tags: [], created_at: Math.floor(Date.now() / 1000), content: JSON.stringify({ name: 'Account Alice', picture: 'https://profile.example/alice.svg', nip05: 'alice@profile.example' }) }, secret))
    await context.route('https://profile.example/.well-known/nostr.json?name=alice', route => route.fulfill({ json: { names: { alice: pubkey } } }))
    await context.route('https://profile.example/alice.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="8" fill="blue"/></svg>' }))
    const visitorSecret = Array.from(generateSecretKey()).map(byte => byte.toString(16).padStart(2, '0')).join('')
    await context.addInitScript(visitorSecret => {
      localStorage.setItem('kithmoot.participant', visitorSecret)
      localStorage.setItem('kithmoot.name', 'Typed Alice')
    }, visitorSecret)
    const page = await context.newPage()
    await page.goto(link)
    await expect(page.locator('#joinNostr')).toBeVisible()
    await page.locator('#joinNostr').click()
    await page.getByRole('button', { name: /Browser extension/ }).click()
    await expect(page.locator('#whoami')).toContainText('Account Alice')
    await expect(page.locator('#whoami')).toContainText('alice@profile.example')
    await expect(page.locator('#whoami img')).toHaveJSProperty('naturalWidth', 16)
    await expect(page.locator('#whoami')).toContainText(npubEncode(pubkey).slice(0, 12))
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.locator('#chatInput').fill('Tally, this is my account')
    await page.locator('#chatInput').press('Enter')
    await expect.poll(() => clerk.chat.messages().find(m => m.text === 'Tally, this is my account')?.participant).toBe(pubkey)
    await page.screenshot({ path: '/tmp/kithmoot-identity-room.png', fullPage: true })
  } finally { profiles.close(); await context.close(); await clerk.leave() }
})

test('a saved paired credential cannot override a different signed-in Nostr account', async ({ browser, baseURL }) => {
  const secret = generateSecretKey()
  const context = await device(browser, baseURL!, secret)
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const roomSecret = generateRoomSecret()
  const roomId = deriveRoom(roomSecret).roomId
  const link = encodeRoomLink(baseURL!, { secret: roomSecret, name: 'Paired identity check', relays: [relay.href], iceUrls: [] })
  const clerk = await RoomAgent.join({ link, relays: ['ws://127.0.0.1:7777'], name: 'Tally' })
  try {
    const page = await context.newPage()
    await signIn(page, baseURL!)
    const store = memoryDeviceStore()
    const now = Math.floor(Date.now() / 1000)
    const deviceKey = deviceKeyFor(store, roomId, now, generateSecretKey)
    const credential = await createDeviceCredential({ identity: localIdentity(generateSecretKey()), devicePubkey: getPublicKey(deviceKey), roomId, expiresAt: now + 3600 })
    storeCredentialFor(store, roomId, credential)
    await page.evaluate(entries => { for (const [key, value] of entries) localStorage.setItem(key!, value!) }, store.keys().map(key => [key, store.get(key)]))
    await page.goto(link)
    await page.reload()
    await expect(page.locator('#whoami')).toContainText(npubEncode(getPublicKey(secret)).slice(0, 12))
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.locator('#chatInput').fill('Tally, use the selected account')
    await page.locator('#chatInput').press('Enter')
    await expect.poll(() => clerk.chat.messages().find(m => m.text === 'Tally, use the selected account')?.participant).toBe(getPublicKey(secret))
  } finally { await context.close(); await clerk.leave() }
})

test('joining waits for the saved Nostr identity before sending to a clerk', async ({ browser, baseURL }) => {
  const secret = generateSecretKey()
  let gate = Promise.resolve()
  let release = () => {}
  let restoring = false
  const context = await device(browser, baseURL!, secret, true, async () => { restoring = true; await gate })
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Clerk identity check', relays: [relay.href], iceUrls: [] })
  const clerk = await RoomAgent.join({ link, relays: ['ws://127.0.0.1:7777'], name: 'Tally' })
  try {
    const signedInPage = await context.newPage()
    await signIn(signedInPage, baseURL!)
    restoring = false
    gate = new Promise<void>(resolve => { release = resolve })
    const page = await context.newPage()
    await page.goto(link)
    await expect.poll(() => restoring).toBe(true)
    await page.locator('#displayName').fill('Returning principal')
    await page.locator('#join').click()
    await expect(page.locator('#status')).toContainText('Reconnecting your sign-in')
    await expect(page.locator('#roomArea')).toBeHidden()
    release()
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.locator('#chatInput').fill('Tally, check my signed identity')
    await page.locator('#chatInput').press('Enter')
    await expect.poll(() => clerk.chat.messages().find(m => m.text === 'Tally, check my signed identity')?.participant).toBe(getPublicKey(secret))
    expect(await page.evaluate(() => localStorage.getItem('kithmoot.participant'))).toBeNull()
  } finally { release(); await context.close(); await clerk.leave() }
})

test('Nostr rooms follow the identity across browsers; direct-link visitors need no sign-in', async ({ browser, baseURL }) => {
  const secret = generateSecretKey()
  const first = await device(browser, baseURL!, secret)
  const second = await device(browser, baseURL!, secret)
  const visitor = await device(browser, baseURL!)
  try {
    const owner = await first.newPage()
    await signIn(owner, baseURL!)
    await owner.locator('#roomName').fill('Standing town hall')
    await owner.locator('#create').click()
    await expect(owner.locator('#roomSyncStatus')).toContainText('accepted by a relay')
    const link = await owner.locator('#shareUrl').inputValue()
    // Keep the inviter online while the other device opens its bookmark.
    const home = await first.newPage()
    await home.goto(baseURL!)
    await expect(home.locator('#roomList .roomName')).toHaveText('Standing town hall')
    await expect(home.locator('#signIn')).toBeHidden()
    await home.screenshot({ path: '/tmp/kithmoot-nostr-home.png', fullPage: true })

    const returning = await second.newPage()
    await returning.goto(baseURL! + '?signin=nostr')
    await returning.getByRole('button', { name: /Browser extension/ }).click()
    await expect(returning.locator('#roomList .roomName')).toHaveText('Standing town hall')
    await returning.locator('#roomList').getByRole('button', { name: 'Open Standing town hall', exact: true }).click()
    await expect(returning.locator('#join')).toBeVisible()
    await expect(returning.locator('#roomTitle')).toHaveText('Standing town hall')
    await expect(returning.locator('#whoami')).toContainText(npubEncode(getPublicKey(secret)).slice(0, 12))

    const guest = await visitor.newPage()
    await guest.goto(link)
    await expect(guest.locator('#join')).toBeVisible()
    await expect(guest.locator('#signIn')).toBeHidden() // optional disclosure stays closed
    await guest.locator('#displayName').fill('Visiting Ada')
    await guest.locator('#join').click()
    await expect(guest.locator('#roomArea')).toBeVisible()
    await expect(guest.locator('#whoami')).toContainText('Visiting Ada')

    await returning.locator('#doorToRooms').click()
    await returning.locator('#roomSwitcherHome').click()
    await expect(returning.locator('#roomList .roomName')).toHaveText('Standing town hall')
    await returning.locator('#signOut').click()
    await expect(returning.locator('#roomList .roomRow')).toHaveCount(0)
    await expect(returning.locator('#backToRoom')).toBeHidden()
    await expect(returning.locator('#signIn')).toBeVisible()
  } finally { await first.close(); await second.close(); await visitor.close() }
})

test('forgetting an account bookmark removes it on the other signed-in device', async ({ browser, baseURL }) => {
  const secret = generateSecretKey()
  const a = await device(browser, baseURL!, secret)
  const b = await device(browser, baseURL!, secret)
  try {
    const creator = await a.newPage()
    await signIn(creator, baseURL!)
    await creator.locator('#roomName').fill('A room to forget')
    await creator.locator('#create').click()
    await expect(creator.locator('#roomSyncStatus')).toContainText('accepted by a relay')
    await creator.locator('#doorToRooms').click()
    await creator.locator('#roomSwitcherHome').click()
    const other = await b.newPage()
    await other.goto(baseURL! + '?signin=nostr')
    await other.getByRole('button', { name: /Browser extension/ }).click()
    await expect(other.locator('#roomList .roomRow')).toHaveCount(1)
    await creator.locator('#roomList').getByRole('button', { name: 'Forget A room to forget', exact: true }).click()
    await creator.locator('#actionConfirm').click()
    await expect(creator.locator('#roomSyncStatus')).toContainText('accepted by a relay')
    await expect(other.locator('#roomList .roomRow')).toHaveCount(0)
    await other.reload()
    await expect(other.locator('#signOut')).toBeVisible()
    await expect(other.locator('#roomList .roomRow')).toHaveCount(0)
  } finally { await a.close(); await b.close() }
})

test('a signer without encryption gets honest local-only rooms, and no private-key input', async ({ browser, baseURL }) => {
  const context = await device(browser, baseURL!, generateSecretKey(), false)
  try {
    const page = await context.newPage()
    await page.goto(baseURL!)
    await page.locator('#signIn').click()
    await expect(page.getByText('Paste private key', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: /Browser extension/ }).click()
    await expect(page.locator('#roomSyncStatus')).toContainText('browser only')
    await page.locator('#roomName').fill('Local account room')
    await page.locator('#create').click()
    await expect(page.locator('#roomSyncStatus')).toContainText('browser only')
    await page.locator('#doorToRooms').click()
    await page.locator('#roomSwitcherHome').click()
    await expect(page.locator('#roomList .roomName')).toHaveText('Local account room')
  } finally { await context.close() }
})

test('existing browser rooms are imported only after explicit confirmation', async ({ browser, baseURL }) => {
  const secret = generateSecretKey()
  const a = await device(browser, baseURL!, secret)
  const b = await device(browser, baseURL!, secret)
  try {
    const page = await a.newPage()
    await page.goto(baseURL!)
    await page.locator('#roomName').fill('A browser shortcut')
    await page.locator('#create').click()
    await page.locator('#doorToRooms').click()
    await page.locator('#roomSwitcherHome').click()
    await expect(page.locator('#roomList .roomName')).toHaveText('A browser shortcut')
    await page.locator('#signIn').click()
    await page.getByRole('button', { name: /Browser extension/ }).click()
    await expect(page.locator('#roomList .roomRow')).toHaveCount(0)
    await expect(page.locator('#importBrowserRooms')).toHaveText('Add the room already here')
    await page.locator('#importBrowserRooms').click()
    await page.locator('#actionCancel').click()
    await expect(page.locator('#roomList .roomRow')).toHaveCount(0)
    await page.locator('#importBrowserRooms').click()
    await page.locator('#actionConfirm').click()
    await expect(page.locator('#roomList .roomName')).toHaveText('A browser shortcut')
    await expect(page.locator('#roomSyncStatus')).toContainText('accepted by a relay')
    const other = await b.newPage()
    await other.goto(baseURL! + '?signin=nostr')
    await other.getByRole('button', { name: /Browser extension/ }).click()
    await expect(other.locator('#roomList .roomName')).toHaveText('A browser shortcut')
  } finally { await a.close(); await b.close() }
})

test('switching conversations restores the same Nostr identity before entering', async ({ browser, baseURL }) => {
  const secret = generateSecretKey()
  const context = await device(browser, baseURL!, secret)
  try {
    const first = await context.newPage()
    await signIn(first, baseURL!)
    await first.locator('#roomName').fill('First account room')
    await first.locator('#create').click()
    await expect(first.locator('#roomSyncStatus')).toContainText('accepted by a relay')
    const host = await context.newPage()
    await host.goto(baseURL!)
    await expect(host.locator('#signOut')).toBeVisible()
    await host.locator('#roomName').fill('Second account room')
    await host.locator('#create').click()
    await expect(host.locator('#roomSyncStatus')).toContainText('accepted by a relay')
    await first.locator('#join').click()
    await expect(first.locator('#roomArea')).toBeVisible()
    await first.locator('#backToRooms').click()
    await first.locator('#roomSwitcherList').getByRole('button', { name: 'Switch to Second account room', exact: true }).click()
    await expect(first.locator('#roomTitle')).toHaveText('Second account room')
    await expect(first.locator('#roomArea')).toBeVisible()
    await expect(first.locator('#whoami')).toContainText(npubEncode(getPublicKey(secret)).slice(0, 12))
  } finally { await context.close() }
})


test('a failed saved signer cannot silently join as the old visitor', async ({ browser, baseURL }) => {
  let unavailable = false
  const secret = generateSecretKey()
  const context = await device(browser, baseURL!, secret, true, async () => { if (unavailable) throw new Error('Signer offline') })
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Reconnect account', relays: [relay.href], iceUrls: [] })
  const clerk = await RoomAgent.join({ link, relays: ['ws://127.0.0.1:7777'], name: 'Tally' })
  try {
    const page = await context.newPage()
    await signIn(page, baseURL!)
    unavailable = true
    await page.goto(link)
    await page.reload()
    await expect(page.locator('#previousAccount')).toContainText('disconnected')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeHidden()
    expect(await page.evaluate(() => localStorage.getItem('kithmoot.participant'))).toBeNull()
    await page.locator('#joinVisitor').click()
    await expect(page.getByRole('alertdialog')).toContainText('not your Nostr account')
    await page.locator('#actionCancel').click()
    await expect(page.locator('#roomArea')).toBeHidden()
    unavailable = false
    await page.locator('#joinNostr').click()
    await page.getByRole('button', { name: /Browser extension/ }).click()
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.locator('#roomMenu').click()
    await expect(page.locator('#sendingIdentity')).toHaveAttribute('aria-label', /Sending as Nostr account/)
    await expect(page.locator('#sendingIdentity')).not.toContainText('visitor')
    await page.locator('#roomSheetClose').click()
    await page.locator('#chatInput').fill('Tally, reconnected correctly')
    await page.locator('#chatInput').press('Enter')
    await expect.poll(() => clerk.chat.messages().find(m => m.text === 'Tally, reconnected correctly')?.participant).toBe(getPublicKey(secret))
  } finally { await context.close(); await clerk.leave() }
})

test('choosing a visitor after sign-out requires an explicit decision and labels the composer', async ({ browser, baseURL }) => {
  const context = await device(browser, baseURL!)
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Visitor choice', relays: [relay.href], iceUrls: [] })
  const clerk = await RoomAgent.join({ link, relays: ['ws://127.0.0.1:7777'], name: 'Tally' })
  try {
    const page = await context.newPage()
    await signIn(page, baseURL!)
    await page.locator('#signOut').click()
    await page.goto(link)
    await page.reload()
    await page.locator('#displayName').fill('Same familiar name')
    await page.locator('#joinVisitor').click()
    await page.locator('#actionConfirm').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.locator('#roomMenu').click()
    await expect(page.locator('#sendingIdentity')).toHaveAttribute('aria-label', /Sending as visitor/)
    await expect(page.locator('#sendingIdentity')).toContainText('Same familiar name')
    await page.locator('#sendingIdentity button').click()
    await expect(page.getByRole('alertdialog')).toContainText('Agents may not recognise you')
    await expect(page.getByRole('button', { name: 'Leave to sign in', exact: true })).toBeVisible()
    await page.locator('#actionCancel').click()
    await page.locator('#roomSheetClose').click()
    await page.locator('#chatInput').fill('Deliberate visitor message')
    await page.locator('#chatInput').press('Enter')
    await expect.poll(() => clerk.chat.messages().find(m => m.text === 'Deliberate visitor message')).toBeTruthy()
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 844 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    }
  } finally { await context.close(); await clerk.leave() }
})

test('shared projects keep three scopes separate and carry a reviewed invitation from desktop to another phone session', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000)
  const aliceSk = generateSecretKey(), bobSk = generateSecretKey(), carolSk = generateSecretKey(), agentSk = generateSecretKey()
  const aliceKey = getPublicKey(aliceSk), bobKey = getPublicKey(bobSk), carolKey = getPublicKey(carolSk), agentKey = getPublicKey(agentSk)
  const relay = new URL('/__test-relay', baseURL!); relay.protocol = 'wss:'
  const keepers = await Promise.all(['Kithmoot room', 'Bothy room', 'Research room'].map(name => RoomAgent.create({ base: baseURL!, name: 'Keeper', roomName: name, relays: ['ws://127.0.0.1:7777'] })))
  const roomLinks = keepers.map(k => ({ roomId: k.roomId, name: k.link.name!, link: encodeRoomLink(baseURL!, { ...k.link, relays: [relay.href] }), openedAt: 1, readAt: 0 }))
  const aContext = await device(browser, baseURL!, aliceSk), bContext = await device(browser, baseURL!, bobSk), cContext = await device(browser, baseURL!, carolSk)
  const contexts = [aContext, bContext, cContext]
  await aContext.addInitScript(({ rooms, pubkey }) => {
    if (localStorage.getItem('shared-project-fixture')) return
    for (const room of rooms) localStorage.setItem(`kithmoot.account.${pubkey}.kithmoot.room.${room.roomId}`, JSON.stringify(room))
    localStorage.setItem('shared-project-fixture', 'true')
  }, { rooms: roomLinks, pubkey: aliceKey })
  const a = await aContext.newPage(), b = await bContext.newPage(), c = await cContext.newPage()
  const errors: string[] = []
  for (const p of [a, b, c]) p.on('pageerror', e => errors.push(e.message))
  async function loginAccount(page: Page) {
    await page.goto(baseURL! + '?signin=nostr')
    await page.getByRole('button', { name: /Browser extension/ }).click()
    await expect(page.locator('#signOut')).toBeVisible()
    // History restores the home heading and room list. Wait for that state
    // before clicking: its layout can move this button during a pointer tap.
    await expect(page.locator('#sharedProjectNew')).toBeEnabled()
    await page.locator('#homeSharedProjects').click()
    await expect(page.locator('#sharedProjects')).toBeVisible()
  }
  async function createProject(name: string, room: string, members: [string, 'person' | 'agent'][]) {
    await a.locator('#sharedProjectNew').click()
    await a.locator('#sharedProjectName').fill(name)
    for (const [pubkey, kind] of members) {
      await a.locator('#sharedProjectNpub').fill(npubEncode(pubkey))
      await a.locator('#sharedProjectContactKind').selectOption(kind)
      await a.locator('#sharedProjectAddPerson').click()
    }
    await a.locator('#sharedProjectRooms').getByRole('checkbox', { name: room, exact: true }).check()
    await a.locator('#sharedProjectSave').click()
    await expect(a.locator('#sharedProjectEditor')).not.toBeVisible()
    await expect(a.locator('#sharedProjectsList h3', { hasText: name })).toHaveCount(1)
  }
  try {
    await a.setViewportSize({ width: 1440, height: 900 })
    await loginAccount(a); await loginAccount(b); await loginAccount(c)
    await createProject('Kithmoot', 'Kithmoot room', [[bobKey, 'person'], [agentKey, 'agent']])
    await createProject('Bothy', 'Bothy room', [[carolKey, 'person'], [agentKey, 'agent']])
    await createProject('Research', 'Research room', [[carolKey, 'person']])
    await expect(b.locator('#sharedProjectsList h3')).toHaveText(['Kithmoot'])
    await expect(c.locator('#sharedProjectsList h3')).toHaveText(['Bothy', 'Research'])
    await expect(b.locator('#sharedProjectsList')).not.toContainText('Bothy')
    await b.getByRole('button', { name: 'Review and join', exact: true }).click()
    await expect(b.locator('#sharedProjectPeople input:checked')).toHaveCount(3)
    await expect(b.locator('#sharedProjectRooms')).toContainText('Kithmoot room')
    const ownerCard = a.locator('.sharedProjectCard').filter({ has: a.getByRole('heading', { name: 'Kithmoot', exact: true }) })
    async function renameKithmoot(name: string) {
      await a.locator('.sharedProjectCard').filter({ has: a.getByRole('button', { name: 'Kithmoot room', exact: true }) }).getByRole('button', { name: 'Edit project', exact: true }).click()
      await a.locator('#sharedProjectName').fill(name)
      await a.locator('#sharedProjectSave').click()
      await expect(a.locator('#sharedProjectEditor')).not.toBeVisible()
      await expect(b.locator('#sharedProjectsList h3')).toHaveText([name])
    }
    await expect(ownerCard).toBeVisible()
    await renameKithmoot('Kithmoot updated')
    await b.locator('#sharedProjectSave').click()
    await expect(b.locator('#sharedProjectError')).toContainText('invitation changed')
    await expect(b.locator('#sharedProjectEditor')).toBeVisible()
    await b.locator('#sharedProjectCancel').click()
    await renameKithmoot('Kithmoot')
    await b.getByRole('button', { name: 'Review and join', exact: true }).click()
    await b.locator('#sharedProjectSave').click()
    await expect(b.locator('#sharedProjectEditor')).not.toBeVisible()
    await expect(b.locator('#sharedProjectsList').getByRole('button', { name: 'Kithmoot room', exact: true })).toBeVisible()
    await expect(b.locator('#sharedProjectsStatus')).not.toContainText('awaiting relay confirmation')
    const roomButton = b.locator('#sharedProjectsList').getByRole('button', { name: 'Kithmoot room', exact: true })
    await roomButton.focus()
    await renameKithmoot('Kithmoot updated')
    await expect(roomButton).toBeFocused()
    await expect(b.locator('#homeProject option[value^="shared:"]')).toHaveText(['Kithmoot updated'])
    await renameKithmoot('Kithmoot')
    await expect(roomButton).toBeFocused()
    await b.screenshot({ path: testInfo.outputPath('shared-project-phone.png') })
    expect(await b.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    const privateCache = await b.evaluate(pubkey => localStorage.getItem(`kithmoot.shared-projects.v1.${pubkey}`), bobKey)
    expect(privateCache).toBeTruthy(); expect(privateCache).not.toContain('Kithmoot'); expect(privateCache).not.toContain(carolKey)

    const phoneContext = await device(browser, baseURL!, bobSk); contexts.push(phoneContext)
    const phone = await phoneContext.newPage(); phone.on('pageerror', e => errors.push(e.message))
    await loginAccount(phone)
    await expect(phone.locator('#sharedProjectsList h3')).toHaveText(['Kithmoot'])
    await expect(phone.locator('#sharedProjectsList').getByRole('button', { name: 'Review and join' })).toHaveCount(0)
    await phone.locator('#sharedProjectsList').getByRole('button', { name: 'Kithmoot room', exact: true }).click()
    await expect(phone.locator('#roomArea')).toBeVisible()
    await expect(phone.locator('#roomTitle')).toHaveText('Kithmoot room')
    await phone.locator('#chatInput').fill('Hello from the shared project on my phone')
    await phone.locator('#chatInput').press('Enter')
    await expect.poll(() => keepers[0]!.chat.messages().some(m => m.text === 'Hello from the shared project on my phone')).toBe(true)

    await a.locator('#sharedProjectsList').getByRole('button', { name: 'Kithmoot room', exact: true }).click()
    await expect(a.locator('#roomArea')).toBeVisible()
    await expect(a.locator('#workspaceRooms h3')).toHaveText(['Bothy', 'Kithmoot', 'Research'])
    await a.locator('#chatInput').fill('Keep this draft in Kithmoot')
    await a.locator('#workspaceRooms').getByRole('button', { name: 'Bothy room', exact: true }).click()
    await expect(a.locator('#roomTitle')).toHaveText('Bothy room')
    await expect(a.locator('#chatInput')).toHaveValue('')
    await a.locator('#workspaceRooms').getByRole('button', { name: 'Kithmoot room', exact: true }).click()
    await expect(a.locator('#chatInput')).toHaveValue('Keep this draft in Kithmoot')
    await a.screenshot({ path: testInfo.outputPath('shared-project-desktop.png') })
    expect(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    expect(errors).toEqual([])
  } finally { for (const keeper of keepers) keeper.leave(); await Promise.all(contexts.map(context => context.close())) }
})
