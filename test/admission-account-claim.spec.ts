import { test, expect } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { writeFileSync } from 'node:fs'
import { localIdentity } from '../src/identity.js'
import { newDeviceContext, openNewRoomForm, requestAdmission } from './browser.js'
import { testRelaysFor, TEST_RELAY_WS } from './relays.js'
import { NostrRelayPool } from '../src/relay-pool.js'
import { encodeRoomLink, parseRoomLink } from '../src/link.js'
import { createRoomInvitation, encodeInvitationAccountProof, encodeInvitationRequest, decodeRoomAdmissionGrant, deriveInvitationId } from '../src/invitation.js'

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

for (const cancellation of ['sign out', 'stop opening', 'cancel request', 'deadline'] as const) test(`a late account signature cannot publish an admission request after ${cancellation}`, async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' })
  const secret = generateSecretKey()
  const relays = testRelaysFor(baseURL!)!
  const { invitation } = createRoomInvitation()
  const pool = new NostrRelayPool([TEST_RELAY_WS])
  let proofStarted = false
  let proofCompleted = false
  let releaseProof = () => {}
  const heldProof = new Promise<void>(resolve => { releaseProof = resolve })
  const requests: string[] = []
  const signatures: { kind: number; domain?: string }[] = []
  const stop = pool.subscribe([{ kinds: [20466], '#d': [deriveInvitationId(invitation)] }], event => { requests.push(event.id) })
  await context.exposeFunction('testPublicKey', () => getPublicKey(secret))
  await context.exposeFunction('testSign', async (template: Parameters<typeof finalizeEvent>[0]) => {
    signatures.push({ kind: template.kind, domain: template.tags.find(tag => tag[0] === 't')?.[1] })
    if (template.tags.some(tag => tag[0] === 't' && tag[1] === 'kithmoot/v2/invitation-account-proof')) {
      proofStarted = true
      await heldProof
      proofCompleted = true
    }
    return finalizeEvent(template, secret)
  })
  await context.addInitScript(urls => {
    localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: urls.map(url => ({ url, read: true, write: true })) }))
    const win = window as typeof window & { testPublicKey(): Promise<string>; testSign(template: unknown): Promise<unknown> }
    Object.defineProperty(window, 'nostr', { configurable: true, value: {
      getPublicKey: () => win.testPublicKey(), signEvent: (event: unknown) => win.testSign(event),
    } })
    const NativeWebSocket = window.WebSocket
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        const defaults = ['wss://nostr.mom', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es', 'wss://relay.damus.io']
        const target = defaults.includes(String(url).replace(/\/$/, '')) ? urls[0]! : String(url)
        if (!urls.includes(target)) throw new Error('External relay blocked by acceptance test')
        super(target, protocols)
      }
    }
  }, relays)
  try {
    const page = await context.newPage()
    await page.goto(baseURL! + '?signin=nostr')
    await page.getByRole('button', { name: /Browser extension/ }).click()
    await page.locator('#openAppSettings').click()
    await expect(page.locator('#signOut')).toBeVisible()
    await page.locator('#appSettingsClose').click()
    if (cancellation === 'deadline') await page.clock.install()
    await page.goto(encodeRoomLink(baseURL!, { invitation, relays, iceUrls: [] }))
    // A fragment-only navigation does not reload the application module.
    // Reproduce opening an invitation in a fresh document after sign-in.
    await page.reload()
    await requestAdmission(page)
    try { await expect.poll(() => proofStarted, { timeout: 6_000 }).toBe(true) }
    catch {
      const state = await page.evaluate(() => ({
        method: localStorage.getItem('signet:login.method'),
        accountStored: !!localStorage.getItem('signet:login.pubkey'),
        arrival: document.getElementById('arrivalTitle')?.textContent,
        lead: document.getElementById('arrivalLead')?.textContent,
        status: document.getElementById('status')?.textContent,
      }))
      throw new Error('The synthetic account signer was not asked for proof: ' + JSON.stringify({ state, signatures, requestCount: requests.length }))
    }
    expect(requests).toEqual([])
    if (cancellation === 'sign out') {
      // The invitation door hides the home Settings button. Invoke its
      // existing handler to exercise account replacement during signing;
      // the sign-out action itself still runs through the visible dialog.
      await page.locator('#openAppSettings').evaluate(button => (button as HTMLButtonElement).click())
      await page.locator('#signOut').click()
      await expect(page.locator('#signIn')).toBeVisible()
    } else if (cancellation === 'cancel request') {
      await page.locator('#cancelAdmission').click()
      await expect(page.locator('#arrivalTitle')).toHaveText('Your request was cancelled')
    } else if (cancellation === 'stop opening') {
      await page.locator('#stopOpening').click({ timeout: 15_000 })
      await expect(page).toHaveURL(baseURL!)
    } else {
      await page.clock.fastForward(90_001)
      await expect(page.locator('#arrivalTitle')).toContainText('The room has not answered')
    }
    releaseProof()
    await expect.poll(() => proofCompleted).toBe(true)
    // Let the completed signer promise and any attempted relay publication drain.
    await page.waitForTimeout(750)
    expect(requests, 'A cancelled signer continuation published a new admission request').toEqual([])
    await expect(page.locator('#roomArea')).toBeHidden()
  } finally { releaseProof(); stop(); pool.close(); await context.close() }
})
