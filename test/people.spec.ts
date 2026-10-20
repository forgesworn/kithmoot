import { test, expect, type Page } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { npubEncode } from 'nostr-tools/nip19'
import { NostrRelayPool } from '../src/relay-pool.js'
import { parseRoomLink } from '../src/link.js'
import { accountDevice, signInAccount } from './nostr-account.js'
import { TEST_RELAY_WS, openNewRoomForm, openRoomDetails } from './browser.js'

/** A key as the app shortens it when there is no name. */
const shortNpub = (pubkey: string): string => { const npub = npubEncode(pubkey); return `${npub.slice(0, 10)}…${npub.slice(-4)}` }

/** People, from the rail. */
async function openPeople(page: Page): Promise<void> {
  await page.locator('#railPeople').click()
  await expect(page.locator('#peopleList')).toBeVisible()
}

/** An account's public relay list for private invitations, a follow list
 *  and profiles, all on the test relay the app's public relays lead to. */
async function seed(publisher: NostrRelayPool, baseURL: string, keys: { account: Uint8Array; peers: Uint8Array[] }, follows: string[], names: Map<string, string>) {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const now = Math.floor(Date.now() / 1000)
  for (const key of [keys.account, ...keys.peers]) await publisher.publish(finalizeEvent({ kind: 10050, created_at: now, tags: [['relay', relay.href]], content: '' }, key))
  await publisher.publish(finalizeEvent({ kind: 3, created_at: now, tags: follows.map(p => ['p', p]), content: '' }, keys.account))
  for (const key of keys.peers) {
    const name = names.get(getPublicKey(key))
    if (name) await publisher.publish(finalizeEvent({ kind: 0, created_at: now, tags: [], content: JSON.stringify({ name }) }, key))
  }
}

test('People lists the people you follow, and Message starts a private chat with one', async ({ browser, baseURL }) => {
  const aKey = generateSecretKey(), bKey = generateSecretKey(), cKey = generateSecretKey()
  const a = getPublicKey(aKey), b = getPublicKey(bKey), c = getPublicKey(cKey)
  const publisher = new NostrRelayPool([TEST_RELAY_WS])
  const ac = await accountDevice(browser, baseURL!, aKey), bc = await accountDevice(browser, baseURL!, bKey)
  try {
    await seed(publisher, baseURL!, { account: aKey, peers: [bKey, cKey] }, [b, c, a], new Map([[b, 'Bob on Nostr']]))
    const alice = await ac.newPage(); await alice.setViewportSize({ width: 1280, height: 900 })
    await signInAccount(alice, baseURL!)
    await openPeople(alice)
    const rows = alice.locator('#peopleRows')
    await expect(rows.locator('li[data-section="Following"] h3')).toHaveText('Following')
    await expect(rows.getByRole('button', { name: 'Bob on Nostr', exact: true })).toBeVisible()
    // Someone with no profile is named by a shortened key, never in full;
    // the account itself is not listed although its own list names it.
    await expect(rows.locator(`li[data-person="${c}"]`)).toContainText(npubEncode(c).slice(0, 10))
    await expect(rows.locator(`li[data-person="${a}"]`)).toHaveCount(0)
    await alice.locator('#peopleQuery').fill('bob')
    await expect(rows.locator('li[data-person]')).toHaveCount(1)
    await alice.locator('#peopleQuery').fill('')

    await rows.getByRole('button', { name: /^Bob on Nostr/ }).click()
    await expect(alice.locator('#peoplePane h2')).toHaveText('Bob on Nostr')
    await expect(alice.locator('#peopleMessage')).toBeEnabled()
    await alice.screenshot({ path: test.info().outputPath('people-following.png') })
    await alice.locator('#peopleMessage').click()
    await expect(alice.locator('#roomArea')).toBeVisible()
    expect(parseRoomLink(alice.url()).policy?.members?.sort()).toEqual([a, b].sort())
    // Called by the person, not "Private: …" (design-calm-shell 6.2).
    await expect(alice.locator('#roomTitle')).toHaveText('Bob on Nostr')
    await expect(alice.locator('#roomWho')).toHaveText('Private chat')
    await expect(alice.locator('#roomList').getByRole('button', { name: 'Open Bob on Nostr', exact: true })).toBeVisible()
    await alice.locator('#chatInput').fill('Hello Bob, found you through who I follow')
    await alice.locator('#chatInput').press('Enter')
    await expect(alice.locator('#chatLog')).toContainText('Hello Bob, found you through who I follow')

    // Bob sees the request at the top of his chats. Alice is nobody he
    // knows, so she is shown by her key, not by any name she gives herself.
    const bob = await bc.newPage(); await bob.setViewportSize({ width: 1280, height: 900 }); await signInAccount(bob, baseURL!)
    const waiting = bob.locator('#chatInvitations li[data-invitation]')
    await expect(waiting).toHaveCount(1)
    await expect(waiting).toContainText(`${shortNpub(a)} invited you to a private chat`)
    await expect(waiting).toContainText('Sealed for you · ')
    await expect(bob.locator('#railChatsCount')).toHaveText('1')
    await bob.screenshot({ path: test.info().outputPath('invitation.png') })
    await waiting.getByRole('button', { name: `Accept private chat with ${shortNpub(a)}` }).click()
    await expect(bob.locator('#roomArea')).toBeVisible()
    await expect(bob.locator('#chatLog')).toContainText('Hello Bob, found you through who I follow')
    await expect(bob.locator('#chatInvitations')).toBeHidden()
  } finally { publisher.close(); await ac.close(); await bc.close() }
})

test('an invitation from somebody you follow carries their name, before People has ever been opened', async ({ browser, baseURL }) => {
  const aKey = generateSecretKey(), bKey = generateSecretKey()
  const a = getPublicKey(aKey), b = getPublicKey(bKey)
  const publisher = new NostrRelayPool([TEST_RELAY_WS])
  const ac = await accountDevice(browser, baseURL!, aKey), bc = await accountDevice(browser, baseURL!, bKey)
  try {
    await seed(publisher, baseURL!, { account: aKey, peers: [bKey] }, [b], new Map([[b, 'Bob on Nostr']]))
    // Bob follows Alice, whose profile names her.
    const now = Math.floor(Date.now() / 1000)
    await publisher.publish(finalizeEvent({ kind: 3, created_at: now, tags: [['p', a]], content: '' }, bKey))
    await publisher.publish(finalizeEvent({ kind: 0, created_at: now, tags: [], content: JSON.stringify({ name: 'Alice on Nostr' }) }, aKey))
    const alice = await ac.newPage(); await alice.setViewportSize({ width: 1280, height: 900 })
    await signInAccount(alice, baseURL!)
    await openPeople(alice)
    await alice.locator('#peopleRows').getByRole('button', { name: /^Bob on Nostr/ }).click()
    await alice.locator('#peopleMessage').click()
    await expect(alice.locator('#roomArea')).toBeVisible()

    const bob = await bc.newPage(); await bob.setViewportSize({ width: 1280, height: 900 }); await signInAccount(bob, baseURL!)
    const waiting = bob.locator('#chatInvitations li[data-invitation]')
    await expect(waiting).toContainText('Alice on Nostr invited you to a private chat')
    await expect(waiting.getByRole('button', { name: 'Accept private chat with Alice on Nostr' })).toBeVisible()
  } finally { publisher.close(); await ac.close(); await bc.close() }
})

test('Decline clears an invitation on this device and opens nothing', async ({ browser, baseURL }) => {
  const aKey = generateSecretKey(), bKey = generateSecretKey()
  const b = getPublicKey(bKey)
  const publisher = new NostrRelayPool([TEST_RELAY_WS])
  const ac = await accountDevice(browser, baseURL!, aKey), bc = await accountDevice(browser, baseURL!, bKey)
  try {
    await seed(publisher, baseURL!, { account: aKey, peers: [bKey] }, [b], new Map([[b, 'Bob on Nostr']]))
    const alice = await ac.newPage(); await alice.setViewportSize({ width: 1280, height: 900 })
    await signInAccount(alice, baseURL!)
    await openPeople(alice)
    await alice.locator('#peopleRows').getByRole('button', { name: /^Bob on Nostr/ }).click()
    await alice.locator('#peopleMessage').click()
    await expect(alice.locator('#roomArea')).toBeVisible()

    const bob = await bc.newPage(); await bob.setViewportSize({ width: 1280, height: 900 }); await signInAccount(bob, baseURL!)
    const waiting = bob.locator('#chatInvitations li[data-invitation]')
    await expect(waiting).toHaveCount(1)
    await waiting.locator('button[data-action="decline"]').click()
    await expect(bob.locator('#chatInvitations')).toBeHidden()
    await expect(bob.locator('#railChatsCount')).toBeHidden()
    await expect(bob.locator('#roomArea')).toBeHidden()
    await bob.reload()
    await expect(bob.getByRole('navigation', { name: 'Chats' })).toBeVisible()
    await expect(bob.locator('#chatInvitations li[data-invitation]')).toHaveCount(0)
  } finally { publisher.close(); await ac.close(); await bc.close() }
})

test('Invite from People opens the private chat and sends the room there, sealed', async ({ browser, baseURL }) => {
  test.setTimeout(180_000)
  const aKey = generateSecretKey(), bKey = generateSecretKey()
  const a = getPublicKey(aKey), b = getPublicKey(bKey)
  const publisher = new NostrRelayPool([TEST_RELAY_WS])
  const ac = await accountDevice(browser, baseURL!, aKey), bc = await accountDevice(browser, baseURL!, bKey)
  try {
    await seed(publisher, baseURL!, { account: aKey, peers: [bKey] }, [b], new Map([[b, 'Bob on Nostr']]))
    const alice = await ac.newPage(); await alice.setViewportSize({ width: 1280, height: 900 })
    await signInAccount(alice, baseURL!)
    await openNewRoomForm(alice)
    await alice.locator('#roomName').fill('Saturday walk')
    await alice.locator('#create').click()
    // A new room's creator still meets the door (stage 6 removes it).
    await expect(alice.locator('#join')).toBeEnabled({ timeout: 30_000 })
    if (await alice.locator('#displayName').isVisible()) await alice.locator('#displayName').fill('Alice')
    await alice.locator('#join').click()
    await expect(alice.locator('#roomArea')).toBeVisible({ timeout: 30_000 })

    await openPeople(alice)
    await alice.locator('#peopleRows').getByRole('button', { name: /^Bob on Nostr/ }).click()
    await alice.locator('#peopleInvite').click()
    await expect(alice.locator('#inviteToRoom')).toBeVisible()
    expect(parseRoomLink(alice.url()).policy?.members).toContain(b)
    await alice.locator('#inviteToRoomList').getByRole('button', { name: 'Saturday walk' }).click()
    await expect(alice.locator('#inviteToRoom')).toBeHidden()
    await expect(alice.locator('#chatLog')).toContainText('You invited Bob on Nostr to Saturday walk.')

    // Bob's page in People says what became of it, worked out on Alice's
    // device: sent and not joined yet, and no room shared so far.
    await openPeople(alice)
    await alice.locator('#peopleRows').getByRole('button', { name: /^Bob on Nostr/ }).click()
    const sent = alice.locator('#peopleSentInvitations')
    await expect(sent.getByRole('button', { name: 'Saturday walk, You invited Bob on Nostr · Sent, not joined yet, Today' })).toBeVisible()
    await expect(alice.locator('#peopleSharedRooms')).toHaveCount(0)
    // The row opens the room, where Alice waits for Bob: the page is then
    // worked out from the room's own session rather than the list's watch.
    await sent.getByRole('button', { name: /^Saturday walk/ }).click()
    await expect(alice.locator('#roomTitle')).toHaveText('Saturday walk')
    await expect(alice.locator('#roomArea')).toBeVisible({ timeout: 30_000 })

    // Bob accepts the private chat, which puts the room in his list, and joins it.
    const bob = await bc.newPage(); await bob.setViewportSize({ width: 1280, height: 900 }); await signInAccount(bob, baseURL!)
    await bob.locator('#chatInvitations li[data-invitation]').getByRole('button', { name: `Accept private chat with ${shortNpub(a)}` }).click()
    await expect(bob.locator('#chatLog')).toContainText('invited you to Saturday walk. It is in your rooms.', { timeout: 30_000 })
    await bob.locator('#roomList').getByRole('button', { name: 'Open Saturday walk', exact: true }).click()
    // A room already in the list opens straight in, with no door.
    await expect(bob.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    await bob.locator('#chatInput').fill('Here for the walk')
    await bob.locator('#chatInput').press('Enter')
    await expect(bob.locator('#chatLog')).toContainText('Here for the walk')

    await expect(alice.locator('#chatLog')).toContainText('Here for the walk', { timeout: 30_000 })

    // Bob's page now says he came, and lists the room the two of them share.
    await openPeople(alice)
    await alice.locator('#peopleRows').getByRole('button', { name: /^Bob on Nostr/ }).click()
    await expect(sent.getByRole('button', { name: 'Saturday walk, You invited Bob on Nostr · Joined, Today' })).toBeVisible({ timeout: 30_000 })
    await expect(alice.locator('#peopleSharedRooms').getByRole('button', { name: 'Saturday walk' })).toBeVisible()
    await alice.screenshot({ path: test.info().outputPath('contact-rooms.png') })

    // From the private chat, Saturday walk is a room the list watches, and
    // its history holds Bob's message, so the page says the same.
    await alice.locator('#peoplePane').getByRole('button', { name: 'Bob on Nostr', exact: true }).click()
    await expect(alice.locator('#roomWho')).toHaveText('Private chat')
    // Opened, not still opening: a room asked for mid-switch is not switched to.
    await expect(alice.locator('#roomArea')).toHaveJSProperty('inert', false, { timeout: 30_000 })
    await openPeople(alice)
    await alice.locator('#peopleRows').getByRole('button', { name: /^Bob on Nostr/ }).click()
    await expect(sent.getByRole('button', { name: 'Saturday walk, You invited Bob on Nostr · Joined, Today' })).toBeVisible({ timeout: 30_000 })
    await expect(alice.locator('#peopleSharedRooms').getByRole('button', { name: 'Saturday walk' })).toBeVisible()
    await alice.locator('#peopleSharedRooms').getByRole('button', { name: 'Saturday walk' }).click()
    await expect(alice.locator('#roomTitle')).toHaveText('Saturday walk')
  } finally { publisher.close(); await ac.close(); await bc.close() }
})

test('Check words together from People compares words in the private chat and marks the person checked', async ({ browser, baseURL }) => {
  test.setTimeout(180_000)
  const aKey = generateSecretKey(), bKey = generateSecretKey()
  const a = getPublicKey(aKey), b = getPublicKey(bKey)
  const publisher = new NostrRelayPool([TEST_RELAY_WS])
  const ac = await accountDevice(browser, baseURL!, aKey), bc = await accountDevice(browser, baseURL!, bKey)
  try {
    await seed(publisher, baseURL!, { account: aKey, peers: [bKey] }, [b], new Map([[b, 'Bob on Nostr']]))
    const alice = await ac.newPage(); await alice.setViewportSize({ width: 1280, height: 900 })
    await signInAccount(alice, baseURL!)
    await openPeople(alice)
    await alice.locator('#peopleRows').getByRole('button', { name: /^Bob on Nostr/ }).click()
    const check = alice.locator('#peopleCheckWords')
    await expect(check).toHaveAccessibleName('Check words together, Not checked yet')

    // The words come from the private chat, so the check opens there.
    await check.click()
    await expect(alice.locator('#roomWho')).toHaveText('Private chat')
    await expect(alice.locator('#verifyDialog')).toBeVisible({ timeout: 30_000 })
    await expect(alice.locator('#verifyTitle')).toHaveText('Is this really Bob on Nostr?')
    await alice.locator('#verifyStart').click()

    // Bob accepts the private chat, then the check from Alice's row in it.
    const bob = await bc.newPage(); await bob.setViewportSize({ width: 1280, height: 900 }); await signInAccount(bob, baseURL!)
    await bob.locator('#chatInvitations li[data-invitation]').getByRole('button', { name: `Accept private chat with ${shortNpub(a)}` }).click()
    await expect(bob.locator('#roomWho')).toHaveText('Private chat', { timeout: 30_000 })
    await openRoomDetails(bob)
    // Only somebody else's row has a check button.
    const aliceRow = bob.locator('#sheetRoster .rosterRow', { has: bob.locator('.verifyChip') })
    await expect(aliceRow).toHaveCount(1, { timeout: 30_000 })
    if (!(await aliceRow.evaluate(el => (el as HTMLDetailsElement).open))) await aliceRow.locator('summary').click()
    await expect(aliceRow.locator('.verifyChip')).toHaveText('check requested', { timeout: 30_000 })
    await aliceRow.locator('.verifyChip').click()
    await bob.locator('#verifyAccept').click()

    await expect(alice.locator('#verifyConfirm')).toBeEnabled({ timeout: 30_000 })
    await expect(bob.locator('#verifyConfirm')).toBeEnabled({ timeout: 30_000 })
    expect((await alice.locator('#verifyMine').textContent())!.trim()).toBe((await bob.locator('#verifyTheirs').textContent())!.trim())
    await alice.locator('#verifyConfirm').click()
    await expect(alice.locator('#verifyDialog')).toBeHidden()

    // People says so: the date on his page, and the mark beside his name.
    await openPeople(alice)
    await alice.locator('#peopleRows').getByRole('button', { name: /^Bob on Nostr/ }).click()
    await expect(check).toHaveAccessibleName(/^Check words together, Checked on /)
    await expect(alice.locator(`#peopleRows li[data-person="${b}"] .checkedMark`)).toBeVisible()
    await alice.screenshot({ path: test.info().outputPath('contact-checked.png') })
  } finally { publisher.close(); await ac.close(); await bc.close() }
})

test('Voice from People opens the private chat and starts a call in it', async ({ browser, baseURL }) => {
  const aKey = generateSecretKey(), bKey = generateSecretKey()
  const b = getPublicKey(bKey)
  const publisher = new NostrRelayPool([TEST_RELAY_WS])
  const ac = await accountDevice(browser, baseURL!, aKey)
  try {
    await ac.grantPermissions(['camera', 'microphone'], { origin: new URL(baseURL!).origin })
    await seed(publisher, baseURL!, { account: aKey, peers: [bKey] }, [b], new Map([[b, 'Bob on Nostr']]))
    const alice = await ac.newPage(); await alice.setViewportSize({ width: 1280, height: 900 })
    await signInAccount(alice, baseURL!)
    await openPeople(alice)
    await alice.locator('#peopleRows').getByRole('button', { name: /^Bob on Nostr/ }).click()
    await alice.locator('#peopleVoice').click()
    await expect(alice.locator('#roomArea')).toBeVisible()
    await expect(alice.locator('#leaveCall')).toBeVisible({ timeout: 30_000 })
  } finally { publisher.close(); await ac.close() }
})

test('with public profiles off, Following says how to see it and asks no relay', async ({ browser, baseURL }) => {
  const aKey = generateSecretKey()
  const ac = await accountDevice(browser, baseURL!, aKey)
  try {
    await ac.addInitScript(() => localStorage.setItem('kithmoot.profiles.enabled', 'false'))
    const alice = await ac.newPage(); await alice.setViewportSize({ width: 1280, height: 900 })
    await signInAccount(alice, baseURL!)
    await openPeople(alice)
    await expect(alice.locator('#peopleRows li[data-section="Following"] .note')).toHaveText('Turn on public profiles in Settings to see the people you follow.')
    await expect(alice.locator('#peopleEmpty')).toBeVisible()
  } finally { await ac.close() }
})
