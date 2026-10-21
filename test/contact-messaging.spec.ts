import { test, expect } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { NostrRelayPool } from '../src/relay-pool.js'
import { parseRoomLink } from '../src/link.js'
import { accountDevice, signInAccount } from './nostr-account.js'
import { TEST_RELAY_WS } from './browser.js'
import { shareContacts } from './contacts-grant.js'


test('Signet contacts start a private conversation without a shared room, deliver offline and reopen the same chat', async ({ browser, baseURL }) => {
  const aKey = generateSecretKey(), bKey = generateSecretKey(), a = getPublicKey(aKey), b = getPublicKey(bKey)
  const ac = await accountDevice(browser, baseURL!, aKey), bc = await accountDevice(browser, baseURL!, bKey)
  const publisher = new NostrRelayPool([TEST_RELAY_WS])
  try {
    const relay = new URL('/__test-relay', baseURL!); relay.protocol = 'wss:'
    for (const key of [aKey, bKey]) await publisher.publish(finalizeEvent({ kind: 10050, created_at: Math.floor(Date.now() / 1000), tags: [['relay', relay.href]], content: '' }, key))
    let alice = await ac.newPage(); await alice.setViewportSize({ width: 1280, height: 900 }); await signInAccount(alice, baseURL!)
    await shareContacts(alice, a, [{ pubkey: b, name: 'Bob from Signet' }], publisher)
    await alice.locator('#signetContactsSearch').fill('unmatched person')
    await expect(alice.locator('#signetGrantedContacts li')).toHaveCount(0)
    await alice.locator('#signetContactsSearch').fill('Bob')
    await expect(alice.getByRole('button', { name: 'Message Bob from Signet', exact: true })).toBeVisible()
    await expect(alice.locator('#contactInboxStatus')).not.toContainText('Opening')
    await alice.screenshot({ path: test.info().outputPath('contacts-wide.png') })
    await alice.getByRole('button', { name: 'Message Bob from Signet', exact: true }).click()
    await expect(alice.locator('#roomArea')).toBeVisible()
    const invitation = new URL(alice.url()).hash
    expect(parseRoomLink(alice.url()).policy?.members?.sort()).toEqual([a, b].sort())
    await alice.locator('#chatInput').fill('Hello Bob, sent before you opened KithMoot')
    await alice.locator('#chatInput').press('Enter')
    await expect(alice.locator('#chatLog')).toContainText('Hello Bob, sent before you opened KithMoot')
    await alice.locator('#roomContacts').evaluate(button => (button as HTMLButtonElement).click())
    await expect(alice.locator('#contactInboxStatus')).toHaveText('')
    await alice.close()
    // Alice is offline too. Bob has never loaded this app or joined a room.
    const bob = await bc.newPage(); await signInAccount(bob, baseURL!)
    const invitations = bob.getByRole('navigation', { name: 'Chats' }).locator('li[data-invitation]')
    await expect(invitations).toHaveCount(1)
    await bob.screenshot({ path: test.info().outputPath('contacts-phone.png') })
    await invitations.locator('button[data-action="accept"]').click()
    await expect(bob.locator('#roomArea')).toBeVisible()
    expect(new URL(bob.url()).hash).toBe(invitation)
    await expect(bob.locator('#chatLog')).toContainText('Hello Bob, sent before you opened KithMoot')
    await bob.locator('#chatInput').fill('Hello Alice, this is my private reply')
    await bob.locator('#chatInput').press('Enter')
    alice = await ac.newPage(); await alice.setViewportSize({ width: 1280, height: 900 })
    await alice.goto(baseURL! + invitation)
    // Alice started this chat, so its link opens it.
    await expect(alice.locator('#chatLog')).toContainText('Hello Alice, this is my private reply')
    await alice.locator('#roomContacts').evaluate(button => (button as HTMLButtonElement).click())
    await alice.getByRole('button', { name: 'Message Bob from Signet', exact: true }).click()
    expect(new URL(alice.url()).hash).toBe(invitation)
    await alice.reload()
    await expect(alice.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
    await alice.locator('#roomContacts').evaluate(button => (button as HTMLButtonElement).click())
    await expect(alice.getByRole('button', { name: 'Message Bob from Signet', exact: true })).toBeVisible()
    await alice.getByRole('button', { name: 'Message Bob from Signet', exact: true }).click()
    expect(new URL(alice.url()).hash).toBe(invitation)
    await expect(alice.locator('#chatLog')).toContainText('Hello Alice, this is my private reply')
    // Preserve source room ownership and the collaboration controls.
    await expect(alice.locator('#newMenuButton:visible')).toBeVisible()
    await expect(alice.locator('#railBoards:visible')).toContainText('Boards')
  } finally { publisher.close(); await ac.close(); await bc.close() }
})

test('blocking a Signet contact while its signer is encrypting prevents invitation delivery', async ({ browser, baseURL }) => {
  const key = generateSecretKey(), account = getPublicKey(key), peer = getPublicKey(generateSecretKey())
  const context = await accountDevice(browser, baseURL!, key), publisher = new NostrRelayPool([TEST_RELAY_WS])
  let release = () => {}, reached = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const received: string[] = []
  const off = publisher.subscribe([{ kinds: [1059], '#p': [peer] }], event => received.push(event.id))
  try {
    const page = await context.newPage(); await signInAccount(page, baseURL!)
    const grant = await shareContacts(page, account, [{ pubkey: peer, name: 'Blocked during send' }], publisher)
    await expect(page.locator('#contactInboxStatus')).toHaveText('')
    await page.exposeFunction('pauseContactInvitation', async () => { reached = true; await gate })
    await page.evaluate(peer => {
      const provider = (window as unknown as { nostr: { nip44: { encrypt(peer: string, text: string): Promise<string> } }; pauseContactInvitation(): Promise<void> })
      const encrypt = provider.nostr.nip44.encrypt
      provider.nostr.nip44.encrypt = async (recipient, text) => {
        if (recipient === peer && text.includes('kithmoot-invitation')) await provider.pauseContactInvitation()
        return encrypt(recipient, text)
      }
    }, peer)
    await page.getByRole('button', { name: 'Message Blocked during send', exact: true }).click()
    await expect.poll(() => reached).toBe(true)
    await page.locator('#signetContactsAccess').evaluate(el => { (el as HTMLDetailsElement).open = true })
    await grant.publish({ ...grant.projection, frontier: { ...grant.projection.frontier, maxClock: 2 },
      contacts: grant.projection.contacts.map(contact => ({ ...contact, blocked: true })) })
    await page.locator('#signetContactsRefresh').click()
    await expect(page.locator('#signetGrantedContacts li')).toHaveCount(0)
    release()
    await expect(page.locator('#contactInboxStatus')).toContainText(/permission changed|no longer authorised/)
    expect(received).toEqual([])
    await expect(page.locator('#contactsDialog')).toBeVisible()
    await expect(page.locator('#roomArea')).toBeHidden()
  } finally { release(); off(); publisher.close(); await context.close() }
})
