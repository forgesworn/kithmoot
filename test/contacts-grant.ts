import { expect, type Page } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { encrypt, getConversationKey } from 'nostr-tools/nip44'
import { parsePairingRequestV2, buildPairingAckV2, ackEventTemplate, projectionTag, proposalTag,
  projectionEventTemplate, sealVaultPayload, type ContactProjectionV2 } from '@forgesworn/signet-contacts'
import type { NostrRelayPool } from '../src/relay-pool.js'

/** Actual grant handshake and encrypted projection through the fixture relay.
 * No app-side hook grants contacts or skips the Signet confirmation step. */
export async function shareContacts(page: Page, account: string, contacts: { pubkey: string; name: string }[], publisher: NostrRelayPool) {
  // The Contacts button left the start page and the sidebar with the shell
  // (People takes its place in stage 6); the sheet is still the same one, so
  // it is opened through the control that remains, in a room's details.
  await page.locator('#roomContacts').evaluate(button => (button as HTMLButtonElement).click())
  await page.locator('#signetContactsAccess').evaluate(el => { (el as HTMLDetailsElement).open = true })
  await expect(page.locator('#signetContactsConnect')).toBeEnabled()
  await page.locator('#signetContactsConnect').click()
  await expect(page.locator('#signetContactsUri')).not.toHaveValue('')
  const request = parsePairingRequestV2(await page.locator('#signetContactsUri').inputValue()).request!
  const railKey = generateSecretKey(), rail = getPublicKey(railKey), ephemeral = generateSecretKey(), grantId = getPublicKey(generateSecretKey()).slice(0, 32)
  const now = Math.floor(Date.now() / 1000)
  const ack = buildPairingAckV2({ v: 2, grantId, railPubkey: rail, projectionTag: projectionTag(grantId), proposalTag: proposalTag(grantId, account),
    relay: request.rendezvousRelay, grantedCapabilities: request.capabilities, maxStalenessSeconds: 21600, challenge: request.challenge })
  await publisher.publish(finalizeEvent(ackEventTemplate(getPublicKey(ephemeral), account, now, encrypt(ack, getConversationKey(ephemeral, account))), ephemeral))
  const projection: ContactProjectionV2 = { v: 2, grantId, scopes: request.capabilities, issuedAt: now, expiresAt: now + 600,
    frontier: { maxClock: 1, opCount: 0, publishedAt: now, deviceId: 'b'.repeat(32) },
    contacts: contacts.map(contact => ({ contactId: getPublicKey(generateSecretKey()).slice(0, 32), displayName: contact.name, identities: [{ pubkey: contact.pubkey }] })) }
  let lastPublished = now - 1
  async function publish(value: ContactProjectionV2) {
    await expect.poll(() => Math.floor(Date.now() / 1000)).toBeGreaterThan(lastPublished)
    const at = Math.floor(Date.now() / 1000)
    const content = await sealVaultPayload(JSON.stringify(value), { nip44Encrypt: async (to, text) => encrypt(text, getConversationKey(railKey, to)) }, account)
    await publisher.publish(finalizeEvent(projectionEventTemplate(rail, grantId, at, content!), railKey))
    lastPublished = at
  }
  await publish(projection)
  await expect(page.locator('#signetContactsConfirm')).toBeVisible()
  await page.locator('#signetContactsMatched').click()
  await expect(page.locator('#signetContactsConfirm')).toBeHidden()
  await page.locator('#signetContactsRefresh').click()
  await expect(page.locator('#signetGrantedContacts li')).toHaveCount(contacts.length)
  await page.locator('#signetContactsAccess').evaluate(el => { (el as HTMLDetailsElement).open = false })
  return { projection, publish }
}
