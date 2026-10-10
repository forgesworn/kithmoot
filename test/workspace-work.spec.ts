import { test, expect } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from 'nostr-tools/pure'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
import { RoomAgent } from '../src/agent.js'
import { localIdentity } from '../src/identity.js'
import { npubEncode } from 'nostr-tools/nip19'
import { encodeRoomLink } from '../src/link.js'
import { agentRelaysFor } from './relays.js'

test('cross-project Inbox routes a question, human mention, reply and exact-result review to their origins', async ({ browser, baseURL }, info) => {
  test.setTimeout(90_000)
  const key = generateSecretKey(), pubkey = getPublicKey(key)
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block',
    viewport: info.project.name === 'chromium-desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 } })
  await context.exposeFunction('workspacePublicKey', () => pubkey)
  await context.exposeFunction('workspaceSign', (event: EventTemplate) => finalizeEvent(event, key))
  await context.exposeFunction('workspaceEncrypt', (peer: string, value: string) => encrypt(value, getConversationKey(key, peer)))
  await context.exposeFunction('workspaceDecrypt', (peer: string, value: string) => decrypt(value, getConversationKey(key, peer)))
  const relay = new URL('/__test-relay', baseURL!); relay.protocol = 'wss:'
  await context.addInitScript(relay => {
    const host = window as unknown as { workspacePublicKey(): Promise<string>; workspaceSign(event: unknown): Promise<unknown>;
      workspaceEncrypt(peer: string, text: string): Promise<string>; workspaceDecrypt(peer: string, text: string): Promise<string> }
    Object.defineProperty(window, 'nostr', { value: { getPublicKey: () => host.workspacePublicKey(), signEvent: (event: unknown) => host.workspaceSign(event),
      nip44: { encrypt: (peer: string, text: string) => host.workspaceEncrypt(peer, text), decrypt: (peer: string, text: string) => host.workspaceDecrypt(peer, text) } } })
    const Native = window.WebSocket
    const state = window as unknown as { workspaceRequests: unknown[][] }
    state.workspaceRequests = []
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        const defaults = ['wss://nostr.mom', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es', 'wss://relay.damus.io']
        if (!defaults.includes(String(url).replace(/\/$/, '')) && String(url) !== relay) throw new Error('External relay blocked by workspace acceptance')
        super(relay, protocols)
      }
      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === 'string') { const message = JSON.parse(data); if (message[0] === 'REQ') state.workspaceRequests.push(message) }
        super.send(data)
      }
    }
  }, relay.href)
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  const sharedAgent = localIdentity(generateSecretKey())
  const roomNames = ['Design room', 'Release room', 'Research room', 'Unjoined room']
  const keepers = await Promise.all(roomNames.map((roomName, i) => RoomAgent.create({ base: baseURL!, roomName, name: i < 2 ? 'Tally' : 'Researcher',
    ...(i < 2 ? { identity: sharedAgent } : {}), ...agentRelaysFor(baseURL!) })))
  const saved = keepers.map((keeper, i) => ({ roomId: keeper.roomId, name: roomNames[i]!,
    link: encodeRoomLink(baseURL!, { ...keeper.link, relays: [relay.href] }), openedAt: i === 3 ? 0 : 1, readAt: 0 }))
  await context.addInitScript(({ saved, pubkey }) => {
    if (localStorage.getItem('workspace-fixture-seeded')) return
    for (const room of saved) localStorage.setItem(`kithmoot.account.${pubkey}.kithmoot.room.${room.roomId}`, JSON.stringify(room))
    localStorage.setItem('workspace-fixture-seeded', 'true')
  }, { saved, pubkey })
  const page = await context.newPage()
  const logs = await Promise.all(keepers.map(async keeper => {
    let cache: string | undefined
    return keeper.session.assignments({ load: async () => cache, save: async value => { cache = value } })
  }))
  let human: RoomAgent | undefined
  const openProjects = async () => {
    if (!await page.locator('#sharedProjects').isVisible()) {
      if (await page.locator('#roomArea').isVisible()) { await page.locator('#backToRooms').click(); await page.locator('#switcherSharedProjects').click() }
      else await page.locator('#homeSharedProjects').click()
    }
  }
  const enter = async (project: string, room: string) => {
    await openProjects()
    await page.locator('.sharedProjectCard').filter({ has: page.getByRole('heading', { name: project, exact: true }) }).getByRole('button', { name: room, exact: true }).click()
    if (await page.locator('#displayName').isVisible()) { await page.locator('#displayName').fill('Ada'); await page.locator('#join').click() }
    await expect(page.locator('#chatInput')).toBeEditable()
  }
  const inbox = async () => {
    if (await page.locator('#mobileWorkspaceInbox').isVisible()) await page.locator('#mobileWorkspaceInbox').click()
    else if (await page.locator('#workspaceInbox').isVisible()) await page.locator('#workspaceInbox').click()
    else { await page.locator('#backToRooms').click(); await page.locator('#switcherInbox').click() }
    await expect(page.locator('#workspaceWorkPanel')).toBeVisible()
  }
  try {
    await page.goto(baseURL! + '?signin=nostr')
    await page.getByRole('button', { name: /Browser extension/ }).click()
    await openProjects()
    await expect(page.locator('#sharedProjectsStatus')).toContainText('Shared with')
    for (const [i, project] of ['Design project', 'Release project', 'Research project', 'Unjoined project'].entries()) {
      await page.locator('#sharedProjectNew').click(); await page.locator('#sharedProjectName').fill(project)
      await page.locator('#sharedProjectNpub').fill(npubEncode(keepers[i]!.participant))
      await page.locator('#sharedProjectContactKind').selectOption('agent')
      await page.locator('#sharedProjectAddPerson').click()
      await page.locator('#sharedProjectRooms').getByRole('checkbox', { name: saved[i]!.name, exact: true }).check()
      await page.locator('#sharedProjectSave').click(); await expect(page.locator('#sharedProjectEditor')).not.toBeVisible()
    }
    await enter('Design project', 'Design room')
    await page.locator('#mobileWork:visible, #openAssignments:visible').click()
    await page.getByText('New assignment', { exact: true }).click()
    await expect(page.locator('#assignmentOwner option[value="' + keepers[0]!.participant + '"]')).toHaveCount(1)
    await page.locator('#assignmentOwner').selectOption(keepers[0]!.participant)
    await page.locator('#assignmentCreate [name=objective]').fill('Check the design build')
    await page.locator('#assignmentCreate [name=criteria]').fill('Report the exact build with evidence')
    await page.locator('#assignmentCreate button[type=submit]').click()
    await expect.poll(() => logs[0]!.snapshot().assignments.length).toBe(1)
    const task = logs[0]!.snapshot().assignments[0]!
    await page.locator('#assignmentClose').click()
    await enter('Research project', 'Research room')
    await page.locator('#mobileWork:visible, #openAssignments:visible').click()
    await page.getByText('New assignment', { exact: true }).click()
    await page.locator('#assignmentOwner').selectOption(keepers[2]!.participant)
    await page.locator('#assignmentCreate [name=objective]').fill('Independent research task')
    await page.locator('#assignmentCreate [name=criteria]').fill('Keep this research in its own project')
    await page.locator('#assignmentCreate button[type=submit]').click()
    await expect.poll(() => logs[2]!.snapshot().assignments.length).toBe(1)
    const research = logs[2]!.snapshot().assignments[0]!
    await page.locator('#assignmentClose').click()
    await enter('Release project', 'Release room')
    await page.locator('#chatInput').fill('Keep this release draft')
    await logs[0]!.submit(task.id, { op: 'claim', executor: 'workspace_fixture_executor', next: 'Find the build' }, 'workspace_claim_0001')
    await logs[0]!.submit(task.id, { op: 'block', executor: 'workspace_fixture_executor', question: 'Which design build should I check?' }, 'workspace_question_0001')
    // A task in the unjoined project is invisible even though its invitation
    // and directory label are known. No admission is performed by the Inbox.
    await logs[3]!.submit(undefined, { op: 'create', objective: 'Private unjoined work', criteria: 'Do not leak', owner: keepers[3]!.participant }, 'workspace_private_0001')
    await page.evaluate(() => { (window as unknown as { workspaceRequests: unknown[][] }).workspaceRequests = [] })
    await inbox()
    const card = page.locator(`#workspaceWorkCards [data-assignment="${task.id}"]`)
    await expect(card).toContainText('Design project · Design room')
    await expect(card).toContainText('Which design build should I check?')
    await expect(page.locator('#workspaceWorkCards')).not.toContainText('Private unjoined work')
    await expect(page.locator('#workspaceWorkCards')).toContainText('Join this room before viewing its work')
    await page.locator('#workspaceWorkTab').click()
    await expect(card).toContainText('Responsible:')
    await expect(card).toContainText('(agent)')
    await expect(card).toContainText('blocked')
    const researchCard = page.locator(`#workspaceWorkCards [data-assignment="${research.id}"]`)
    await expect(researchCard).toContainText('Research project · Research room')
    await page.locator('#workspaceWorkProject').selectOption({ label: 'Research project' })
    await expect(card).toHaveCount(0)
    await expect(researchCard).toBeVisible()
    await page.locator('#workspaceWorkProject').selectOption('*')
    await page.locator('#workspaceInboxTab').click()
    await page.locator('#workspaceWorkProject').selectOption({ label: 'Release project' })
    await expect(card).toHaveCount(0)
    await page.locator('#workspaceWorkProject').selectOption('*')
    const requests = await page.evaluate(() => (window as unknown as { workspaceRequests: unknown[][] }).workspaceRequests)
    const chatFilters = requests.flatMap(request => request.slice(2) as Array<{ kinds?: number[]; limit?: number; since?: number }>)
      .filter(filter => filter.kinds?.includes(1460))
    expect(chatFilters.length).toBeGreaterThan(0)
    expect(chatFilters.every(filter => filter.limit !== undefined && filter.limit <= 128 && filter.since !== undefined)).toBe(true)
    expect(await page.locator('#workspaceWorkPanel').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    const originalViewport = page.viewportSize()!
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 844 })
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
      expect(await page.locator('#workspaceWorkPanel').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
      if (width <= 700) expect(await page.locator('#mobileWorkspaceDestinations').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = '' })
    await page.setViewportSize(originalViewport)
    await page.screenshot({ path: info.outputPath('workspace-inbox.png') })
    await card.getByRole('button', { name: 'Open task in room' }).click()
    const detail = page.locator(`.assignmentCard[data-assignment="${task.id}"]`)
    await expect(detail).toContainText('Which design build should I check?')
    await detail.getByLabel('Answer for the owner').fill('Design build 67')
    await detail.getByRole('button', { name: 'Send answer' }).click()
    await expect.poll(() => logs[0]!.snapshot().assignments[0]?.answer).toBe('Design build 67')
    await page.locator('#assignmentClose').click()
    await enter('Release project', 'Release room')
    await expect(page.locator('#chatInput')).toHaveValue('Keep this release draft')
    const result = await logs[0]!.submit(task.id, { op: 'result', executor: 'workspace_fixture_executor', summary: 'Design build 67 checked', evidence: 'Exact fixture build and test report' }, 'workspace_result_0001')
    human = await RoomAgent.join({ link: keepers[0]!.url, name: 'Bob', agent: false, ...agentRelaysFor(baseURL!) })
    await human.session.chat.send('Ada, please check the final colour', { mentions: [pubkey] })
    await inbox()
    await expect(card).toContainText('Review: Check the design build')
    await expect(page.locator('#workspaceWorkCards')).toContainText('Mentioned you')
    await card.getByRole('button', { name: 'Open task in room' }).click()
    await expect(detail).toContainText('Design build 67 checked')
    await detail.getByRole('button', { name: 'Accept this result' }).click()
    await expect.poll(() => logs[0]!.snapshot().assignments[0]?.status).toBe('accepted')
    expect(logs[0]!.snapshot().assignments[0]!.result?.id).toBe(result.result!.id)
    await page.locator('#assignmentClose').click()
    await page.locator('#chatInput').fill('A message from Ada'); await page.locator('#chatInput').press('Enter')
    await expect.poll(() => human!.session.chat.messages().some(message => message.text === 'A message from Ada')).toBe(true)
    const parent = human.session.chat.messages().find(message => message.text === 'A message from Ada')!
    await enter('Release project', 'Release room')
    await human.session.chat.send('A human reply across projects', { replyTo: parent })
    await inbox()
    const reply = page.locator('.workspaceWorkCard').filter({ hasText: 'A human reply across projects' })
    await expect(reply).toContainText('Reply to you')
    await expect(card).toHaveCount(0)
    await reply.getByRole('button', { name: 'Open message in room' }).click()
    await expect(page.locator('#chatLog')).toContainText('A human reply across projects')
    await expect(page.locator('#chatLog [data-message-id]:focus')).toContainText('A human reply across projects')
    // Ending an admitted room drops it from the view; the invitation alone
    // cannot keep its data visible. Reopening the view after refresh still
    // excludes it, alongside the unjoined room's private task.
    await enter('Release project', 'Release room')
    await page.locator('#chatInput').fill('')
    await inbox()
    await page.evaluate(({ room, pubkey }) => {
      const key = `kithmoot.account.${pubkey}.kithmoot.room.${room}`
      const saved = JSON.parse(localStorage.getItem(key)!)
      saved.endedAt = Math.floor(Date.now() / 1000)
      localStorage.setItem(key, JSON.stringify(saved))
    }, { room: saved[0]!.roomId, pubkey })
    await page.locator('#workspaceWorkRefresh').click()
    await expect(page.locator(`#workspaceWorkCards [data-room="${saved[0]!.roomId}"]`)).toHaveCount(0)
    await expect(page.locator('#workspaceWorkCards')).not.toContainText('Private unjoined work')
    await page.locator('#workspaceWorkClose').click()
    await page.locator('#backToRooms').click()
    await page.locator('#roomSwitcherHome').click()
    await expect(page.locator('#homeInbox')).toBeVisible()
    await page.locator('#homeInbox').click()
    await expect(page.locator('#workspaceWorkStatus')).not.toContainText('Sign in')
    await page.locator('#workspaceWorkClose').click()
    await page.locator('#openAppSettings').click()
    await page.locator('#signOut').click()
    await page.locator('#appSettingsClose').click()
    await page.locator('#homeInbox').click()
    await expect(page.locator('#workspaceWorkStatus')).toContainText('Sign in with Nostr')
    await expect(page.locator('#workspaceWorkCards .workspaceWorkCard')).toHaveCount(0)
  } finally { await human?.leave(); await context.close(); await Promise.all(keepers.map(keeper => keeper.leave())) }
})
