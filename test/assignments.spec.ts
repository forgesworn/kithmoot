import { test, expect } from '@playwright/test'
import { RoomAgent } from '../src/agent.js'
import { encodeRoomLink, parseRoomLink } from '../src/link.js'
import { open } from './browser.js'

test('room cards carry a question and exact-result review through reload at phone width', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(60_000)
  const worker = await RoomAgent.create({ base: baseURL!, name: 'Tally', relays: ['ws://127.0.0.1:7777'] })
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const link = encodeRoomLink(baseURL!, { ...parseRoomLink(worker.url), relays: [relay.href] })
  let cache: string | undefined
  const log = await worker.session.assignments({ async load() { return cache }, async save(value) { cache = value } })
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  try {
    const page = await context.newPage()
    await open(page, link, 'Ada'); await page.locator('#join').click()
    await page.locator('#openAssignments').click()
    await page.getByText('New assignment', { exact: true }).click()
    await page.locator('#assignmentOwner').selectOption(worker.participant)
    await page.locator('#assignmentCreate [name=objective]').fill('Check the release evidence')
    await page.locator('#assignmentCreate [name=criteria]').fill('Give the exact build and its test result')
    await page.locator('#assignmentCreate button[type=submit]').click()
    await expect.poll(() => log.snapshot().assignments.length).toBe(1)
    const id = log.snapshot().assignments[0]!.id
    const card = page.locator(`.assignmentCard[data-assignment="${id}"]`)
    await expect(card).toContainText('offered')
    await log.submit(id, { op: 'claim', executor: 'browser_fixture_execution', next: 'Read the build evidence' }, 'browser_claim_0001')
    await log.submit(id, { op: 'block', executor: 'browser_fixture_execution', question: 'Which build should I check?' }, 'browser_block_0001')
    await expect(card).toContainText('Which build should I check?')
    await card.getByLabel('Answer for the owner').fill('Build 54')
    await card.getByRole('button', { name: 'Send answer' }).click()
    await expect.poll(() => log.snapshot().assignments[0]?.answer).toBe('Build 54')
    const result = await log.submit(id, { op: 'result', executor: 'browser_fixture_execution', summary: 'Build 54 checked', evidence: 'artifact:build-54.txt; unit tests passed' }, 'browser_result_001')
    await expect(card).toContainText(result.result!.id)
    await page.screenshot({ path: testInfo.outputPath('assignment-review-phone.png'), fullPage: true })
    await card.getByRole('button', { name: 'Accept this result' }).click()
    await expect.poll(() => log.snapshot().assignments[0]?.status).toBe('accepted')
    await expect(card).toContainText('accepted')
    expect(await page.locator('#assignmentPanel').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await page.reload()
    if (await page.locator('#join').isVisible()) await page.locator('#join').click()
    await page.locator('#openAssignments').click()
    await expect(page.locator('.assignmentCard')).toHaveCount(1)
    await expect(card).toContainText('accepted')
    const local = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('kithmoot.assignments.')).map(([, value]) => value).join(''))
    expect(local).not.toContain('Check the release evidence')
    expect(local).not.toContain(result.result!.id)
  } finally { await context.close(); worker.leave() }
})
