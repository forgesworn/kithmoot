import { test, expect } from '@playwright/test'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { writeFileSync } from 'node:fs'
import { localIdentity } from '../src/identity.js'
import { newDeviceContext, openNewRoomForm } from './browser.js'
import { testRelaysFor, TEST_RELAY_WS } from './relays.js'
import { NostrRelayPool } from '../src/relay-pool.js'
import { parseRoomLink } from '../src/link.js'
import { encodeInvitationAccountProof, encodeInvitationRequest, decodeRoomAdmissionGrant, deriveInvitationId } from '../src/invitation.js'

for (const verified of [false, true]) test(verified ? 'a matching signed account proof admits an invited account automatically' : 'an unproved account claim requires the host decision but can be admitted manually', async ({ browser, baseURL }) => {
  const context = await newDeviceContext(browser, baseURL!)
  const pool = new NostrRelayPool([TEST_RELAY_WS])
  let stop = () => {}
  try {
    const host = await context.newPage()
    const relays = testRelaysFor(baseURL!)!
    await host.addInitScript(urls => localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: urls.map(url => ({ url, read: true, write: true })) })), relays)
    await host.goto(baseURL!)
    await openNewRoomForm(host)
    await host.locator('#roomName').fill('Synthetic authority audit')
    await host.locator('#roomAsk').check()
    await host.locator('#create').click()
    await expect.poll(() => host.locator('#shareUrl').inputValue()).not.toBe('')
    const link = await host.locator('#shareUrl').inputValue()
    await host.locator('#displayName').fill('Synthetic host')
    await host.locator('#join').click()
    await expect(host.locator('#roomArea')).toBeVisible()
    const invitedSk = generateSecretKey()
    const invited = getPublicKey(invitedSk)
    await host.evaluate(account => {
      const key = Object.keys(localStorage).find(k => /^kithmoot\.room\.[0-9a-f]{64}$/.test(k))
      if (!key) throw new Error('Synthetic room record missing')
      localStorage.setItem('kithmoot.invited.v1.' + key.slice('kithmoot.room.'.length), JSON.stringify([account]))
    }, invited)
    const invitation = parseRoomLink(link).invitation!
    const requesterSk = generateSecretKey()
    const now = Math.floor(Date.now() / 1000)
    const accountProof = verified ? await encodeInvitationAccountProof({ invitation, device: getPublicKey(requesterSk), identity: localIdentity(invitedSk), now }) : undefined
    const request = encodeInvitationRequest({ invitation, requesterSk, now, name: 'Unproved guest', participant: invited, ...(accountProof ? { accountProof } : {}) })
    let receivedValidGrant = false
    stop = pool.subscribe([{ kinds: [20467], '#d': [deriveInvitationId(invitation)], '#p': [getPublicKey(requesterSk)] }], event => {
      receivedValidGrant ||= decodeRoomAdmissionGrant(event, { invitation, requesterSk, request: request.id, now: Math.floor(Date.now() / 1000) }) !== null
    })
    await pool.publish(request)
    if (verified) {
      await expect.poll(() => receivedValidGrant).toBe(true)
      await expect(host.locator('#approvals .approvalCard.knock')).toHaveCount(0)
      return
    }
    // The expected decision card is absent if the claimed account bypasses it.
    await host.waitForTimeout(1500)
    const decisionShown = await host.locator('#approvals .approvalCard.knock').count() === 1
    writeFileSync('/tmp/kithmoot-admission-account-audit.json', JSON.stringify({ syntheticOnly: true, requestDeviceDiffersFromClaimedAccount: getPublicKey(requesterSk) !== invited, accountProofSupplied: false, hostApprovalClicked: false, decisionShown, receivedValidGrant, authorityAccepted: !receivedValidGrant && decisionShown }, null, 2) + '\n')
    expect(receivedValidGrant, 'Unproved account claim released an authenticated room grant').toBe(false)
    const card = host.locator('#approvals .approvalCard.knock')
    await expect(card).toContainText('Unproved guest')
    await expect(card.locator('.knockEvidence')).toContainText('not verified for this request')
    await card.getByRole('button', { name: 'Let in', exact: true }).click()
    await expect.poll(() => receivedValidGrant).toBe(true)
  } finally { stop(); pool.close(); await context.close() }
})
