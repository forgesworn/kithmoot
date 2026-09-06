import { test, expect } from '@playwright/test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { RoomAgent } from '../src/agent.js'
import { localIdentity } from '../src/identity.js'
import { issueAgentOwnership } from '../src/ownership.js'
import { AgentAssignmentWork } from '../src/node/assignment-work.js'
import { encodeRoomLink, parseRoomLink } from '../src/link.js'
import { open } from './browser.js'

// Build apps/den from the companion Vitark checkout and serve build/web on a
// loopback origin. No production service, personal profile or physical device.
test('compiled Den shares, receives an agent artifact, and accepts the exact result', async ({ browser, baseURL }, testInfo) => {
  test.skip(!process.env.DEN_BASE_URL, 'DEN_BASE_URL must point to the compiled Den web client')
  test.setTimeout(90_000)
  const directory = await mkdtemp(join(tmpdir(), 'den-real-journey-'))
  const room = await RoomAgent.create({ base: baseURL!, name: 'Workshop owner', agent: false, relays: ['ws://127.0.0.1:7777'] })
  const secret = generateSecretKey()
  const principalKey = hkdf(sha256, secret, new TextEncoder().encode(room.roomId), 'den/kithmoot/v1/participant', 32)
  const identity = localIdentity(generateSecretKey())
  const worker = await RoomAgent.join({ link: room.url, name: 'Tally', identity, owner: issueAgentOwnership({ principalSk: principalKey, agent: identity.pubkey, issuedAt: Math.floor(Date.now() / 1000) }) })
  const work = await AgentAssignmentWork.open(worker, join(directory, 'worker'))
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1280, height: 900 } })
  await context.addInitScript(seed => {
    if (!location.protocol.startsWith('http')) return
    if (!localStorage.getItem('flutter.sync_secret')) localStorage.setItem('flutter.sync_secret', JSON.stringify(seed))
  }, bytesToHex(secret))
  try {
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    const capture = async (name: string) => {
      // The Flutter route's canvas animation is not a DOM animation that
      // Playwright screenshots can finish. Capture the settled route.
      await page.waitForTimeout(400)
      await page.screenshot({ path: testInfo.outputPath(name) })
    }
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(process.env.DEN_BASE_URL!)
    await page.locator('flt-semantics-placeholder').dispatchEvent('click')
    await page.getByRole('button', { name: 'Add something', exact: true }).click()
    await page.getByRole('textbox').fill('Prepare release evidence')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByRole('button', { name: 'The list', exact: true }).first().click()
    await page.getByRole('button', { name: 'More for this one', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Share with a room', exact: true }).click()
    await page.getByRole('button', { name: 'Connect a room', exact: true }).click()
    const editField = async (name: RegExp, value: string) => {
      const field = page.getByRole('textbox', { name })
      await expect(async () => {
        await field.click(); await expect(field).toBeFocused({ timeout: 500 })
        // Flutter installs its editing state after DOM focus. A closing menu
        // can steal that focus; re-enter only if the visible value was lost.
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        await field.fill(value)
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        await expect(field).toHaveValue(value, { timeout: 500 })
      }).toPass({ timeout: 5000 })
    }
    await editField(/Room name in Den/, 'Workshop')
    await editField(/Room invitation/, room.url)
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    const choose = async (label: string, option: string) => {
      // A closing Flutter route can still intercept a canvas pointer after its
      // semantics disappear. Retry opening until the menu is actually visible.
      await expect(async () => {
        await page.getByRole('button', { name: label, exact: true }).click()
        await expect(page.getByRole('menuitem', { name: option, exact: true })).toBeVisible({ timeout: 1000 })
      }).toPass({ timeout: 5000 })
      await page.getByRole('menuitem', { name: option, exact: true }).click()
    }
    await choose('Room', 'Workshop')
    await choose('Who will do it', 'Tally · agent')
    await editField(/What would a good result look like/, 'A saved artifact with its SHA-256 digest')
    await page.getByRole('button', { name: 'Preview sharing', exact: true }).click()
    await expect(page.getByText('Preview what the room will see', { exact: true })).toBeVisible()
    expect(work.log.snapshot().assignments).toHaveLength(0)
    await capture('den-sharing-preview.png')
    await page.getByRole('button', { name: 'Share this assignment', exact: true }).click()
    await expect.poll(() => work.log.snapshot().assignments.length).toBe(1)
    const assignment = work.log.snapshot().assignments[0]!
    expect(assignment.creator).toBe(localIdentity(principalKey).pubkey)
    expect(assignment.ownerDevice).toBe(worker.device)
    const claim = await work.claim(assignment.id, 'Write the evidence artifact')
    expect(claim.start).toBe(true)
    const artifact = join(directory, 'release-evidence.txt')
    await writeFile(artifact, 'Checked build 54\n')
    const digest = bytesToHex(sha256(await readFile(artifact)))
    const result = await work.report(assignment.id, 'result', { summary: 'Build 54 checked', evidence: `release-evidence.txt sha256:${digest}` }, 'compiled_den_result_01')
    const witness = await context.newPage()
    const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
    const link = encodeRoomLink(baseURL!, { ...parseRoomLink(room.url), relays: [relay.href] })
    await open(witness, link, 'Room reviewer'); await witness.locator('#join').click()
    await witness.locator('#openAssignments').click()
    const sharedCard = witness.locator(`.assignmentCard[data-assignment="${assignment.id}"]`)
    await expect(sharedCard).toContainText(result.result!.id)
    await expect(page.getByText('Build 54 checked', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'The list', exact: true }).first().click()
    await expect(page.getByRole('button', { name: /Review: Prepare release evidence/ })).toBeVisible()
    await page.getByRole('button', { name: /Review: Prepare release evidence/ }).click()
    await expect(page.getByRole('button', { name: 'Accept this result', exact: true })).toBeVisible()
    await capture('den-result-review.png')
    await page.getByRole('button', { name: 'Accept this result', exact: true }).click()
    await expect.poll(() => work.log.snapshot().assignments[0]?.status).toBe('accepted')
    await expect(sharedCard).toContainText('accepted')
    await expect(page.getByRole('group', { name: /Workshop · Accepted/ })).toBeVisible()
    await expect(page.getByRole('group', { name: /Owner: Tally/ })).toBeVisible()
    await page.reload()
    await page.locator('flt-semantics-placeholder').dispatchEvent('click')
    await page.getByRole('button', { name: 'Shared work', exact: true }).first().click()
    await page.getByRole('button', { name: 'Prepare release evidence Accepted', exact: true }).click()
    await expect(page.getByRole('group', { name: /Workshop · Accepted/ })).toBeVisible()
    await expect(page.getByRole('group', { name: /Owner: Tally/ })).toBeVisible()
    await expect(sharedCard).toContainText('accepted')
    expect(work.log.snapshot().assignments).toHaveLength(1)
    await capture('den-accepted-after-reload.png')
    expect(errors).toEqual([])
  } finally { await context.close().catch(() => {}); await work.close(); worker.leave(); room.leave(); await rm(directory, { recursive: true, force: true }) }
})
