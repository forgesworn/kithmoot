import { test, expect, type Browser, type Page } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from 'nostr-tools/pure'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
import { npubEncode } from 'nostr-tools/nip19'
import { RoomAgent } from '../src/agent.js'
import { encodeRoomLink } from '../src/link.js'
import { agentRelaysFor } from './relays.js'
import { writeFile } from 'node:fs/promises'
import { openRoomDetails } from './browser.js'

test('project logos recover privately and follow explicit room and call contexts', async ({ browser, baseURL }, info) => {
  const owner = await signedDevice(browser, baseURL!), member = await signedDevice(browser, baseURL!)
  const externalImages: string[] = []
  const checkImages = (device: Awaited<ReturnType<typeof signedDevice>>) => device.context.on('request', request => {
    if (request.resourceType() === 'image' && /^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(baseURL!).origin) externalImages.push(request.url())
  })
  checkImages(owner); checkImages(member)
  const keeper = await RoomAgent.create({ base: baseURL!, name: 'Keeper', roomName: 'Shared workshop', ...agentRelaysFor(baseURL!) })
  const sideKeeper = await RoomAgent.create({ base: baseURL!, name: 'Keeper', roomName: 'Side workshop', ...agentRelaysFor(baseURL!) })
  const saved = { roomId: keeper.roomId, name: 'Shared workshop', link: encodeRoomLink(baseURL!, { ...keeper.link, relays: [owner.relay] }), openedAt: 1, readAt: 0 }
  const side = { roomId: sideKeeper.roomId, name: 'Side workshop', link: encodeRoomLink(baseURL!, { ...sideKeeper.link, relays: [owner.relay] }), openedAt: 1, readAt: 0 }
  await owner.context.addInitScript(({ saved, side, pubkey }) => {
    localStorage.setItem(`kithmoot.account.${pubkey}.kithmoot.room.${saved.roomId}`, JSON.stringify(saved))
    localStorage.setItem(`kithmoot.account.${pubkey}.kithmoot.room.${side.roomId}`, JSON.stringify(side))
  }, { saved, side, pubkey: owner.pubkey })
  let recovered: Awaited<ReturnType<typeof signedDevice>> | undefined
  const openProjects = async (page: Page) => {
    await page.locator('#homeSharedProjects:visible, #workspaceSharedProjects:visible, #switcherSharedProjects:visible').first().click()
    await expect(page.locator('#sharedProjectsStatus')).toContainText('Shared with')
  }
  const card = (page: Page, name: string) => page.locator('.sharedProjectCard').filter({ has: page.getByRole('heading', { name, exact: true }) })
  const picture = (page: Page, name: string) => card(page, name).locator('.sharedProjectLogo img')
  const png = async (page: Page, colour: string) => Buffer.from(await page.evaluate(colour => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 100
    const context = canvas.getContext('2d')!; context.fillStyle = colour; context.fillRect(0, 0, 100, 100)
    return canvas.toDataURL('image/png').split(',')[1]!
  }, colour), 'base64')
  const choose = async (page: Page, colour: string) => {
    await page.locator('.logoEditor input[type=file]').setInputFiles({ name: 'private-source.png', mimeType: 'image/png', buffer: await png(page, colour) })
    await expect(page.locator('.logoEditor [data-action=save]')).toBeEnabled()
  }
  const create = async (page: Page, name: string) => {
    await page.locator('#sharedProjectNew').click(); await page.locator('#sharedProjectName').fill(name)
    await page.locator('#sharedProjectNpub').fill(npubEncode(member.pubkey)); await page.locator('#sharedProjectAddPerson').click()
    await page.locator('#sharedProjectRooms').getByRole('checkbox', { name: saved.name, exact: true }).check()
    if (name === 'Red project') await page.locator('#sharedProjectRooms').getByRole('checkbox', { name: side.name, exact: true }).check()
    await page.locator('#sharedProjectSave').click(); await expect(page.locator('#sharedProjectEditor')).not.toBeVisible()
  }
  try {
    const [a, b] = await Promise.all([owner, member].map(async device => {
      const page = await device.context.newPage(); await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(baseURL! + '?signin=nostr'); await page.getByRole('button', { name: /Browser extension/ }).click()
      await openProjects(page); return page
    }))
    await create(a!, 'Red project'); await create(a!, 'Blue project')
    const sources = new Map<string, string>()
    for (const [name, colour] of [['Red project', '#ff0000'], ['Blue project', '#0000ff']] as const) {
      await card(a!, name).getByRole('button', { name: 'Change project logo' }).click(); await choose(a!, colour)
      await a!.locator('.logoEditor [data-action=save]').click(); await expect(a!.locator('.logoEditor')).toHaveCount(0)
      await expect(picture(a!, name)).toHaveAttribute('src', /^data:image\/(png|webp);base64,/)
      const source = (await picture(a!, name).getAttribute('src'))!; sources.set(name, source)
      await expect(picture(b!, name)).toHaveAttribute('src', source)
      expect(await picture(b!, name).evaluate(async (image: HTMLImageElement) => { await image.decode(); return image.naturalWidth })).toBeGreaterThan(0)
      await expect(card(b!, name).getByRole('button', { name: 'Change project logo' })).toHaveCount(0)
      await expect(b!.locator('#roomArea')).not.toBeVisible()
      await card(b!, name).getByRole('button', { name: 'Review and join' }).click()
      await b!.locator('#sharedProjectSave').click(); await expect(b!.locator('#sharedProjectEditor')).not.toBeVisible()
    }
    // Cancelling a new crop leaves the shared artwork unchanged.
    await card(a!, 'Red project').getByRole('button', { name: 'Change project logo' }).click(); await choose(a!, '#00ff00')
    await a!.locator('.logoEditor [data-action=cancel]').click()
    await expect(picture(b!, 'Red project')).toHaveAttribute('src', sources.get('Red project')!)
    await b!.locator('#sharedProjectsClose').click()
    const row = b!.locator(`#roomList [data-room="${saved.roomId}"]`)
    await expect(row.locator('.roomAvatar img')).toHaveCount(0)
    const filters = b!.locator('#homeProject')
    const options = await filters.locator('option').evaluateAll(options => options.map(option => ({ value: (option as HTMLOptionElement).value, text: option.textContent })))
    const red = options.find(option => option.text === 'Red project')!.value, blue = options.find(option => option.text === 'Blue project')!.value
    await filters.selectOption(red); await expect(row.locator('.roomAvatar img')).toHaveAttribute('src', sources.get('Red project')!)
    await filters.selectOption(blue); await expect(row.locator('.roomAvatar img')).toHaveAttribute('src', sources.get('Blue project')!)
    await row.getByRole('button', { name: `Open ${saved.name}`, exact: true }).click()
    if (await b!.locator('#displayName').isVisible()) { await b!.locator('#displayName').fill('Member'); await b!.locator('#join').click() }
    await expect(b!.locator('#roomArea')).toBeVisible()
    await expect(b!.locator('#roomLogo img')).toHaveAttribute('src', sources.get('Blue project')!)
    await openRoomDetails(b!); await b!.getByRole('button', { name: 'Change room logo', exact: true }).click(); await choose(b!, '#00ff00')
    await b!.locator('.logoEditor [data-action=save]').click(); await expect(b!.locator('.logoEditor')).toHaveCount(0)
    const override = await b!.locator('#roomLogo img').getAttribute('src')
    expect(override).not.toBe(sources.get('Blue project'))
    await b!.getByRole('button', { name: 'Change room logo', exact: true }).click()
    await b!.locator('.logoEditor [data-action=remove]').click(); await expect(b!.locator('.logoEditor')).toHaveCount(0)
    await expect(b!.locator('#roomLogo img')).toHaveAttribute('src', sources.get('Blue project')!)
    await b!.locator('#roomSheetClose').click()
    // One call retains its chosen project while the same room is opened
    // from a different project. No camera or microphone is requested.
    await b!.setViewportSize({ width: 1440, height: 900 }); await b!.locator('#callToggle').click()
    await expect(b!.locator('#callSurfaceLogo img')).toHaveAttribute('src', sources.get('Blue project')!)
    await expect(b!.locator('#callSurfaceOrigin')).toHaveText('Call in Shared workshop · Blue project')
    await openProjects(b!); await card(b!, 'Red project').getByRole('button', { name: saved.name, exact: true }).click()
    await expect(b!.locator('#roomLogo img')).toHaveAttribute('src', sources.get('Red project')!)
    await expect(b!.locator('#callSurfaceLogo img')).toHaveAttribute('src', sources.get('Blue project')!)
    await expect(b!.locator('#callSurfaceOrigin')).toHaveText('Call in Shared workshop · Blue project')
    await openProjects(b!); await card(b!, 'Red project').getByRole('button', { name: side.name, exact: true }).click()
    if (await b!.locator('#displayName').isVisible()) { await b!.locator('#displayName').fill('Member'); await b!.locator('#join').click() }
    await expect(b!.locator('#roomTitle')).toHaveText(side.name)
    await expect(b!.locator('#roomLogo img')).toHaveAttribute('src', sources.get('Red project')!)
    await expect(b!.locator('#callSurfaceLogo img')).toHaveAttribute('src', sources.get('Blue project')!)
    await expect(b!.locator('#callSurfaceOrigin')).toHaveText('Call in Shared workshop · Blue project')
    // Recover from signed encrypted relays without copying a local cache.
    recovered = await signedDevice(browser, baseURL!, true, member.key)
    checkImages(recovered)
    const fresh = await recovered.context.newPage(); await fresh.setViewportSize({ width: 320, height: 640 })
    await fresh.goto(baseURL! + '?signin=nostr'); await fresh.getByRole('button', { name: /Browser extension/ }).click(); await openProjects(fresh)
    for (const name of ['Red project', 'Blue project']) await expect(picture(fresh, name)).toHaveAttribute('src', sources.get(name)!)
    const stored = await fresh.evaluate(() => Object.entries(localStorage).filter(([key]) => key.includes('shared-projects')).map(([, value]) => value).join(''))
    expect(stored).not.toContain('Red project'); expect(stored).not.toContain('private-source.png'); expect(stored).not.toContain(sources.get('Red project'))
    for (const colourScheme of ['light', 'dark'] as const) {
      await fresh.emulateMedia({ colorScheme: colourScheme }); await fresh.screenshot({ path: info.outputPath(`project-logos-320-${colourScheme}.png`), fullPage: true })
      expect(await fresh.locator('#sharedProjects').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth)).toBe(true)
    }
    await card(a!, 'Blue project').getByRole('button', { name: 'Change project logo' }).click()
    await a!.locator('.logoEditor [data-action=remove]').click(); await expect(a!.locator('.logoEditor')).toHaveCount(0)
    await expect(picture(fresh, 'Blue project')).toHaveCount(0)
    await expect(b!.locator('#callSurfaceLogo img')).toHaveCount(0)
    await expect(b!.locator('#roomLogo img')).toHaveAttribute('src', sources.get('Red project')!)
    expect(externalImages).toEqual([])
  } finally {
    await recovered?.context.close(); await Promise.all([owner.context.close(), member.context.close()]); await Promise.all([keeper.leave(), sideKeeper.leave()])
  }
})

/** Synthetic NIP-07 signer: private keys stay in the test process. */
async function signedDevice(browser: Browser, base: string, nip44 = true, key = generateSecretKey()) {
  const pubkey = getPublicKey(key)
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' })
  await context.exposeFunction('projectTestPublicKey', () => pubkey)
  await context.exposeFunction('projectTestSign', (event: EventTemplate) => finalizeEvent(event, key))
  await context.exposeFunction('projectTestEncrypt', (peer: string, value: string) => encrypt(value, getConversationKey(key, peer)))
  await context.exposeFunction('projectTestDecrypt', (peer: string, value: string) => decrypt(value, getConversationKey(key, peer)))
  const relay = new URL('/__test-relay', base); relay.protocol = 'wss:'
  await context.addInitScript(({ relay, nip44 }) => {
    const provider = window as unknown as {
      projectTestPublicKey(): Promise<string>; projectTestSign(event: unknown): Promise<unknown>;
      projectTestEncrypt(peer: string, value: string): Promise<string>; projectTestDecrypt(peer: string, value: string): Promise<string>;
    }
    Object.defineProperty(window, 'nostr', { configurable: true, value: {
      getPublicKey: () => provider.projectTestPublicKey(), signEvent: (event: unknown) => provider.projectTestSign(event),
      ...(nip44 ? { nip44: { encrypt: (peer: string, value: string) => provider.projectTestEncrypt(peer, value),
        decrypt: (peer: string, value: string) => provider.projectTestDecrypt(peer, value) } } : {}),
    } })
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        const defaults = ['wss://nostr.mom', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://purplepag.es', 'wss://relay.damus.io']
        if (!defaults.includes(String(url).replace(/\/$/, '')) && String(url) !== relay) throw new Error('External relay blocked by project acceptance')
        super(relay, protocols)
      }
    }
  }, { relay: relay.href, nip44 })
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  return { context, pubkey, relay: relay.href, key }
}

test('three projects deliver only intended human and agent memberships to fresh devices', async ({ browser, baseURL }, info) => {
  const ada = await signedDevice(browser, baseURL!), bob = await signedDevice(browser, baseURL!)
  const carol = await signedDevice(browser, baseURL!), worker = await signedDevice(browser, baseURL!)
  const keepers = await Promise.all(['Design conversation', 'Release conversation', 'Private conversation'].map(roomName =>
    RoomAgent.create({ base: baseURL!, name: 'Keeper', roomName, ...agentRelaysFor(baseURL!) })))
  const saved = keepers.map((keeper, i) => ({ roomId: keeper.roomId,
    name: ['Design conversation', 'Release conversation', 'Private conversation'][i]!,
    link: encodeRoomLink(baseURL!, { ...keeper.link, relays: [ada.relay] }), openedAt: 1, readAt: 0 }))
  for (const [device, rooms] of [[ada, saved.slice(0, 2)], [carol, saved.slice(2)]] as const) {
    await device.context.addInitScript(({ rooms, pubkey }) => {
      if (localStorage.getItem('project-membership-seeded')) return
      for (const room of rooms) localStorage.setItem(`kithmoot.account.${pubkey}.kithmoot.room.${room.roomId}`, JSON.stringify(room))
      localStorage.setItem('project-membership-seeded', 'true')
    }, { rooms, pubkey: device.pubkey })
  }
  const pages = await Promise.all([ada, bob, carol, worker].map(async device => {
    const page = await device.context.newPage()
    await page.setViewportSize(info.project.name === 'chromium-desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 })
    await page.goto(baseURL! + '?signin=nostr')
    await page.getByRole('button', { name: /Browser extension/ }).click()
    await page.locator('#homeSharedProjects:visible, #workspaceSharedProjects:visible').first().click()
    await expect(page.locator('#sharedProjectsStatus')).toContainText('Shared with')
    return page
  }))
  const [a, b, c, w] = pages
  const names = (page: Page) => page.locator('.sharedProjectCard h3')
  const create = async (page: Page, name: string, room: string, members: { pubkey: string; kind: 'person' | 'agent' }[]) => {
    await page.locator('#sharedProjectNew').click()
    await page.locator('#sharedProjectName').fill(name)
    for (const member of members) {
      await page.locator('#sharedProjectNpub').fill(npubEncode(member.pubkey))
      await page.locator('#sharedProjectContactKind').selectOption(member.kind)
      await page.locator('#sharedProjectAddPerson').click()
    }
    await page.locator('#sharedProjectRooms').getByRole('checkbox', { name: room, exact: true }).check()
    await page.locator('#sharedProjectSave').click()
    await expect(page.locator('#sharedProjectEditor')).not.toBeVisible()
    await expect(names(page)).toContainText([name])
  }
  let fresh: Awaited<ReturnType<typeof signedDevice>> | undefined
  try {
    await create(a!, 'Design project', saved[0]!.name, [{ pubkey: bob.pubkey, kind: 'person' }, { pubkey: worker.pubkey, kind: 'agent' }])
    await create(a!, 'Release project', saved[1]!.name, [{ pubkey: carol.pubkey, kind: 'person' }, { pubkey: worker.pubkey, kind: 'agent' }])
    await create(c!, 'Private project', saved[2]!.name, [])
    await expect(names(a!)).toHaveText(['Design project', 'Release project'])
    await expect(names(b!)).toHaveText(['Design project'])
    await expect(names(c!)).toHaveText(['Private project', 'Release project'])
    await expect(names(w!)).toHaveText(['Design project', 'Release project'])
    // Receiving a directory invitation must not enter its room or start media.
    for (const page of [b!, c!, w!]) await expect(page.locator('#roomArea')).not.toBeVisible()
    for (const [page, project] of [[b!, 'Design project'], [c!, 'Release project'], [w!, 'Design project'], [w!, 'Release project']] as const) {
      const card = page.locator('.sharedProjectCard').filter({ has: page.getByRole('heading', { name: project, exact: true }) })
      await expect(card.getByRole('button', { name: 'Review and join' })).toBeVisible()
      await card.getByRole('button', { name: 'Review and join' }).click()
      await expect(page.locator('#sharedProjectReview')).toContainText('Joining does not start agents or share your other projects')
      await page.getByRole('button', { name: 'Join project', exact: true }).click()
      await expect(page.locator('#sharedProjectEditor')).not.toBeVisible()
      await expect(card.getByRole('button', { name: 'Review and join' })).toHaveCount(0)
    }
    await expect(w!.locator('.sharedProjectCard')).toContainText(['2 people · 1 agent · 1 room', '2 people · 1 agent · 1 room'])
    // New profile, same synthetic signer: no local room or project cache is copied.
    fresh = await signedDevice(browser, baseURL!, true, carol.key)
    const phone = await fresh.context.newPage()
    await phone.setViewportSize({ width: 390, height: 844 })
    await phone.goto(baseURL! + '?signin=nostr')
    await phone.getByRole('button', { name: /Browser extension/ }).click()
    await phone.locator('#homeSharedProjects:visible, #workspaceSharedProjects:visible').first().click()
    await expect(names(phone)).toHaveText(['Private project', 'Release project'])
    await expect(phone.getByRole('button', { name: 'Review and join' })).toHaveCount(0)
    await expect(phone.locator('.sharedProjectRooms')).toContainText(['Private conversation', 'Release conversation'])
    await expect(names(b!)).toHaveText(['Design project'])
    await expect(b!.locator('.sharedProjectCard')).not.toContainText('Private conversation')
    const stored = await phone.evaluate(() => Object.entries(localStorage).filter(([key]) => key.includes('shared-projects')).map(([, value]) => value).join(''))
    expect(stored.length).toBeGreaterThan(0)
    expect(stored).not.toContain('Private project')
    expect(stored).not.toContain('Private conversation')
    await phone.screenshot({ path: info.outputPath('recovered-project-memberships-phone.png') })
    const switches: { project: string; room: string; milliseconds: number }[] = []
    const enter = async (project: string, room: string) => {
      if (!await phone.locator('#sharedProjects').isVisible()) {
        await phone.locator('#backToRooms').click()
        await phone.locator('#switcherSharedProjects').click()
      }
      const started = Date.now()
      await phone.locator('.sharedProjectCard').filter({ has: phone.getByRole('heading', { name: project, exact: true }) })
        .getByRole('button', { name: room, exact: true }).click()
      await expect(phone.locator('#roomArea:visible, #displayName:visible').first()).toBeVisible()
      if (await phone.locator('#displayName').isVisible()) {
        await phone.locator('#displayName').fill('Carol')
        await phone.locator('#join').click()
      }
      await expect(phone.locator('#roomArea')).toBeVisible()
      await expect(phone.locator('#chatInput')).toBeEditable()
      switches.push({ project, room, milliseconds: Date.now() - started })
    }
    await enter('Release project', 'Release conversation')
    await phone.locator('#chatInput').fill('Unsent release decision')
    await enter('Private project', 'Private conversation')
    await expect(phone.locator('#chatInput')).toHaveValue('')
    await phone.locator('#chatInput').fill('Unsent private research')
    await enter('Release project', 'Release conversation')
    await expect(phone.locator('#chatInput')).toHaveValue('Unsent release decision')
    await enter('Private project', 'Private conversation')
    await expect(phone.locator('#chatInput')).toHaveValue('Unsent private research')
    await expect(phone.locator('#chatLog')).not.toContainText('Unsent release decision')
    await expect(names(b!)).toHaveText(['Design project'])
    await writeFile(info.outputPath('project-membership-journey.json'), JSON.stringify({
      syntheticInputs: true, browserProject: info.project.name, recoveredViewport: { width: 390, height: 844 },
      intendedMembershipsOnly: true, explicitJoins: true, encryptedDirectoryRecovery: true,
      draftsRetainedAcrossProjects: true, physicalPhoneAcceptance: false, liveExecutorAcceptance: false, switches,
    }, null, 2) + '\n')
  } finally {
    await fresh?.context.close()
    await Promise.all([ada, bob, carol, worker].map(device => device.context.close()))
    await Promise.all(keepers.map(keeper => keeper.leave()))
  }
})

test('create an empty project, add a room to that existing project, and restore it after reopening', async ({ browser, baseURL }, info) => {
  const { context, pubkey, relay } = await signedDevice(browser, baseURL!)
  const keeper = await RoomAgent.create({ base: baseURL!, name: 'Keeper', roomName: 'Assignment room', ...agentRelaysFor(baseURL!) })
  // Persistent invitations carry no room traffic key, so use the agent's room ID.
  const saved = { roomId: keeper.roomId, name: 'Assignment room', link: encodeRoomLink(baseURL!, { ...keeper.link, relays: [relay] }), openedAt: 1, readAt: 0 }
  await context.addInitScript(({ saved, pubkey }) => {
    if (localStorage.getItem('project-flow-seeded')) return
    localStorage.setItem(`kithmoot.account.${pubkey}.kithmoot.room.${saved.roomId}`, JSON.stringify(saved))
    localStorage.setItem('project-flow-seeded', 'true')
  }, { saved, pubkey })
  try {
    const page = await context.newPage()
    await page.setViewportSize(info.project.name === 'chromium-desktop' ? { width: 1280, height: 800 } : { width: 390, height: 844 })
    await page.goto(baseURL! + '?signin=nostr')
    await page.getByRole('button', { name: /Browser extension/ }).click()
    await expect(page.locator('#sharedProjectNew')).toBeEnabled()
    await page.locator('#homeNewProject:visible, #workspaceNewProject:visible').first().click()
    await expect(page.locator('#sharedProjectEditor')).toBeVisible()
    await page.locator('#sharedProjectName').fill('Work project')
    await page.locator('#sharedProjectNpub').fill(npubEncode(getPublicKey(generateSecretKey())))
    await page.locator('#sharedProjectAddPerson').click()
    await expect(page.locator('#sharedProjectRooms input:checked')).toHaveCount(0)
    await expect(page.locator('#sharedProjectSave')).toBeEnabled()
    await page.locator('#sharedProjectSave').click()
    const card = page.locator('.sharedProjectCard').filter({ has: page.getByRole('heading', { name: 'Work project', exact: true }) })
    await expect(card).toContainText('2 people · 0 agents · 0 rooms')
    await page.locator('#sharedProjectsClose').click()
    await page.locator(`#roomList [data-room="${saved.roomId}"] .rowMenu`).click()
    await page.getByRole('menuitem', { name: 'Add to a project', exact: true }).click()
    await expect(page.locator('#sharedProjectEditor')).not.toBeVisible()
    await expect(page.locator('#sharedProjectRoomPrompt')).toContainText('Assignment room')
    await card.getByRole('button', { name: 'Add room to project', exact: true }).click()
    await expect(page.locator('#sharedProjectName')).toHaveValue('Work project')
    await expect(page.locator('#sharedProjectPeople input:checked')).toHaveCount(2)
    await expect(page.locator('#sharedProjectRooms').getByRole('checkbox', { name: 'Assignment room', exact: true })).toBeChecked()
    await page.locator('#sharedProjectSave').click()
    await expect(card).toContainText('2 people · 0 agents · 1 room')
    await expect(page.locator('.sharedProjectCard')).toHaveCount(1)
    await page.screenshot({ path: `test-results/project-room-assignment-${info.project.name}.png` })
    await page.close()
    const reopened = await context.newPage()
    await reopened.goto(baseURL!)
    await reopened.locator('#homeSharedProjects:visible, #workspaceSharedProjects:visible').first().click()
    await expect(reopened.locator('.sharedProjectCard')).toHaveCount(1)
    await expect(reopened.locator('.sharedProjectCard')).toContainText('2 people · 0 agents · 1 room')
    await expect(reopened.locator('.sharedProjectCard')).toContainText('Assignment room')
  } finally { await context.close(); await keeper.leave() }
})

test('one room retains a separate rail row in each shared project after a chat refresh', async ({ browser, baseURL }) => {
  const { context, pubkey, relay } = await signedDevice(browser, baseURL!)
  const keeper = await RoomAgent.create({ base: baseURL!, name: 'Keeper', roomName: 'Shared planning', ...agentRelaysFor(baseURL!) })
  const saved = { roomId: keeper.roomId, name: 'Shared planning', link: encodeRoomLink(baseURL!, { ...keeper.link, relays: [relay] }), openedAt: 1, readAt: 0 }
  await context.addInitScript(({ saved, pubkey }) => {
    localStorage.setItem(`kithmoot.account.${pubkey}.kithmoot.room.${saved.roomId}`, JSON.stringify(saved))
  }, { saved, pubkey })
  try {
    const page = await context.newPage()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(baseURL! + '?signin=nostr')
    await page.getByRole('button', { name: /Browser extension/ }).click()
    await page.locator('#homeSharedProjects:visible, #workspaceSharedProjects:visible').first().click()
    for (const name of ['Design team', 'Release team']) {
      await page.locator('#sharedProjectNew').click()
      await page.locator('#sharedProjectName').fill(name)
      await page.locator('#sharedProjectRooms').getByRole('checkbox', { name: 'Shared planning', exact: true }).check()
      await page.locator('#sharedProjectSave').click()
      await expect(page.locator('#sharedProjectEditor')).not.toBeVisible()
    }
    await page.locator('#sharedProjectsClose').click()
    await page.getByRole('button', { name: 'Open Shared planning', exact: true }).click()
    await expect(page.locator('#roomArea:visible, #displayName:visible').first()).toBeVisible()
    if (await page.locator('#displayName').isVisible()) {
      await page.locator('#displayName').fill('Ada')
      await page.locator('#join').click()
    }
    await expect(page.locator('#roomArea')).toBeVisible()
    const rail = page.locator('#workspaceRooms')
    const groups = ['Design team', 'Release team'].map(name => rail.locator('section', { has: page.getByRole('heading', { name, exact: true }) }))
    for (const group of groups) await expect(group.getByRole('button', { name: 'Shared planning', exact: true })).toHaveCount(1)
    const buttons = await Promise.all(groups.map(group => group.getByRole('button', { name: 'Shared planning', exact: true }).elementHandle()))
    await keeper.chat.send('This planning update belongs to both teams.')
    await expect(page.locator('#chatLog')).toContainText('This planning update belongs to both teams.')
    // Draft changes also refresh the real rail; neither association may
    // borrow the other section's row during reconciliation.
    await page.locator('#chatInput').fill('A draft for both teams')
    for (let i = 0; i < groups.length; i++) {
      const button = groups[i]!.getByRole('button', { name: 'Shared planning', exact: true })
      await expect(button).toHaveCount(1)
      expect(await button.evaluate((node, original) => node === original && node.isConnected, buttons[i]!)).toBe(true)
    }
  } finally { await context.close(); await keeper.leave() }
})

test('project creation stays discoverable and explains an incompatible signer', async ({ browser, baseURL }) => {
  const { context } = await signedDevice(browser, baseURL!, false)
  try {
    const page = await context.newPage()
    await page.goto(baseURL! + '?signin=nostr')
    await page.getByRole('button', { name: /Browser extension/ }).click()
    await page.locator('#homeNewProject:visible, #workspaceNewProject:visible').first().click()
    await expect(page.locator('#sharedProjects')).toBeVisible()
    await expect(page.locator('#sharedProjectsStatus')).toContainText('NIP-44')
    await expect(page.locator('#sharedProjectNew')).toBeDisabled()
    await expect(page.locator('#sharedProjectsSignIn')).toBeVisible()
    await expect(page.locator('#projectEditor')).not.toBeVisible()
  } finally { await context.close() }
})


test('a first-time visitor can find New project and sign in from its panel', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' })
  try {
    const page = await context.newPage()
    await page.goto(baseURL!)
    await expect(page.locator('#homeNewProject')).toBeVisible()
    await page.locator('#homeNewProject').click()
    await expect(page.locator('#sharedProjects')).toBeVisible()
    await expect(page.locator('#sharedProjectsStatus')).toContainText('Sign in')
    await expect(page.locator('#sharedProjectsSignIn')).toBeVisible()
    await expect(page.locator('#sharedProjectNew')).toBeDisabled()
  } finally { await context.close() }
})
