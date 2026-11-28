import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { rm } from 'node:fs/promises'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure'
import { wrapEvent } from 'nostr-tools/nip59'
import { decrypt, getConversationKey } from 'nostr-tools/nip44'
import { unwrapEvent } from 'nostr-tools/nip17'
import { npubEncode } from 'nostr-tools/nip19'
import { matchFilter, matchFilters, type Filter } from 'nostr-tools/filter'
import { NostrRelayPool } from '../src/relay-pool.js'
import { accountDevice, signInAccount } from './nostr-account.js'
import { TEST_RELAY_WS, openSettings } from './browser.js'
import { openNpubThread } from './people-scenario.js'
import { createRoomInvitation } from '../src/invitation.js'
import { deriveRoom, generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { dmPolicy, localPeerCrypt } from '../src/dm.js'
import { contactInvitationRumor, wrapContactInvitation } from '../src/contact-invitation.js'
import { ordinaryHistoryKey } from '../app/src/nostr-message-history.js'
import { peopleInboxEnabledKey } from '../app/src/people-nostr-inbox.js'
import { parseNodeRoomLink } from '@forgesworn/fold-kit/node-room'

async function showInbox(page: Page) {
  await openSettings(page, 'Account'); await page.locator('#nostrAccountInboxEntry').click()
  await expect(page.locator('#nostrInboxDialog')).toBeVisible()
}
async function useManualSettingsInbox(context: BrowserContext, self: string) {
  await context.addInitScript(key => localStorage.setItem(key, '0'), peopleInboxEnabledKey(self))
}
async function inboxList(pool: NostrRelayPool, account: Uint8Array, baseURL: string) {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  await pool.publish(finalizeEvent({ kind: 10050, created_at: Math.floor(Date.now() / 1000), tags: [['relay', relay.href]], content: '' }, account))
}
function writes(page: Page) {
  const events: Event[] = []
  page.on('websocket', socket => socket.on('framesent', frame => {
    try { const value = JSON.parse(String(frame.payload)); if (value[0] === 'EVENT' && [4, 1059].includes(value[1]?.kind)) events.push(value[1]) } catch { /* Other frames are not message publications. */ }
  }))
  return events
}

test('People counts verified incoming messages by default, keeps the read position and replies on Nostr', async ({ browser, baseURL }, info) => {
  const account = generateSecretKey(), peer = generateSecretKey(), followedKey = generateSecretKey()
  const self = getPublicKey(account), other = getPublicKey(peer), now = Math.floor(Date.now() / 1000)
  const followed = getPublicKey(followedKey)
  const context = await accountDevice(browser, baseURL!, account), pool = new NostrRelayPool([TEST_RELAY_WS])
  try {
    await context.addInitScript(() => localStorage.setItem('kithmoot.profiles.enabled', 'true'))
    await inboxList(pool, account, baseURL!); await inboxList(pool, peer, baseURL!)
    await pool.publish(finalizeEvent({ kind: 0, created_at: now, tags: [], content: JSON.stringify({ name: 'Nostr Test Sender' }) }, peer))
    await pool.publish(finalizeEvent({ kind: 0, created_at: now, tags: [], content: JSON.stringify({ name: 'Nostr Test Follow' }) }, followedKey))
    await pool.publish(finalizeEvent({ kind: 3, created_at: now, tags: [['p', followed]], content: '' }, account))
    const text = '<img src="https://people-message.invalid/pixel">'
    const rumor = { kind: 14, created_at: now - 1, tags: [['p', self]], content: text }
    const incoming = wrapEvent(rumor, peer, self), duplicate = wrapEvent(rumor, peer, self)
    const selfCopy = wrapEvent({ ...rumor, tags: [['p', other]], content: 'Previous outgoing message' }, account, self)
    for (const copy of [incoming, duplicate, selfCopy]) await pool.publish(copy)

    const page = await context.newPage(), sent = writes(page)
    const requests: Filter[] = []
    page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
      const frame = JSON.parse(String(payload))
      if (frame[0] === 'REQ') requests.push(...frame.slice(2).filter((filter: Filter) =>
        filter.kinds?.[0] === 1059 && filter['#p']?.includes(self) && filter.limit === 128))
    }))
    if (info.project.name === 'chromium') await page.setViewportSize({ width: 390, height: 844 })
    else if (info.project.name === 'chromium-desktop') await page.setViewportSize({ width: 1100, height: 840 })
    const badge = page.locator('#railPeopleCount')
    const row = page.locator(`#peopleRows li[data-person="${other}"]`), thread = page.locator('#peopleThread')
    await signInAccount(page, baseURL!)
    await expect(badge).toHaveText('1')
    await page.locator('#railPeople').click()
    await expect(page.locator('#peopleList')).toContainText('Nostr Test Follow')
    await expect.poll(() => page.evaluate(key => localStorage.getItem(`kithmoot.people-profiles.v1.${key}`), self)).toContain(followed)
    // This account has written to them before, so it is a conversation, not a request: named from their profile.
    await expect(row).toBeVisible()
    await expect(row).toContainText('Nostr Test Sender')
    await expect(badge).toHaveText('1')
    expect(requests).toHaveLength(1)
    await row.getByRole('button').first().click()
    await expect(thread.getByText(text, { exact: true })).toBeVisible()
    await expect(thread.locator('img')).toHaveCount(0)
    await expect(badge).toBeHidden()
    await expect(thread.locator('.peopleMsg').filter({ hasText: 'Previous outgoing message' })).toBeVisible()
    const input = thread.getByRole('textbox')
    await input.fill('Reply from People'); await input.press('Enter')
    await expect(thread).toContainText('Sent to their inbox relay')
    const toPeer = sent.find(event => event.tags[0]?.[1] === other)!
    expect(unwrapEvent(toPeer, peer)).toMatchObject({ kind: 14, pubkey: self, content: 'Reply from People' })
    await page.reload()
    await expect(page.locator('#railPeople')).toBeVisible()
    await page.locator('#railPeople').click()
    await expect(row).toBeVisible()
    await expect(row.getByRole('button')).not.toHaveAccessibleName(/unread/)
    await row.getByRole('button').first().click()
    await expect(thread.locator('.peopleMsg').filter({ hasText: 'Reply from People' })).toContainText('Sent to their inbox relay')
    const back = page.getByRole('button', { name: 'Back to people' })
    if (await back.isVisible()) await back.click()
    await page.locator('#railChats').click()
    await pool.publish(wrapEvent({ ...rumor, created_at: now - 2, content: 'A late arrival' }, peer, self))
    await expect(badge).toHaveText('1')
  } finally { pool.close(); await context.close() }
})

for (const waitingFor of ['recipient', 'sender copy'] as const) {
  test(`People shows the send outcome and retries only the unconfirmed ${waitingFor}`, async ({ browser, baseURL }) => {
    const account = generateSecretKey(), peer = generateSecretKey()
    const self = getPublicKey(account), other = getPublicKey(peer), refused = waitingFor === 'recipient' ? other : self
    const context = await accountDevice(browser, baseURL!, account), pool = new NostrRelayPool([TEST_RELAY_WS])
    const route = new URL('/__test-relay', baseURL); route.protocol = 'wss:'
    const writes: Event[] = []
    let refuse = true, releaseCopy: (() => void) | undefined
    await context.routeWebSocket(route.href, socket => {
      const relay = socket.connectToServer()
      socket.onMessage(data => {
        const [verb, event] = JSON.parse(String(data)) as [string, Event]
        if (verb === 'EVENT' && event.kind === 1059 && event.tags.length === 1 && [self, other].includes(event.tags[0]?.[1] ?? '')) {
          writes.push(event)
          if (refuse && event.tags[0]?.[1] === refused) {
            const reject = () => socket.send(JSON.stringify(['OK', event.id, false, 'restricted: synthetic refusal']))
            if (waitingFor === 'sender copy') releaseCopy = reject
            else reject()
            return
          }
        }
        relay.send(data)
      })
    })
    try {
      await inboxList(pool, account, baseURL!); await inboxList(pool, peer, baseURL!)
      const page = await context.newPage()
      await signInAccount(page, baseURL!); await openNpubThread(page, npubEncode(other), other)
      const thread = page.locator('#peopleThread'), input = thread.getByRole('textbox')
      await input.fill('One encrypted message'); await input.press('Enter')
      if (waitingFor === 'sender copy') {
        await expect.poll(() => Boolean(releaseCopy)).toBe(true)
        await expect(thread).toContainText('Sent to their inbox relay')
        releaseCopy!()
      } else {
        await expect(thread).toContainText('Not confirmed by their inbox relay')
      }

      const retry = thread.getByRole('button', { name: waitingFor === 'recipient' ? 'Retry' : 'Retry sync', exact: true })
      await expect(retry).toBeVisible()
      const first = [...writes]
      expect(first).toHaveLength(2)
      refuse = false
      await retry.click()
      await expect.poll(() => writes.length).toBeGreaterThan(2)
      await expect(thread).toContainText('Sent to their inbox relay')
      await expect(thread).not.toContainText('Syncing')
      expect(writes.slice(2)).toEqual([first.find(event => event.tags[0]?.[1] === refused)])
      const sent = thread.locator('.peopleMsg').filter({ hasText: 'One encrypted message' })
      await expect(sent).toHaveCount(1)
    } finally { pool.close(); await context.close() }
  })
}

test('People puts unread messages above frequent conversations and keeps contact pictures across reloads', async ({ browser, baseURL }, info) => {
  const account = generateSecretKey(), frequent = generateSecretKey(), recent = generateSecretKey(), unread = generateSecretKey()
  const self = getPublicKey(account), top = getPublicKey(frequent), latest = getPublicKey(recent), incoming = getPublicKey(unread)
  // A temporary WebKit context loses its CacheStorage entries on reload.
  // Exercise the persistent browser profile used for keeping pictures.
  const profile = info.project.name === 'webkit' ? info.outputPath('webkit-profile') : undefined
  const browserWithProfile: Pick<Browser, 'newContext'> = profile
    ? { newContext: options => browser.browserType().launchPersistentContext(profile, { ...options, ...info.project.use.launchOptions }) }
    : browser
  const context = await accountDevice(browserWithProfile, baseURL!, account), pool = new NostrRelayPool([TEST_RELAY_WS])
  const picture = 'https://picture.example.invalid/people.png'
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOw7Mn8DwAEXgIuYNZitQAAAABJRU5ErkJggg==', 'base64')
  let imageRequests = 0
  try {
    await context.addInitScript(() => localStorage.setItem('kithmoot.profiles.enabled', 'true'))
    await context.route(picture, async route => {
      imageRequests++
      if (imageRequests > 1) { await route.abort(); return }
      await route.fulfill({ body: png, headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=600' } })
    })
    await inboxList(pool, account, baseURL!)
    const now = Math.floor(Date.now() / 1000)
    await pool.publish(finalizeEvent({ kind: 0, created_at: now, tags: [], content: JSON.stringify({ name: 'Frequent contact', picture }) }, frequent))
    await pool.publish(finalizeEvent({ kind: 3, created_at: now, tags: [['p', top]], content: '' }, account))
    for (const [author, peer, time, text] of [
      [account, top, now - 60, 'First message to my frequent contact'],
      [account, top, now - 50, 'Second message to my frequent contact'],
      [unread, self, now - 40, 'Unread message'],
      [account, latest, now - 30, 'Most recent outgoing message'],
    ] as const) {
      await pool.publish(wrapEvent({ kind: 14, created_at: time, tags: [['p', peer]], content: text }, author, self))
    }

    const page = await context.newPage()
    const rows = page.locator('#peopleRows li[data-person]')
    const order = () => rows.evaluateAll(items => items.map(item => (item as HTMLElement).dataset.person))
    const showPeople = async () => { await page.locator('#railPeople').click() }
    const avatar = page.locator(`#peopleRows li[data-person="${top}"] img`)
    const pictureIsLoaded = () => avatar.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)
    await signInAccount(page, baseURL!)
    await showPeople()
    // Messages come first, unread above read, in the inbox's own order (C9).
    await expect.poll(order).toEqual([incoming, top, latest])
    await expect(rows.first().getByRole('button')).toHaveAccessibleName(/message request/)
    await expect(avatar).toBeAttached()
    await expect.poll(pictureIsLoaded).toBe(true)
    await rows.first().getByRole('button').first().click()
    await expect(page.getByText('Unread message', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Back to people' }).click()
    await expect.poll(order).toEqual([top, latest, incoming])

    await page.reload()
    await showPeople()
    await expect.poll(order).toEqual([top, latest, incoming])
    await expect(avatar).toBeAttached()
    await expect.poll(pictureIsLoaded).toBe(true)
    expect(imageRequests).toBe(1)
  } finally {
    pool.close()
    await context.close()
    if (profile) await rm(profile, { recursive: true, force: true })
  }
})

test('People prompts for a relay list without publishing one and remembers turning the inbox off', async ({ browser, baseURL }, info) => {
  const account = generateSecretKey(), peer = generateSecretKey(), self = getPublicKey(account)
  const context = await accountDevice(browser, baseURL!, account), pool = new NostrRelayPool([TEST_RELAY_WS])
  const requests: Filter[] = [], lists: Event[] = []
  try {
    const page = await context.newPage()
    if (info.project.name === 'chromium-desktop') await page.setViewportSize({ width: 1100, height: 840 })
    page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
      const [command, value, ...filters] = JSON.parse(String(payload))
      if (command === 'EVENT' && value.kind === 10050) lists.push(value)
      if (command === 'REQ') requests.push(...filters.filter((filter: Filter) => filter.kinds?.includes(1059) &&
        filter['#p']?.includes(self) && filter.limit === 128))
    }))
    const badge = page.locator('#railPeopleCount')
    const open = async () => { await page.locator('#railPeople').click() }
    const line = page.locator('#peopleInboxLine')
    await signInAccount(page, baseURL!)
    await open()
    await expect(line).toContainText('Set up your Nostr inbox to get messages.')
    expect(lists).toEqual([])
    expect(requests).toEqual([])
    await inboxList(pool, account, baseURL!)
    await pool.publish(wrapEvent({ kind: 14, created_at: Math.floor(Date.now() / 1000), tags: [['p', self]], content: 'Now my inbox is set up' }, peer, self))
    await page.reload()
    await expect(badge).toHaveText('1')
    await openSettings(page, 'Account')
    await page.locator('#nostrInboxSwitch').uncheck()
    await expect(badge).toBeHidden()
    const beforeReload = requests.length
    await page.reload()
    await open()
    await expect(line).toContainText('Your Nostr inbox is off on this device.')
    const on = line.getByRole('button', { name: 'Turn on', exact: true })
    await expect(on).toBeVisible()
    await expect(badge).toBeHidden()
    expect(requests).toHaveLength(beforeReload)
    await on.click()
    await expect(badge).toHaveText('1')
    expect(lists).toEqual([])
    await expect.poll(() => requests.length).toBe(beforeReload + 1)
  } finally { pool.close(); await context.close() }
})

test('People offers a private node chat through the public inbox, then asks before contacting the node', async ({ browser, baseURL }, info) => {
  const creator = generateSecretKey(), guest = generateSecretKey()
  const sender = getPublicKey(creator), recipient = getPublicKey(guest), now = Math.floor(Date.now() / 1000)
  const ownerContext = await accountDevice(browser, baseURL!, creator), guestContext = await accountDevice(browser, baseURL!, guest)
  const pool = new NostrRelayPool([TEST_RELAY_WS]), node = 'https://node.example'
  const serviceKey = getPublicKey(generateSecretKey()), ownerRequests: string[] = [], guestSockets: string[] = []
  const publicEvents: Event[] = []
  try {
    await inboxList(pool, creator, baseURL!); await inboxList(pool, guest, baseURL!)
    await pool.publish(wrapEvent({ kind: 14, created_at: now, tags: [['p', sender]], content: 'Could we continue in KithMoot?' }, guest, sender))
    await ownerContext.route(`${node}/**`, async route => {
      const allowed = { 'Access-Control-Allow-Origin': new URL(baseURL!).origin,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
      if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: allowed }); return }
      const path = new URL(route.request().url()).pathname
      ownerRequests.push(path)
      const answer = path === '/node/v1/enrol' ? { enrolled: true } : path === '/groups/v1/events' ? { accepted: true } : undefined
      await route.fulfill({ status: answer ? 200 : 403, json: answer ?? {}, headers: allowed })
    })
    await guestContext.routeWebSocket('wss://node.example/events', socket => { guestSockets.push(socket.url()); socket.close() })
    const owner = await ownerContext.newPage(), guestPage = await guestContext.newPage()
    if (info.project.name === 'chromium-desktop') {
      await owner.setViewportSize({ width: 1100, height: 840 })
      await guestPage.setViewportSize({ width: 1100, height: 840 })
    }
    owner.on('websocket', socket => {
      if (new URL(socket.url()).pathname !== '/__test-relay') return
      socket.on('framesent', ({ payload }) => {
        try { const frame = JSON.parse(String(payload)); if (frame[0] === 'EVENT') publicEvents.push(frame[1]) } catch { /* Browser probe. */ }
      })
    })
    await signInAccount(owner, baseURL!); await signInAccount(guestPage, baseURL!)
    await owner.evaluate(pair => localStorage.setItem('kithmoot.node-pair.v1.' + pair.owner, JSON.stringify(pair)), { v: 1, owner: sender, origin: node, serviceKey })
    await owner.locator('#railPeople').click()
    await guestPage.locator('#railChats').click()
    await owner.locator(`#peopleRows li[data-person="${recipient}"] button`).first().click()
    await owner.locator('#peopleInvite').click()
    await owner.getByRole('menuitem', { name: /^A private chat/ }).click()
    await owner.getByRole('button', { name: 'Send invitation', exact: true }).click()
    const accept = guestPage.locator('#chatInvitations').getByRole('button', { name: /^Accept private chat with / })
    await expect(accept).toBeVisible({ timeout: 30_000 })
    expect(ownerRequests).toContain('/node/v1/enrol')
    expect(ownerRequests).toContain('/groups/v1/events')
    // The note goes first (P8), then the invitation itself.
    const rumours = publicEvents.filter(event => event.kind === 1059 && event.tags[0]?.[1] === recipient).map(event => unwrapEvent(event, guest))
    expect(rumours[0]).toMatchObject({ kind: 14, content: "I've invited you to a private chat on KithMoot." })
    const invitation = rumours.find(rumor => rumor.tags.some(tag => tag[0] === 'kithmoot-invitation'))!
    const pinned = parseNodeRoomLink(invitation.content, Math.floor(Date.now() / 1000))!
    expect(invitation.tags).toEqual([['p', recipient], ['kithmoot-invitation', '2', pinned.room]])
    expect(pinned.relay).toBe('wss://node.example/events')
    expect(pinned.existing?.policy).toEqual(dmPolicy(sender, recipient))
    expect(publicEvents.filter(event => event.tags.some(tag => tag.includes(pinned.room)))).toEqual([])
    expect(guestSockets).toEqual([])
    await accept.click()
    await expect(guestPage.getByText(/This room is hosted on node\.example/)).toBeVisible()
    expect(guestSockets).toEqual([])
    await guestPage.getByRole('button', { name: 'Ask to join', exact: true }).click()
    await expect.poll(() => guestSockets).toContain('wss://node.example/events')
  } finally { pool.close(); await Promise.all([ownerContext.close(), guestContext.close()]) }
})

test('People authenticates only with the published Nostr inbox relay that asks', async ({ browser, baseURL }) => {
  const account = generateSecretKey(), peer = generateSecretKey(), self = getPublicKey(account)
  const context = await accountDevice(browser, baseURL!, account), pool = new NostrRelayPool([TEST_RELAY_WS])
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const challenge = 'people-inbox-challenge', writes: Event[] = []
  try {
    await inboxList(pool, account, baseURL!)
    const copy = wrapEvent({ kind: 14, created_at: Math.floor(Date.now() / 1000), tags: [['p', self]], content: 'Behind AUTH' }, peer, self)
    await context.routeWebSocket(relay.href, browserSocket => {
      const server = browserSocket.connectToServer()
      let authenticated = false
      browserSocket.send(JSON.stringify(['AUTH', challenge]))
      browserSocket.onMessage(raw => {
        const message = JSON.parse(String(raw))
        if (message[0] === 'AUTH') {
          const event = message[1] as Event
          writes.push(event)
          authenticated = event.kind === 22242 && event.pubkey === self && verifyEvent(event) &&
            event.tags.some(tag => tag[0] === 'relay' && tag[1] === relay.href) &&
            event.tags.some(tag => tag[0] === 'challenge' && tag[1] === challenge)
          browserSocket.send(JSON.stringify(['OK', event.id, authenticated, '']))
        } else if (message[0] === 'REQ' && message.slice(2).some((f: Filter) => f.limit === 128 && f.kinds?.includes(1059) && f['#p']?.includes(self))) {
          const id = message[1]
          if (authenticated) {
            browserSocket.send(JSON.stringify(['EVENT', id, copy]))
            browserSocket.send(JSON.stringify(['EOSE', id]))
          } else browserSocket.send(JSON.stringify(['CLOSED', id, 'auth-required: inbox owner only']))
        } else server.send(raw)
      })
    })
    const page = await context.newPage()
    await signInAccount(page, baseURL!)
    await expect(page.locator('#railPeopleCount')).toHaveText('1')
    expect(writes).toHaveLength(1)
  } finally { pool.close(); await context.close() }
})

test('desktop People messaging works with the built-in in-memory signer', async ({ browser, baseURL }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'Exercises the built-in sign-in path in the desktop build')
  const account = generateSecretKey(), peer = generateSecretKey(), self = getPublicKey(account), other = getPublicKey(peer)
  const context = await accountDevice(browser, baseURL!, account), pool = new NostrRelayPool([TEST_RELAY_WS])
  try {
    await inboxList(pool, account, baseURL!); await inboxList(pool, peer, baseURL!)
    await pool.publish(wrapEvent({ kind: 14, created_at: Math.floor(Date.now() / 1000), tags: [['p', self]], content: 'From an independent key' }, peer, self))
    const page = await context.newPage(), sent = writes(page)
    await page.setViewportSize({ width: 1100, height: 840 })
    await page.goto(baseURL! + '?signin=nostr')
    await page.getByRole('button', { name: 'Advanced', exact: true }).click()
    await page.getByRole('button', { name: /Paste private key/ }).click()
    await page.locator('#signet-login-nsec-input').fill(Buffer.from(account).toString('hex'))
    await page.getByRole('dialog').getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.locator('#homeSignIn')).toBeHidden()
    await page.locator('#railPeople').click()
    await page.locator(`#peopleRows li[data-person="${other}"] button`).first().click()
    await expect(page.getByText('From an independent key', { exact: true })).toBeVisible()
    const reply = page.locator('#peopleThread').getByRole('textbox')
    await reply.fill('Reply from the desktop build'); await reply.press('Enter')
    await expect(page.locator('#peopleThread')).toContainText('Sent to their inbox relay')
    expect(unwrapEvent(sent.find(event => event.tags[0]?.[1] === other)!, peer).content).toBe('Reply from the desktop build')
  } finally { pool.close(); await context.close() }
})

// Built actual app and real loopback relay, using the existing declared
// synthetic NIP07/default-WS fixture. Not an external-client or physical proof.
test('ordinary incoming text is literal, retained encrypted and replied to through explicit public controls', async ({ browser, baseURL }) => {
  const account = generateSecretKey(), peer = generateSecretKey(), self = getPublicKey(account)
  const starts: string[] = []
  const context = await accountDevice(browser, baseURL!, account, true, undefined, undefined, undefined, { started: (_peer, text) => { starts.push(text) } }), pool = new NostrRelayPool([TEST_RELAY_WS])
  try {
    await useManualSettingsInbox(context, self)
    await inboxList(pool, account, baseURL!); await inboxList(pool, peer, baseURL!)
    const text = '<img src="https://ordinary-inbox.invalid/pixel">\nhttps://ordinary-inbox.invalid/literal'
    const copy = wrapEvent({ kind: 14, created_at: Math.floor(Date.now() / 1000), tags: [['p', self]], content: text }, peer, self)
    const seal = JSON.parse(decrypt(copy.content, getConversationKey(account, copy.pubkey))) as Event
    const layerStarts = () => starts.filter(text => text === copy.content || text === seal.content).length
    await pool.publish(copy)
    const page = await context.newPage(), published = writes(page), requested: string[] = []
    page.on('request', request => { if (request.url().includes('ordinary-inbox.invalid')) requested.push(request.url()) })
    await signInAccount(page, baseURL!); await showInbox(page)
    // Observe original storage at the actual browser send boundary; the
    // existing socket/provider fixtures remain explicitly synthetic.
    await page.evaluate(key => {
      const audit = window as typeof window & { ordinaryCopyAtWrite?: { id: string; raw: string | null }[] }
      audit.ordinaryCopyAtWrite = []
      const send = WebSocket.prototype.send
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string') {
          try {
            const frame = JSON.parse(data)
            if (frame[0] === 'EVENT' && frame[1]?.kind === 1059) audit.ordinaryCopyAtWrite!.push({ id: frame[1].id, raw: localStorage.getItem(key) })
          } catch { /* Other traffic is not a message write. */ }
        }
        return send.call(this, data)
      }
    }, ordinaryHistoryKey(self))
    await expect(page.locator('#nostrInboxList')).toBeEmpty(); expect(layerStarts()).toBe(0)
    await page.locator('#nostrInboxLoad').click()
    const row = page.locator('#nostrInboxList > li').filter({ has: page.locator('.ordinaryMessageOpen') })
    await expect(row).toHaveCount(1); await expect(row.locator('.ordinaryMessageText')).toBeHidden(); expect(layerStarts()).toBe(0)
    await row.getByRole('button', { name: 'Open message', exact: true }).click()
    await expect(row.locator('.ordinaryMessageText')).toHaveText(text); expect(layerStarts()).toBe(2)
    await expect(row.locator('img,a,video,audio,iframe')).toHaveCount(0); expect(requested).toEqual([])
    const saved = await page.evaluate(key => localStorage.getItem(key), ordinaryHistoryKey(self))
    expect(saved).not.toContain('ordinary-inbox.invalid'); expect(JSON.parse(saved!).events.some((event: Event) => event.id === copy.id)).toBe(true)
    await row.getByRole('button', { name: 'Reply on Nostr', exact: true }).click()
    await expect(page.locator('#nostrInboxDialog')).not.toBeVisible()
    // The reply opens the person's thread in People with an empty composer.
    // The inbox is off on this device, so the thread asks before it will send.
    await page.locator('#peopleThread').getByRole('button', { name: 'Turn on inbox' }).click()
    const reply = page.locator('#peopleThread').getByRole('textbox')
    await expect(reply).toHaveValue('')
    await reply.fill('Explicit ordinary reply')
    expect(published).toEqual([])
    await reply.press('Enter')
    await expect(page.locator('#peopleThread')).toContainText('Sent to their inbox relay')
    await expect(page.locator('#peopleThread')).not.toContainText('Syncing your copy')
    await expect.poll(() => new Set(published.map(event => event.id)).size).toBe(2)
    const received = [...new Map(published.map(event => [event.id, event])).values()]
    expect(received).toHaveLength(2)
    const toPeer = received.find(event => event.tags[0]?.[1] === getPublicKey(peer))!
    const rumor = unwrapEvent(toPeer, peer)
    expect(rumor).toMatchObject({ kind: 14, pubkey: self, content: 'Explicit ordinary reply', tags: [['p', getPublicKey(peer)]] })
    const history = JSON.parse((await page.evaluate(key => localStorage.getItem(key), ordinaryHistoryKey(self)))!)
    const selfCopy = received.find(event => event.tags[0]?.[1] === self)!
    expect(history.events.some((event: Event) => event.id === selfCopy.id)).toBe(true)
    const selfSeal = JSON.parse(decrypt(selfCopy.content, getConversationKey(account, selfCopy.pubkey))) as Event
    expect(starts.filter(text => text === selfCopy.content || text === selfSeal.content)).toEqual([])
    // Turning the People inbox on reads the copy again, as it does for any incoming message.
    expect(layerStarts()).toBeGreaterThanOrEqual(2)
    const atWrite = await page.evaluate(() => (window as typeof window & { ordinaryCopyAtWrite: { id: string; raw: string | null }[] }).ordinaryCopyAtWrite)
    expect(atWrite).toHaveLength(published.length)
    for (const write of atWrite) expect(JSON.parse(write.raw!).events.some((event: Event) => event.id === selfCopy.id)).toBe(true)
  } finally { pool.close(); await context.close() }
})

test('a fresh app reload can reopen its original cached ciphertext while new WebSocket connections are denied', async ({ browser, baseURL }) => {
  const account = generateSecretKey(), peer = generateSecretKey(), self = getPublicKey(account)
  const context = await accountDevice(browser, baseURL!, account), pool = new NostrRelayPool([TEST_RELAY_WS])
  try {
    await inboxList(pool, account, baseURL!)
    const text = 'History from the previous app lifetime', copy = wrapEvent({ kind: 14, created_at: Math.floor(Date.now() / 1000), tags: [['p', self]], content: text }, peer, self)
    await pool.publish(copy)
    const page = await context.newPage()
    await signInAccount(page, baseURL!); await showInbox(page); await page.locator('#nostrInboxLoad').click()
    await page.locator('.ordinaryMessageOpen').click(); await expect(page.locator('.ordinaryMessageText')).toHaveText(text)
    let denied = 0
    await context.routeWebSocket(/.*/, socket => { denied++; socket.close({ code: 1000, reason: 'Synthetic cached-history network denial' }) })
    // Install denial before reload, so the new app cannot reuse already-open
    // sockets from its initial account/default-relay startup.
    await page.reload(); await expect(page.locator('#signOut')).toHaveJSProperty('hidden', false)
    await showInbox(page); await expect(page.locator('#nostrInboxList')).toBeEmpty()
    await page.locator('#nostrInboxLoad').click()
    await expect(page.locator('.ordinaryMessageText')).toBeHidden()
    await page.locator('.ordinaryMessageOpen').click(); await expect(page.locator('.ordinaryMessageText')).toHaveText(text)
    await expect.poll(() => denied).toBeGreaterThan(0)
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).events[0].id, ordinaryHistoryKey(self))).toBe(copy.id)
  } finally { pool.close(); await context.close() }
})

test('a refused browser history write reports Not sent without publishing either prepared wrap', async ({ browser, baseURL }) => {
  const account = generateSecretKey(), peer = generateSecretKey()
  const context = await accountDevice(browser, baseURL!, account), pool = new NostrRelayPool([TEST_RELAY_WS])
  await context.addInitScript(() => {
    const set = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('kithmoot.ordinary-message-copies.v1.')) throw new DOMException('Synthetic cache quota', 'QuotaExceededError')
      return set.call(this, key, value)
    }
  })
  try {
    await inboxList(pool, account, baseURL!); await inboxList(pool, peer, baseURL!)
    const page = await context.newPage(), published = writes(page)
    await signInAccount(page, baseURL!)
    await openNpubThread(page, npubEncode(getPublicKey(peer)), getPublicKey(peer))
    const box = page.locator('#peopleThread').getByRole('textbox')
    await box.fill('Do not send without the retained copy'); await box.press('Enter')
    await expect(page.locator('#peopleThread')).toContainText('Not sent')
    expect(published).toEqual([])
  } finally { pool.close(); await context.close() }
})

async function invitationCopy(sender: Uint8Array, self: string) {
  const pubkey = getPublicKey(sender), now = Math.floor(Date.now() / 1000)
  const { invitation } = createRoomInvitation(true), { roomId } = deriveRoom(generateRoomSecret())
  const link = encodeRoomLink('https://kithmoot.example/j/', { invitation, relays: [TEST_RELAY_WS], iceUrls: [], policy: dmPolicy(pubkey, self) })
  const rumor = contactInvitationRumor(pubkey, self, roomId, link, now)
  const copy = await wrapContactInvitation(rumor, { pubkey, ...localPeerCrypt(sender), signEvent: async event => finalizeEvent(event, sender) }, self, now, () => true)
  return { rumor, copy, link }
}

test('account-relay invitation checking is explicit and never substitutes for an empty published inbox list', async ({ browser, baseURL }) => {
  const account = generateSecretKey(), peer = generateSecretKey(), self = getPublicKey(account), starts: string[] = []
  const context = await accountDevice(browser, baseURL!, account, true, undefined, undefined, undefined, { started: (_peer, text) => { starts.push(text) } })
  const pool = new NostrRelayPool([TEST_RELAY_WS])
  const allReads: unknown[][] = [], reads: unknown[][] = []
  // Existing project state has its own labelled subscriptions at sign-in.
  // Exempt only this exact filter; an extra/mixed filter still counts as a read.
  const catalogue: Filter = { kinds: [1059], '#p': [self], '#l': ['kithmoot.projects.v1', 'kithmoot.project-logo.v1'] }
  const canonical = (value: object) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
  const catalogueOnly = (frame: unknown[]) => frame.length > 2 && frame.slice(2).every(filter =>
    filter !== null && typeof filter === 'object' && !Array.isArray(filter) && canonical(filter) === canonical(catalogue))
  const potentialOrdinaryRead = (frame: unknown[]) => {
    if (typeof frame[1] !== 'string' || frame[1].length === 0 || frame.length <= 2) return true
    return !catalogueOnly(frame) && frame.slice(2).some(filter => {
      // Missing kinds is a wildcard. Unknown/malformed filters must count,
      // rather than disappearing from the no-fallback assertion.
      if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) return true
      const kinds = (filter as { kinds?: unknown }).kinds
      return kinds === undefined || !Array.isArray(kinds) ||
        kinds.some(kind => typeof kind !== 'number' || !Number.isInteger(kind)) || kinds.includes(1059)
    })
  }
  try {
    const invite = await invitationCopy(peer, self)
    expect(matchFilter(catalogue, invite.copy)).toBe(false)
    expect(catalogueOnly(['REQ', 'catalogue-only-control', catalogue])).toBe(true)
    expect(catalogueOnly(['REQ', 'mixed-control', catalogue, { kinds: [1059], '#p': [self] }])).toBe(false)
    expect(potentialOrdinaryRead(['REQ', 'catalogue-only-control', catalogue])).toBe(false)
    expect(potentialOrdinaryRead(['REQ', 'mixed-control', catalogue, { kinds: [1059], '#p': [self] }])).toBe(true)
    expect(matchFilter({ '#p': [self] }, invite.copy)).toBe(true)
    expect(potentialOrdinaryRead(['REQ', 'wildcard-control', { '#p': [self] }])).toBe(true)
    expect(potentialOrdinaryRead(['REQ', 'malformed-mixed-control', null, { kinds: [1059] }])).toBe(true)
    expect(potentialOrdinaryRead(['REQ', 'malformed-kinds-control', { kinds: '1059' }])).toBe(true)
    expect(potentialOrdinaryRead(['REQ', 'missing-filter-control'])).toBe(true)
    expect(potentialOrdinaryRead(['REQ', '', catalogue])).toBe(true)
    expect(potentialOrdinaryRead(['REQ', 'public-notes-control', { kinds: [1] }])).toBe(false)
    const seal = JSON.parse(decrypt(invite.copy.content, getConversationKey(account, invite.copy.pubkey))) as Event
    const opening = () => starts.filter(text => text === invite.copy.content || text === seal.content).length
    await pool.publish(finalizeEvent({ kind: 10050, created_at: Math.floor(Date.now() / 1000), tags: [], content: '' }, account))
    await pool.publish(invite.copy)
    const page = await context.newPage()
    page.on('websocket', socket => socket.on('framesent', frame => {
      let value: unknown
      try { value = JSON.parse(String(frame.payload)) }
      catch { return /* Non-JSON frames cannot be Nostr REQs. */ }
      if (!Array.isArray(value) || value[0] !== 'REQ') return
      allReads.push(value)
      if (potentialOrdinaryRead(value)) reads.push(value)
    }))
    // The Settings-relay view is retired: only the explicit account-relay check remains, and signing in reads nothing for it.
    await signInAccount(page, baseURL!); await openSettings(page, 'Account'); expect(opening()).toBe(0)
    expect(reads).toEqual([])
    // This is a visible Account control, available without a room/hidden-sheet hook.
    await page.getByRole('button', { name: 'Check invitations on account relays', exact: true }).click()
    await expect(page.locator('#nostrInboxStatus')).toContainText('does not use or replace')
    expect(reads).toEqual([]); expect(opening()).toBe(0)
    await page.getByRole('button', { name: 'Load account messages', exact: true }).click()
    const row = page.locator('#nostrInboxList > li')
    await expect(row).toHaveCount(1); expect(reads.length).toBeGreaterThan(0); expect(opening()).toBe(0)
    expect(reads.some(frame => matchFilters(frame.slice(2) as Filter[], invite.copy))).toBe(true)
    await row.getByRole('button', { name: 'Open message', exact: true }).click()
    await expect(row.locator('.ordinaryInvitationReview')).toBeVisible(); expect(opening()).toBe(2)
    await expect(row.locator('.ordinaryMessageText')).toBeHidden(); await expect(page.locator('#roomArea')).toBeHidden()
    const raw = await page.evaluate(key => localStorage.getItem(key), `kithmoot.contact-inbox.v1.${self}`)
    expect(raw).not.toContain(invite.link)
    await row.locator('.ordinaryInvitationReview').click()
    const pending = page.getByRole('navigation', { name: 'Chats' }).locator(`li[data-invitation="${invite.rumor.id}"]`)
    await expect(pending).toHaveCount(1); await expect(pending.locator('button[data-action="accept"]')).toBeVisible()
    await expect(page.locator('#roomArea')).toBeHidden()
  } finally {
    try { await test.info().attach('all-native-requests', { body: JSON.stringify(allReads, null, 2), contentType: 'application/json' }) }
    finally { pool.close(); await context.close() }
  }
})

test('closing the actual inbox during a pending inner invitation decrypt cannot keep or join it', async ({ browser, baseURL }) => {
  const account = generateSecretKey(), peer = generateSecretKey(), self = getPublicKey(account)
  const invite = await invitationCopy(peer, self), seal = JSON.parse(decrypt(invite.copy.content, getConversationKey(account, invite.copy.pubkey))) as Event
  let release!: () => void, entered = false
  const gate = new Promise<void>(resolve => { release = resolve }), starts: string[] = []
  const context = await accountDevice(browser, baseURL!, account, true, undefined, undefined, undefined, {
    started: (_peer, text) => { starts.push(text) },
    decrypt: async (peer, text) => { if (text === seal.content) { entered = true; await gate }; return decrypt(text, getConversationKey(account, peer)) },
  })
  const pool = new NostrRelayPool([TEST_RELAY_WS])
  try {
    await useManualSettingsInbox(context, self)
    await inboxList(pool, account, baseURL!); await pool.publish(invite.copy)
    const page = await context.newPage(); await signInAccount(page, baseURL!); await showInbox(page)
    const before = await page.evaluate(key => localStorage.getItem(key), `kithmoot.contact-inbox.v1.${self}`)
    await page.locator('#nostrInboxLoad').click(); await page.locator('.ordinaryMessageOpen').click()
    await expect.poll(() => entered).toBe(true)
    await page.locator('#nostrInboxClose').click(); release()
    // The same real app must regain its history writer hold, retain only the
    // original encrypted copy and require a new explicit Open.
    await showInbox(page); await page.locator('#nostrInboxLoad').click()
    await expect(page.locator('.ordinaryMessageOpen')).toBeVisible()
    await expect(page.locator('.ordinaryInvitationReview')).toBeHidden()
    expect(await page.evaluate(key => localStorage.getItem(key), `kithmoot.contact-inbox.v1.${self}`)).toBe(before)
    expect(starts.filter(text => text === invite.copy.content || text === seal.content)).toHaveLength(2)
    await expect(page.locator('#roomArea')).toBeHidden()
  } finally { release(); pool.close(); await context.close() }
})

test('two actual inbox panes respect the account writer hold without replacing saved ciphertext', async ({ browser, baseURL }) => {
  const account = generateSecretKey(), peer = generateSecretKey(), self = getPublicKey(account)
  const context = await accountDevice(browser, baseURL!, account), pool = new NostrRelayPool([TEST_RELAY_WS])
  try {
    await useManualSettingsInbox(context, self)
    await inboxList(pool, account, baseURL!)
    const copy = wrapEvent({ kind: 14, created_at: Math.floor(Date.now() / 1000), tags: [['p', self]], content: 'Shared writer guard' }, peer, self)
    await pool.publish(copy)
    const first = await context.newPage(); await signInAccount(first, baseURL!); await showInbox(first); await first.locator('#nostrInboxLoad').click()
    await expect(first.locator('.ordinaryMessageOpen')).toBeVisible()
    const original = await first.evaluate(key => localStorage.getItem(key), ordinaryHistoryKey(self))
    const second = await context.newPage(); await second.goto(baseURL!)
    await expect(second.locator('#signOut')).toHaveJSProperty('hidden', false)
    await showInbox(second); await second.locator('#nostrInboxLoad').click()
    await expect(second.locator('#nostrInboxStatus')).toContainText('Close other inbox tabs')
    expect(await second.evaluate(key => localStorage.getItem(key), ordinaryHistoryKey(self))).toBe(original)
    await first.locator('#nostrInboxClose').click(); await second.locator('#nostrInboxLoad').click()
    await expect(second.locator('.ordinaryMessageOpen')).toBeVisible()
    await second.locator('.ordinaryMessageOpen').click(); await expect(second.locator('.ordinaryMessageText')).toHaveText('Shared writer guard')
    expect(await second.evaluate(key => localStorage.getItem(key), ordinaryHistoryKey(self))).toBe(original)
  } finally { pool.close(); await context.close() }
})
