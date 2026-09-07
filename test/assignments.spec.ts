import { test, expect, type Browser, type Page } from '@playwright/test'
import { RoomAgent } from '../src/agent.js'
import { encodeRoomLink, parseRoomLink } from '../src/link.js'
import { open } from './browser.js'
import { deriveRoom, generateRoomSecret } from '../src/room.js'

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


async function workDevice(browser: Browser, base: string) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 740 } })
  const relay = new URL('/__test-relay', base); relay.protocol = 'wss:'
  await context.addInitScript(relay => {
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        const defaults = ['wss://relay.trotters.cc', 'wss://nos.lol', 'wss://relay.primal.net']
        const target = defaults.includes(String(url).replace(/\/$/, '')) ? relay : String(url)
        if (target !== relay) throw new Error('External relay blocked by test')
        super(target, protocols)
      }
    }
  }, relay.href)
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  const page = await context.newPage()
  return { context, page, relay: relay.href }
}

async function owner(page: Page, name: string) {
  const option = page.locator('#assignmentOwner option').filter({ hasText: name })
  await expect(option).toHaveCount(1)
  await page.locator('#assignmentOwner').selectOption((await option.getAttribute('value'))!)
}

async function offer(page: Page, who: string, objective: string) {
  await page.locator('#assignmentCreate [name=objective]').fill(objective)
  await page.locator('#assignmentCreate [name=criteria]').fill('Provide the checked result and evidence')
  await owner(page, who)
  await page.locator('#assignmentCreate button[type=submit]').click()
  await expect(page.locator('#assignmentCreate [name=objective]')).toHaveValue('')
}

test('two people go from creating and sharing a room to an accepted result without losing a working note', async ({ browser, baseURL }, testInfo) => {
  const ada = await workDevice(browser, baseURL!)
  const grace = await workDevice(browser, baseURL!)
  const native: string[] = []
  for (const { page } of [ada, grace]) page.on('dialog', dialog => { native.push(dialog.type()); void dialog.dismiss() })
  try {
    await ada.page.goto(baseURL!)
    await ada.page.locator('#roomName').fill('Release workshop')
    await ada.page.locator('#create').click()
    await ada.page.locator('#displayName').fill('Ada')
    await ada.page.locator('#join').click()
    await ada.page.locator('#invitePeople').click()
    const link = await ada.page.locator('#shareUrl').inputValue()
    await grace.page.goto(link)
    await grace.page.locator('#displayName').fill('Grace')
    await grace.page.locator('#join').click()
    await grace.page.locator('#chatInput').fill('Ready to check the release together.')
    await grace.page.locator('#chatInput').press('Enter')
    await expect(ada.page.locator('#chatLog')).toContainText('Ready to check the release together.')
    await ada.page.keyboard.press('Escape')
    for (const { page } of [ada, grace]) {
      await page.locator('#openAssignments').click()
      await expect(page.locator('#assignmentRetry')).toBeHidden()
    }
    await ada.page.getByText('New assignment', { exact: true }).click()
    await ada.page.locator('#assignmentCreate button[type=submit]').click()
    await expect(ada.page.locator('#assignmentCreate [name=objective]')).toBeFocused()
    await expect(ada.page.locator('#assignmentStatus')).toContainText('highlighted field')
    await offer(ada.page, 'Grace', 'Check the release evidence')
    const id = await ada.page.locator('.assignmentCard').first().getAttribute('data-assignment')
    const a = ada.page.locator(`.assignmentCard[data-assignment="${id}"]`)
    const g = grace.page.locator(`.assignmentCard[data-assignment="${id}"]`)
    await g.getByLabel('Your next action').fill('Read the build evidence')
    await g.getByRole('button', { name: 'Start work', exact: true }).click()
    await expect(a).toContainText('running')
    await g.getByLabel('What do you need?').fill('Which build should I check?')
    await g.getByLabel('What do you need?').evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(6, 11))
    await offer(ada.page, 'Ada', 'Prepare the follow-up checklist')
    await expect(grace.page.locator('.assignmentCard')).toHaveCount(2)
    await expect(g.getByLabel('What do you need?')).toBeFocused()
    await expect.poll(() => g.getByLabel('What do you need?').evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd])).toEqual([6, 11])
    await g.getByRole('button', { name: 'Ask a question', exact: true }).click()
    await a.getByLabel('Answer for the owner').fill('Build 54')
    await a.getByRole('button', { name: 'Send answer', exact: true }).click()
    await expect(g).toContainText('Answer: Build 54')
    await expect(a.getByLabel('Reason for cancellation')).toBeHidden()
    await a.getByText('Manage assignment', { exact: true }).click()
    await a.getByLabel('Reason for cancellation').fill('Keep this unsent note for later')
    await g.getByLabel('Result and evidence').fill('Build 54 passed. Evidence: artifact build-54.txt and the signed test report.')
    await g.getByRole('button', { name: 'Submit for review', exact: true }).click()
    await expect(a).toContainText('build-54.txt')
    for (const colorScheme of ['light', 'dark'] as const) {
      await ada.page.emulateMedia({ colorScheme })
      for (const width of [320, 390, 1440]) {
        await ada.page.setViewportSize({ width, height: 740 })
        expect(await ada.page.locator('#assignmentPanel').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
        await ada.page.screenshot({ path: testInfo.outputPath(`shared-work-${colorScheme}-${width}.png`) })
      }
    }
    await ada.page.setViewportSize({ width: 320, height: 740 })
    await ada.page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    expect(await ada.page.locator('#assignmentPanel').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await a.getByRole('button', { name: 'Accept this result', exact: true }).click()
    await expect(g).toContainText('accepted')
    await expect(a.getByLabel(/unsent note from an earlier step/)).toHaveValue('Keep this unsent note for later')
    await a.getByRole('button', { name: 'Discard unsent note' }).click()
    await ada.page.locator('#actionCancel').click()
    await expect(a.getByLabel(/unsent note from an earlier step/)).toHaveValue('Keep this unsent note for later')
    await a.getByRole('button', { name: 'Discard unsent note' }).click()
    await ada.page.locator('#actionConfirm').click()
    await expect(a.getByRole('button', { name: 'Discard unsent note' })).toHaveCount(0)
    await ada.page.keyboard.press('Escape')
    await expect(ada.page.locator('#openAssignments')).toBeFocused()
    expect(native).toEqual([])
    await ada.page.reload()
    await ada.page.locator('#join').click()
    await ada.page.locator('#openAssignments').click()
    await expect(a).toContainText('accepted')
    await expect(ada.page.locator('.assignmentCard')).toHaveCount(2)
  } finally { await ada.context.close(); await grace.context.close() }
})

test('unfinished assignment forms stay in their room when switching and warn before a reload', async ({ browser, baseURL }) => {
  const { context, page, relay } = await workDevice(browser, baseURL!)
  try {
    const rooms = ['Workshop', 'Planning'].map(name => {
      const secret = generateRoomSecret()
      return { name, roomId: deriveRoom(secret).roomId, link: encodeRoomLink(baseURL!, { secret, name, relays: [relay], iceUrls: [] }), openedAt: 1, readAt: 0 }
    })
    await page.goto(rooms[0].link)
    await page.evaluate(rooms => { for (const room of rooms) localStorage.setItem('kithmoot.room.' + room.roomId, JSON.stringify(room)) }, rooms)
    await page.locator('#displayName').fill('Ada')
    await page.locator('#join').click()
    await page.locator('#openAssignments').click()
    await page.getByText('New assignment', { exact: true }).click()
    await page.locator('#assignmentCreate [name=objective]').fill('An unfinished workshop assignment')
    await page.locator('#assignmentCreate [name=criteria]').fill('Keep its acceptance criteria here')
    await owner(page, 'Ada')
    await page.keyboard.press('Escape')
    await page.locator('#backToRooms').click()
    await page.getByRole('button', { name: 'Switch to Planning', exact: true }).click()
    await page.locator('#openAssignments').click()
    await page.getByText('New assignment', { exact: true }).click()
    await expect(page.locator('#assignmentCreate [name=objective]')).toHaveValue('')
    await expect(page.locator('#assignmentCreate [name=criteria]')).toHaveValue('')
    await page.locator('#assignmentCreate [name=objective]').fill('A separate planning assignment')
    await page.keyboard.press('Escape')
    await page.locator('#backToRooms').click()
    await expect(page.locator('#roomSwitcherHome')).toBeDisabled()
    await page.getByRole('button', { name: 'Switch to Workshop', exact: true }).click()
    await page.locator('#openAssignments').click()
    await expect(page.locator('#assignmentCreate [name=objective]')).toHaveValue('An unfinished workshop assignment')
    await expect(page.locator('#assignmentCreate [name=criteria]')).toHaveValue('Keep its acceptance criteria here')
    const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))
    expect(stored).not.toContain('An unfinished workshop assignment')
    expect(stored).not.toContain('A separate planning assignment')
    const warning = page.waitForEvent('dialog')
    await page.evaluate(() => { setTimeout(() => location.reload(), 0) })
    const dialog = await warning
    expect(dialog.type()).toBe('beforeunload')
    await dialog.dismiss()
    await expect(page.locator('#assignmentCreate [name=objective]')).toHaveValue('An unfinished workshop assignment')
    await page.locator('#assignmentDiscard').click()
    await page.locator('#actionConfirm').click()
    await expect(page.locator('#assignmentCreate [name=objective]')).toHaveValue('')
    await page.keyboard.press('Escape')
    await page.locator('#backToRooms').click()
    await page.getByRole('button', { name: 'Switch to Planning', exact: true }).click()
    await page.locator('#openAssignments').click()
    await expect(page.locator('#assignmentCreate [name=objective]')).toHaveValue('A separate planning assignment')
  } finally { await context.close() }
})


test('assignment retries clear only the submitted form and keep a newer draft', async ({ browser, baseURL }) => {
  const { context, page, relay } = await workDevice(browser, baseURL!)
  const secret = generateRoomSecret()
  const room = { name: 'Delivery checks', roomId: deriveRoom(secret).roomId, link: encodeRoomLink(baseURL!, { secret, name: 'Delivery checks', relays: [relay], iceUrls: [] }), openedAt: 1, readAt: 0 }
  let reject = false
  const sent = new Set<string>()
  await context.routeWebSocket(relay, ws => {
    const upstream = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && frame[1].kind === 1460 && reject) sent.add(frame[1].id)
      upstream.send(raw)
    })
    upstream.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (reject && frame[0] === 'OK' && sent.has(frame[1])) ws.send(JSON.stringify(['OK', frame[1], false, 'Simulated missing acknowledgement']))
      else ws.send(raw)
    })
  })
  try {
    await page.goto(room.link)
    await page.locator('#displayName').fill('Ada')
    await page.locator('#join').click()
    await page.locator('#openAssignments').click()
    await page.getByText('New assignment', { exact: true }).click()
    for (const [index, changeDraft] of [false, true].entries()) {
      reject = true
      await page.locator('#assignmentCreate [name=objective]').fill(`Submitted assignment ${index}`)
      await page.locator('#assignmentCreate [name=criteria]').fill('Check the saved result')
      await owner(page, 'Ada')
      await page.locator('#assignmentCreate button[type=submit]').click()
      await expect(page.locator('#assignmentStatus')).toContainText('every relay rejected')
      await expect(page.locator('#assignmentRetry')).toBeVisible()
      await expect(page.locator('#assignmentCreate button[type=submit]')).toBeDisabled()
      await expect(page.locator('#assignmentCreate [name=objective]')).toBeEditable()
      if (changeDraft) await page.locator('#assignmentCreate [name=objective]').fill('A newer unsent assignment')
      reject = false
      await page.locator('#assignmentRetry').click()
      await expect(page.locator('#assignmentRetry')).toBeHidden()
      await expect(page.locator('.assignmentCard')).toHaveCount(index + 1)
      await expect(page.locator('#assignmentCreate [name=objective]')).toHaveValue(changeDraft ? 'A newer unsent assignment' : '')
    }
  } finally { await context.close() }
})

test('an advertised agent can be invited and assigned work without replacing an unfinished draft', async ({ browser, baseURL }, testInfo) => {
  const { context, page, relay } = await workDevice(browser, baseURL!)
  const host = await RoomAgent.create({ base: baseURL!, name: 'Workshop host', roomName: 'Agent workshop', agent: false, relays: ['ws://127.0.0.1:7777'] })
  let worker: RoomAgent | undefined
  let actions = [{ id: 'check-release', label: 'Check release evidence', description: 'Check a named build and return its evidence for review.', inputs: [{ id: 'build', label: 'Build identifier', required: true }] }]
  const requests: string[] = []
  const announce = () => host.sendControl({ op: 'catalogue', host: host.participant, name: 'Workshop host',
    agents: [{ id: 'checker', name: 'Build checker', description: 'Reviews build evidence.', actions }],
    running: worker ? [{ id: 'checker', name: 'Build checker', participant: worker.participant, since: 1 }] : [],
  })
  const off = host.onPresenceRequest(request => {
    if (request.op === 'catalogue?') void announce()
    else if (request.op === 'invite' && request.agent) requests.push(request.agent)
  })
  try {
    await page.goto(encodeRoomLink(baseURL!, { ...parseRoomLink(host.url), relays: [relay] }))
    await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()
    await announce()
    await page.locator('#conversationNav [data-channel=agents]').click()
    await page.locator('#manageAgents').click()
    await page.getByRole('button', { name: 'Invite Build checker', exact: true }).click()
    await expect.poll(() => requests).toContain('checker')
    // A real peer joins when the fixture host receives the invitation. Its
    // work results below exercise the shared state machine, not an external job.
    worker = await RoomAgent.join({ link: host.url, name: 'Build checker', agent: true, relays: ['ws://127.0.0.1:7777'] })
    let journal: string | undefined
    const log = await worker.session.assignments({ async load() { return journal }, async save(value) { journal = value } })
    await announce()
    const choose = page.getByRole('button', { name: 'Assign work: Check release evidence', exact: true })
    await expect(choose).toBeVisible()
    await choose.focus()
    await announce()
    await expect(choose).toBeFocused()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.setViewportSize({ width: 320, height: 740 })
      expect(await page.locator('#roomSheet').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      // Presence updates can replace the catalogue row during scrolling.
      await expect(async () => { await choose.scrollIntoViewIfNeeded() }).toPass()
      await page.screenshot({ path: testInfo.outputPath(`agent-actions-${colorScheme}.png`) })
    }
    await choose.click()
    await expect(page.locator('#roomSheet')).not.toBeVisible()
    await expect(page.locator('#assignmentPanel')).toBeVisible()
    await expect(page.locator('#assignmentOwner')).toHaveValue(worker.participant)
    await expect(page.locator('#assignmentAction')).toHaveValue('check-release')
    expect(log.snapshot().assignments).toHaveLength(0)
    const objective = page.locator('#assignmentCreate [name=objective]')
    await objective.fill('Review build 234')
    await page.locator('#assignmentCreate [name=criteria]').fill('Return the build identifier and evidence')
    await page.getByLabel('Build identifier', { exact: true }).fill('234')
    await page.keyboard.press('Escape')
    await page.locator('#manageAgents').click()
    await choose.click()
    await expect(page.locator('#assignmentStatus')).toContainText('unfinished assignment')
    await expect(objective).toHaveValue('Review build 234')
    await expect(page.getByLabel('Build identifier', { exact: true })).toHaveValue('234')
    expect(log.snapshot().assignments).toHaveLength(0)
    await page.locator('#assignmentCreate button[type=submit]').click()
    await expect.poll(() => log.snapshot().assignments.length).toBe(1)
    const assignment = log.snapshot().assignments[0]!
    expect(assignment.action).toBe('check-release')
    expect(assignment.inputs).toEqual({ build: '234' })
    await log.submit(assignment.id, { op: 'claim', executor: 'advertised_action_executor', next: 'Read build 234 evidence' }, 'advertised_action_claim')
    await log.submit(assignment.id, { op: 'result', executor: 'advertised_action_executor', summary: 'Build 234 reviewed', evidence: 'artifact:build-234.txt' }, 'advertised_action_result')
    const card = page.locator(`.assignmentCard[data-assignment="${assignment.id}"]`)
    await expect(card).toContainText('Build 234 reviewed')
    await card.getByRole('button', { name: 'Accept this result' }).click()
    await expect.poll(() => log.snapshot().assignments[0]?.status).toBe('accepted')
    await page.keyboard.press('Escape')
    await page.locator('#manageAgents').click()
    actions = []
    await announce()
    await expect(choose).toHaveCount(0)
    worker.leave()
    await expect(page.locator('#inviteList')).toContainText('host reports it running')
  } finally { off(); worker?.leave(); host.leave(); await context.close() }
})
