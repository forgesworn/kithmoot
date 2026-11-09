import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { newDeviceContext, openNewRoomForm, requestAdmission, leaveToChats, openMember, nameCreator, chooseInviteRoom, leaveRoom } from './browser.js'
import { testRelaysFor, TEST_RELAY_WS } from './relays.js'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils'
import { accountDevice, signInAccount } from './nostr-account.js'
import { RoomAgent } from '../src/agent.js'
import { localIdentity } from '../src/identity.js'
import { deriveRoom, generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { localPeerCrypt, sealInvite } from '../src/dm.js'

for (const retainedVisitor of [false, true]) {
  test(`an account invite waits for its signer while the room opens on its pass (${retainedVisitor ? 'retained visitor key' : 'no visitor key'})`, async ({ browser, baseURL }) => {
    const accountSk = generateSecretKey(), account = getPublicKey(accountSk), senderSk = generateSecretKey()
    let gate = Promise.resolve(), release = () => {}, restoring = false, ciphertext = '', inviteDecrypts = 0
    const context = await accountDevice(browser, baseURL!, accountSk, true, async () => { restoring = true; await gate }, undefined, undefined,
      { started: (_peer, encrypted) => { if (encrypted === ciphertext) inviteDecrypts++ } })
    const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Shared signed identity', relays: testRelaysFor(baseURL!)!, iceUrls: [] })
    const sender = await RoomAgent.join({ link, relays: [TEST_RELAY_WS], name: 'Rowan', identity: localIdentity(senderSk), agent: false })
    try {
      const page = await context.newPage()
      await signInAccount(page, baseURL!)
      await page.goto(link); await page.reload()
      await page.locator('#join').click()
      await expect(page.locator('#roomArea')).toBeVisible()
      await leaveRoom(page)
      if (await page.locator('#actionConfirm').isVisible()) await page.locator('#actionConfirm').click()
      await expect(page.locator('#roomArea')).toBeHidden()

      const guest = retainedVisitor ? bytesToHex(generateSecretKey()) : null
      await page.evaluate(value => {
        if (value) localStorage.setItem('kithmoot.participant', value)
        else localStorage.removeItem('kithmoot.participant')
      }, guest)
      gate = new Promise<void>(resolve => { release = resolve }); restoring = false
      await page.goto('about:blank'); await page.goto(link)
      await expect.poll(() => restoring).toBe(true)
      await page.locator('#join').click()
      // The account's valid room pass works without waiting for its signer.
      await expect(page.locator('#roomArea')).toBeVisible()
      await page.locator('#chatInput').fill('Still speaking as my account on its pass')
      await page.locator('#chatInput').press('Enter')
      await expect.poll(() => sender.chat.messages().find(message => message.text === 'Still speaking as my account on its pass')?.participant).toBe(account)
      const targetSecret = generateRoomSecret(), targetRoom = deriveRoom(targetSecret).roomId
      const targetLink = encodeRoomLink(baseURL!, { secret: targetSecret, name: 'Deferred invitation', relays: testRelaysFor(baseURL!)!, iceUrls: [] })
      const invite = await sealInvite(targetLink, { to: account, room: targetRoom, crypt: localPeerCrypt(senderSk) })
      ciphertext = invite.link
      await sender.chat.send('Invited you to a room.', { invite })
      // Sealed invite statements are deliberately absent from the chat log;
      // a following ordinary message acknowledges the same live chat path.
      await sender.chat.send('The invitation was sent to your account')
      await expect(page.locator('#chatLog')).toContainText('The invitation was sent to your account')
      expect(inviteDecrypts).toBe(0)
      expect(await page.evaluate(value => localStorage.getItem('kithmoot.participant') === value, guest)).toBe(true)
      const destinationKey = `kithmoot.account.${account}.kithmoot.room.${targetRoom}`
      expect(await page.evaluate(key => localStorage.getItem(key), destinationKey)).toBeNull()

      release()
      // No reload or room switch: the same invitation must be retried when
      // this account's signer is restored, never decrypted with a guest key.
      await expect.poll(() => inviteDecrypts).toBeGreaterThan(0)
      await expect.poll(() => page.evaluate(key => localStorage.getItem(key), destinationKey)).toContain('Deferred invitation')
      await expect(page.locator('#roomArea')).toBeVisible()
      await expect(page.locator('#roomTitle')).toHaveText('Shared signed identity')
      expect(await page.evaluate(value => localStorage.getItem('kithmoot.participant') === value, guest)).toBe(true)
    } finally { release(); await context.close(); await sender.leave() }
  })
}

// A private room: a room that asks first, whose link is never handed out.
// People get in by being invited from a room they share with somebody in
// it, and an invited person is let straight in without the card.
test('somebody invited from a shared room is let straight into a room that asks first', async ({ browser, baseURL }) => {
  test.setTimeout(240_000)
  const a = await newDeviceContext(browser, baseURL!), b = await newDeviceContext(browser, baseURL!)
  // Passive fixture observations: preserve the original admission assertions.
  // Sequence numbers describe observer receipt order, not wire linearisation.
  const observations: Record<string, unknown>[] = []
  const pages: { side: string; page: Page }[] = []
  let sequence = 0, socketId = 0, payloadBytes = 0, complete = true
  const record = (value: Record<string, unknown>) => {
    if (observations.length >= 10_000) { complete = false; return }
    observations.push({ sequence: ++sequence, observedAt: Date.now(), ...value })
  }
  const observe = (context: BrowserContext, side: string) => context.on('page', page => {
    pages.push({ side, page })
    page.on('pageerror', error => record({ side, type: 'page-error', message: error.message }))
    page.on('websocket', socket => {
      const id = ++socketId, url = new URL(socket.url())
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      record({ side, type: 'socket', socket: id, origin: url.origin, path: url.pathname, local })
      socket.on('socketerror', error => record({ side, type: 'socket-error', socket: id, message: error }))
      if (!local) { complete = false; return }
      const frameObserved = (direction: 'framesent' | 'framereceived', frame: { payload: string | Buffer }) => {
        const bytes = Buffer.from(frame.payload)
        const retained = bytes.length <= 65_536 && payloadBytes + bytes.length <= 8_388_608
        if (!retained) complete = false
        else payloadBytes += bytes.length
        record({ side, type: 'frame', socket: id, direction, bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'), retained,
          encoding: typeof frame.payload === 'string' ? 'text' : 'base64',
          ...(retained ? { payload: typeof frame.payload === 'string' ? frame.payload : bytes.toString('base64') } : {}),
        })
      }
      socket.on('framesent', frame => frameObserved('framesent', frame))
      socket.on('framereceived', frame => frameObserved('framereceived', frame))
      socket.on('close', () => record({ side, type: 'socket-close', socket: id }))
    })
  })
  observe(a, 'host'); observe(b, 'guest')
  try {
    const relays = testRelaysFor(baseURL!)
    const ada = await a.newPage()
    if (relays) await ada.addInitScript(urls => localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: urls.map(url => ({ url, read: true, write: true })) })), relays)
    await ada.addInitScript(() => localStorage.setItem('kithmoot.name', 'Ada'))

    // The private room, made and entered once so it is saved on Ada's device.
    await ada.goto(baseURL!)
    await openNewRoomForm(ada)
    await ada.locator('#roomName').fill('Private build')
    await ada.locator('#roomAsk').check()
    await nameCreator(ada, 'Ada')
    await ada.locator('#create').click()
    await expect(ada.locator('#roomArea')).toBeVisible({ timeout: 60_000 })

    // The shared room, where Ada and Rowan meet.
    await leaveToChats(ada)
    await openNewRoomForm(ada)
    await ada.locator('#roomName').fill('Shared')
    await ada.locator('#create').click()
    await expect(ada.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    const shared = ada.locator('#shareUrl')
    await expect.poll(async () => (await shared.inputValue()).length).toBeGreaterThan(0)
    const sharedLink = await shared.inputValue()

    const rowan = await b.newPage()
    await rowan.addInitScript(() => localStorage.setItem('kithmoot.name', 'Rowan'))
    await rowan.goto(sharedLink)
    await expect(rowan.locator('#join')).toBeVisible({ timeout: 60_000 })
    await rowan.locator('#join').click()
    await expect(rowan.locator('#roomArea')).toBeVisible()

    // Ada invites Rowan to the private room from Rowan's row.
    await openMember(ada, 'Rowan')
    await ada.getByRole('button', { name: 'Invite Rowan to a room', exact: true }).click({ timeout: 60_000 })
    await chooseInviteRoom(ada, 'Private build')
    await ada.locator('#roomSheetClose').click()
    await expect(ada.locator('#chatLog')).toContainText('You invited Rowan to Private build.')
    await expect(rowan.locator('#chatLog')).toContainText('invited you to Private build', { timeout: 60_000 })

    // Ada goes back to the private room, so her device is answering its
    // link. Once the invite has been confirmed sent, or switching asks
    // about unsent work.
    await expect(ada.locator('#outbox')).toBeHidden({ timeout: 60_000 })
    await leaveToChats(ada)
    await ada.getByRole('button', { name: 'Open Private build', exact: true }).click()
    await expect(ada.locator('#roomTitle')).toHaveText('Private build', { timeout: 60_000 })
    await expect(ada.locator('#roomArea')).toBeVisible({ timeout: 60_000 })

    // Rowan opens it from their rooms and is let straight in: no card.
    await leaveToChats(rowan)
    await rowan.getByRole('button', { name: 'Open Private build', exact: true }).click()
    await requestAdmission(rowan)
    // Saved rooms now join automatically. Verify admitted membership and
    // the host acknowledgement rather than the transient door status.
    await expect(rowan.locator('#roomArea')).toBeVisible({ timeout: 90_000 })
    await expect(ada.locator('#approvals .approvalCard.knock')).toHaveCount(0)
    await expect(ada.locator('#chatLog')).toContainText('Invitation sent to Rowan.')
    await expect(rowan.locator('#roomArea')).toBeVisible()
    await expect(rowan.locator('#roomTitle')).toHaveText('Private build')
  } finally {
    // Read only after the original journey has passed or failed, before teardown.
    for (const { side, page } of pages) {
      try {
        const state = await page.evaluate(() => ({
          ui: Object.fromEntries(['status', 'roomTitle', 'roomArea', 'requestAdmission', 'admissionPreviewStatus', 'approvals', 'outbox'].map(id => {
            const element = document.getElementById(id)
            return [id, element ? { text: element.textContent, hidden: element.hidden, visible: element.getClientRects().length > 0 } : null]
          })),
          // Only public participant allowlists and boolean room policy; no keys,
          // bearer links, room secrets, grants or general storage dump.
          invited: Object.fromEntries(Object.keys(localStorage).flatMap(key => {
            const room = /kithmoot\.invited\.v1\.([0-9a-f]{64})$/.exec(key)?.[1]
            if (!room) return []
            try {
              const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
              return [[room, Array.isArray(value) && value.every(p => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p)) ? value : 'invalid']]
            } catch { return [[room, 'invalid']] }
          })),
          knock: Object.fromEntries(Object.keys(localStorage).flatMap(key => {
            const room = /kithmoot\.knock\.v1\.([0-9a-f]{64})$/.exec(key)?.[1]
            if (!room) return []
            const value = localStorage.getItem(key)
            return [[room, value === 'true' ? true : value === 'false' ? false : 'invalid']]
          })),
        }))
        record({ side, type: 'final-state', state })
      } catch (error) { complete = false; record({ side, type: 'snapshot-error', message: String(error) }) }
    }
    try {
      await test.info().attach('admission-native-frames-and-state', {
        body: Buffer.from(JSON.stringify({ schemaVersion: 1, complete, payloadBytes, observations }, null, 2)),
        contentType: 'application/json',
      })
    } finally { await a.close(); await b.close() }
  }
})
