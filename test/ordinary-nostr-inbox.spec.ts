import { test, expect, type Page } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { wrapEvent } from 'nostr-tools/nip59'
import { decrypt, getConversationKey } from 'nostr-tools/nip44'
import { unwrapEvent } from 'nostr-tools/nip17'
import { matchFilter, matchFilters, type Filter } from 'nostr-tools/filter'
import { NostrRelayPool } from '../src/relay-pool.js'
import { accountDevice, signInAccount } from './nostr-account.js'
import { TEST_RELAY_WS, openSettings } from './browser.js'
import { createRoomInvitation } from '../src/invitation.js'
import { deriveRoom, generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { dmPolicy, localPeerCrypt } from '../src/dm.js'
import { contactInvitationRumor, wrapContactInvitation } from '../src/contact-invitation.js'
import { ordinaryHistoryKey } from '../app/src/nostr-message-history.js'

async function showInbox(page: Page) {
  await openSettings(page, 'Account'); await page.getByRole('button', { name: 'Nostr messages', exact: true }).click()
  await expect(page.locator('#nostrInboxDialog')).toBeVisible()
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

// Built actual app and real loopback relay, using the existing declared
// synthetic NIP07/default-WS fixture. Not an external-client or physical proof.
test('ordinary incoming text is literal, retained encrypted and replied to through explicit public controls', async ({ browser, baseURL }) => {
  const account = generateSecretKey(), peer = generateSecretKey(), self = getPublicKey(account)
  const starts: string[] = []
  const context = await accountDevice(browser, baseURL!, account, true, undefined, undefined, undefined, { started: (_peer, text) => { starts.push(text) } }), pool = new NostrRelayPool([TEST_RELAY_WS])
  try {
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
    await row.getByRole('button', { name: 'Reply with public message', exact: true }).click()
    await expect(page.locator('#nostrInboxDialog')).not.toBeVisible()
    await expect(page.locator('#nostrMessageText')).toHaveValue('')
    await page.locator('#nostrMessageText').fill('Explicit ordinary reply')
    await page.locator('#nostrMessageReview').click()
    await expect(page.locator('#nostrMessageLane')).toHaveText('○ public'); expect(published).toEqual([])
    await page.locator('#nostrMessageSend').click()
    await expect(page.locator('#nostrMessageStatus')).toContainText('does not confirm')
    const received = [...new Map(published.map(event => [event.id, event])).values()]
    expect(received).toHaveLength(2)
    const toPeer = received.find(event => event.tags[0]?.[1] === getPublicKey(peer))!
    const rumor = unwrapEvent(toPeer, peer), original = unwrapEvent(copy, account)
    expect(rumor).toMatchObject({ kind: 14, pubkey: self, content: 'Explicit ordinary reply', tags: [['p', getPublicKey(peer)], ['e', original.id]] })
    const history = JSON.parse((await page.evaluate(key => localStorage.getItem(key), ordinaryHistoryKey(self)))!)
    const selfCopy = received.find(event => event.tags[0]?.[1] === self)!
    expect(history.events.some((event: Event) => event.id === selfCopy.id)).toBe(true)
    const selfSeal = JSON.parse(decrypt(selfCopy.content, getConversationKey(account, selfCopy.pubkey))) as Event
    expect(starts.filter(text => text === selfCopy.content || text === selfSeal.content)).toEqual([])
    expect(layerStarts()).toBe(2)
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

test('a refused browser history write holds Send public without publishing either prepared wrap', async ({ browser, baseURL }) => {
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
    await signInAccount(page, baseURL!); await openSettings(page, 'Account')
    await page.locator('#nostrMessageEntry').click()
    const { npubEncode } = await import('nostr-tools/nip19')
    await page.locator('#nostrMessageRecipient').fill(npubEncode(getPublicKey(peer)))
    await page.locator('#nostrMessageText').fill('Do not send without the retained copy')
    await page.locator('#nostrMessageReview').click(); await page.locator('#nostrMessageSend').click()
    await expect(page.locator('#nostrMessageStatus')).toContainText('Nothing was sent')
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
    if (typeof frame[1] !== 'string' || frame.length <= 2) return true
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
    await signInAccount(page, baseURL!); await showInbox(page); expect(opening()).toBe(0)
    expect(reads).toEqual([])
    await page.locator('#nostrInboxLoad').click()
    await expect(page.locator('#nostrInboxStatus')).toContainText('could not be read')
    expect(reads).toEqual([]); expect(opening()).toBe(0)
    await page.locator('#nostrInboxClose').click()
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
