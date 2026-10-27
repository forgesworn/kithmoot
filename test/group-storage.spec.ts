import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { deflateSync, crc32 } from 'node:zlib'
import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils'
import { RoomAgent, type KeeperState } from '../src/agent.js'
import { CONTROL_CHANNEL } from '../src/control.js'
import { signRoomStorage } from '../src/room-storage.js'
import { GROUP_STORAGE_MESSAGES, GROUP_STORAGE_WAITING } from '../src/group-storage.js'
import { open, openRoomInfoPage, leaveRoom, newDeviceContext, showChats, startRoom, switchToRoom, TEST_RELAY_HTTP, createRoom } from './browser.js'
import { agentRelaysFor } from './relays.js'
import { MemoryStore } from './group-grants-fixtures.js'
import { GroupNodeServer, routeGroupNode } from './group-node.js'

/**
 * Group storage in the web app (phase S5b): a room whose keeper lists its
 * group's own storage keeps its files there. A real keeper (`RoomAgent` with
 * `groupGrants`) makes the room, signs the node into the invitation and hands
 * every device its grants over the room; a small node (test/group-node.ts)
 * enforces the grant and token rules the library expects and answers as
 * `https://grove.example.net`; the page reaches it through Playwright's
 * routing. Nothing here touches a public file server, and the specs say so.
 */

const NODE_HOST = 'grove.example.net'
const CONSENT = 'kithmoot.file-storage.v1'

/** A solid picture, so what opens is visibly a picture. */
function png(size: number, [r, g, b]: [number, number, number]): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())])
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, sum])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk('IEND', Buffer.alloc(0))])
}
const PHOTO = (name = 'hilltop.png', colour: [number, number, number] = [64, 130, 109]) => ({ name, mimeType: 'image/png', buffer: png(96, colour) })

interface Rig {
  readonly keeper: RoomAgent
  readonly node: GroupNodeServer
  readonly link: string
  /** The keeper's state as it last changed: what a keeper brought back is given. */
  state(): KeeperState | undefined
  stop(): Promise<void>
}

/** A keeper, its node, and the room they make: the room lists the node. */
async function rig(baseURL: string, over: { roomName?: string; slow?: boolean } = {}): Promise<Rig> {
  const node = await GroupNodeServer.start(NODE_HOST)
  let state: KeeperState | undefined
  const keeper = await RoomAgent.create({
    base: baseURL, name: 'Keeper', roomName: over.roomName ?? 'Our group', agent: false, ...agentRelaysFor(baseURL),
    // A keeper that does not look for devices to let in unless it is asked: the roster delay and the sweep are an hour away.
    onState: (s) => { state = s }, groupGrants: { ...grantsConfig(node, new MemoryStore()), ...(over.slow ? { rosterDelayMs: 3_600_000, sweepIntervalMs: 3_600_000 } : {}) },
  })
  node.authority = keeper.link.invitation!.inviter
  return {
    keeper, node, link: keeper.url, state: () => state,
    stop: async () => { await keeper.leave().catch(() => {}); await node.stop() },
  }
}

const grantsConfig = (node: GroupNodeServer, store: MemoryStore) => ({
  nodes: [node.origin], bytes: 100_000_000, store, fetch: node.fetch,
  backoff: { baseMs: 100, maxMs: 1_000 }, pushBudgetMs: 1_000, rosterDelayMs: 100, sweepIntervalMs: 30_000,
})

/** The same room again, with the same ledger: a keeper that was away comes back. */
async function bringKeeperBack(baseURL: string, r: Rig, state: KeeperState): Promise<RoomAgent> {
  return RoomAgent.create({
    base: baseURL, name: 'Keeper', roomName: 'Our group', agent: false, ...agentRelaysFor(baseURL), state,
    groupGrants: grantsConfig(r.node, new MemoryStore()),
  })
}

interface Device { context: BrowserContext; page: Page; offsite: string[] }

/** A person's browser: hermetic, with the node answered by the rig and every other request off this machine refused and counted. */
async function device(browser: Browser, baseURL: string, r: Rig, opts: { viewport?: { width: number; height: number }; dark?: boolean } = {}): Promise<Device> {
  const viewport = opts.viewport ?? { width: 1280, height: 860 }
  const context = await newDeviceContext(browser, baseURL, {
    ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport, colorScheme: opts.dark ? 'dark' : 'light',
    hasTouch: viewport.width < 700, isMobile: viewport.width < 700,
  })
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  await context.routeWebSocket((url) => url.href !== relay.href && url.hostname !== '127.0.0.1', (ws) => ws.close())
  await context.route('**/turn', (route) => route.fulfill({ status: 503, body: '' }))
  const offsite: string[] = []
  await context.route((url) => /^https?:$/.test(url.protocol) && !['localhost', '127.0.0.1'].includes(url.hostname), (route) => { offsite.push(route.request().url()); return route.abort() })
  await routeGroupNode(context, r.node)
  const page = await context.newPage()
  return { context, page, offsite }
}

async function enter(page: Page, link: string, name: string): Promise<void> {
  await open(page, link, name)
  await page.locator('#join').click()
  await expect(page.locator('#roomArea')).toBeVisible({ timeout: 60_000 })
}

const devicePub = (page: Page): Promise<string> => page.evaluate(() => {
  const key = Object.keys(localStorage).find((k) => k.startsWith('kithmoot.device.'))!
  return (JSON.parse(localStorage.getItem(key)!) as { sk: string }).sk
}).then((sk) => getPublicKey(hexToBytes(sk)))

/** Until the keeper has handed this device its grants and the page has them. */
async function holdsGrants(page: Page, node: GroupNodeServer): Promise<void> {
  const pub = await devicePub(page)
  await expect.poll(() => node.grantsOf(pub).length, { timeout: 60_000 }).toBeGreaterThan(0)
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('kithmoot.storage-grants.v1.'))), { timeout: 30_000 }).toBe(true)
}

/** Until the page holds the room's storage list: its nodes, or none. */
const holdsList = (page: Page, nodes: string[]): Promise<void> => expect.poll(() => page.evaluate(() => {
  const key = Object.keys(localStorage).find((k) => k.startsWith('kithmoot.room-storage.v1.'))
  return key ? (JSON.parse(localStorage.getItem(key)!) as { nodes: string[] }).nodes : null
}), { timeout: 30_000 }).toEqual(nodes)

async function pick(page: Page, ...files: Array<{ name: string; mimeType: string; buffer: Buffer }>): Promise<void> {
  const chooser = page.waitForEvent('filechooser')
  await page.locator('#attachToggle').click()
  await (await chooser).setFiles(files)
}

const send = (page: Page) => page.locator('#chatForm button[type=submit]').click()
const chip = (page: Page): Locator => page.locator('#attachStaged .attachChip .s')
const card = (page: Page, name: string): Locator => page.locator('#chatLog .attachment').filter({ has: page.locator('.attName', { hasText: name }) })

async function openCard(page: Page, name: string): Promise<Locator> {
  const c = card(page, name)
  await expect(c).toHaveCount(1, { timeout: 60_000 })
  await c.getByRole('button', { name: /^Show / }).click()
  return c
}

const stored1063 = async (): Promise<number> => ((await (await fetch(`${TEST_RELAY_HTTP}/__stored?kind=1063`)).json()) as { count: number }).count

const LISTED = 'Files in this room go to the group’s own storage.'
const WITHDRAWN = 'This group has no storage right now.'

test.describe('a room that keeps its files on its group’s own computers', () => {
  test.beforeEach(({}, info) => { test.skip(info.project.name !== 'chromium' && info.project.name !== 'chromium-desktop', 'one engine drives the node by routing') })

  test('uploads only to the node, with no notice, no consent written, no public server and no bare file announcement', async ({ browser, baseURL }) => {
    test.setTimeout(180_000)
    const r = await rig(baseURL!)
    const ada = await device(browser, baseURL!, r)
    const announced = await stored1063()
    try {
      const p = ada.page
      await enter(p, r.link, 'Ada')
      await holdsList(p, [r.node.origin])
      await holdsGrants(p, r.node)

      // Room info says where this room's files go; Settings does not claim it.
      await openRoomInfoPage(p, 'Privacy and connection')
      await expect(p.locator('#roomFilesLine')).toHaveText(LISTED)
      await p.keyboard.press('Escape')

      await pick(p, PHOTO())
      await expect(chip(p)).toHaveText(/^\d+ B$|^[\d.]+ KB$/, { timeout: 30_000 })
      await expect(p.locator('#fileTrayStateText')).toHaveText(LISTED)
      await expect(p.locator('#fileNotice')).toBeHidden()
      // Nothing was asked of the person, and nothing written down as their choice.
      expect(await p.evaluate((key) => localStorage.getItem(key), CONSENT)).toBeNull()

      // One upload, to the node, with a token, and the chat has the file.
      expect(r.node.hitsTo('PUT')).toMatchObject([{ path: '/upload', token: true, status: 201 }])
      await send(p)
      await expect(p.locator('#chatLog .attachment')).toHaveCount(1, { timeout: 30_000 })
      await expect(p.locator('#fileTray')).toBeHidden()

      // The upload is written down for the tidy-up under the node's own url, and no bare announcement was published.
      const hash = [...r.node.blobs.keys()][0]!
      const uploads = await p.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('kithmoot.uploads.v1.')).map(([, v]) => v))
      expect(uploads).toHaveLength(1)
      expect(JSON.parse(uploads[0]!)).toEqual([{ url: `${r.node.origin}/${hash}`, sha256: hash, key: 'device' }])
      expect(await stored1063()).toBe(announced)
      expect(ada.offsite).toEqual([])
    } finally { await ada.context.close(); await r.stop() }
  })

  test('a member reads a group file with a signed request; a node that gives it to anyone is refused', async ({ browser, baseURL }) => {
    test.setTimeout(240_000)
    const r = await rig(baseURL!)
    const ada = await device(browser, baseURL!, r)
    const bob = await device(browser, baseURL!, r)
    const cy = await device(browser, baseURL!, r)
    try {
      await enter(ada.page, r.link, 'Ada')
      await holdsGrants(ada.page, r.node)
      await pick(ada.page, PHOTO())
      await expect(chip(ada.page)).toHaveText(/^\d+ B$|^[\d.]+ KB$/, { timeout: 30_000 })
      await send(ada.page)
      await expect(ada.page.locator('#chatLog .attachment')).toHaveCount(1, { timeout: 30_000 })

      // Bob joins later, is given his grants, and opens the file.
      await enter(bob.page, r.link, 'Bob')
      await holdsGrants(bob.page, r.node)
      const opened = await openCard(bob.page, 'hilltop.png')
      const picture = opened.frameLocator('iframe.attachmentPreviewFrame').locator('img')
      await expect(picture).toHaveCount(1, { timeout: 30_000 })
      expect(await picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(96)
      await expect(opened.locator('.say')).toHaveCount(0)

      // Every read the app made carried a token, after one probe that proved the node asks who is asking.
      const reads = r.node.hits.filter((h) => h.method === 'GET')
      expect(reads.length).toBeGreaterThan(0)
      expect(reads.every((h) => h.token && h.status === 200)).toBe(true)
      expect(r.node.hits.filter((h) => h.method === 'HEAD' && !h.token).map((h) => h.status)).toContain(401)
      // And the node itself refuses a read without one.
      const bare = await fetch(`http://127.0.0.1:${r.node.port}/${[...r.node.blobs.keys()][0]}`)
      expect(bare.status).toBe(401)
      expect(bare.headers.get('x-reason')).toBe('missing')
      expect(bob.offsite).toEqual([])

      // A node that now serves files to anyone is not used again: no token goes to it, and the person is told.
      r.node.open = true
      await enter(cy.page, r.link, 'Cy')
      await holdsGrants(cy.page, r.node)
      const before = r.node.hits.length
      await openCard(cy.page, 'hilltop.png')
      await expect(card(cy.page, 'hilltop.png')).toContainText(GROUP_STORAGE_MESSAGES['node-open'], { timeout: 30_000 })
      expect(r.node.hits.slice(before).filter((h) => h.token)).toEqual([])
      expect(r.node.hits.slice(before).filter((h) => h.method === 'GET')).toEqual([])
    } finally { await ada.context.close(); await bob.context.close(); await cy.context.close(); await r.stop() }
  })

  test('a node that serves files to anyone is never sent a file', async ({ browser, baseURL }) => {
    test.setTimeout(180_000)
    const r = await rig(baseURL!)
    const ada = await device(browser, baseURL!, r)
    try {
      await enter(ada.page, r.link, 'Ada')
      await holdsGrants(ada.page, r.node)
      r.node.open = true
      await pick(ada.page, PHOTO())
      await expect(ada.page.locator('#fileTrayErrorText')).toContainText(GROUP_STORAGE_MESSAGES['node-open'], { timeout: 30_000 })
      expect(r.node.hitsTo('PUT')).toEqual([])
      expect(r.node.hits.filter((h) => h.token)).toEqual([])
      expect(r.node.blobs.size).toBe(0)
      // The file stays where it was picked, to try again once the person who runs the node has fixed it.
      await expect(chip(ada.page)).toHaveText('Not uploaded')
    } finally { await ada.context.close(); await r.stop() }
  })

  test('a withdrawn list keeps files off, and the device’s own server is not used instead', async ({ browser, baseURL }) => {
    test.setTimeout(180_000)
    const r = await rig(baseURL!)
    const ada = await device(browser, baseURL!, r)
    try {
      const p = ada.page
      await enter(p, r.link, 'Ada')
      await holdsGrants(p, r.node)
      // The device chose a public server of its own: a withdrawn room still does not use it.
      await p.evaluate((key) => localStorage.setItem(key, JSON.stringify({ mode: 'shared', disclosure: 3, origin: 'https://blossom.yakihonne.com', via: 'default' })), CONSENT)

      // The room's authority signs a newer, empty list and posts it.
      const version = Math.floor(Date.now() / 1000) + 100
      const sig = signRoomStorage({ roomId: r.keeper.roomId, version, nodes: [], authoritySk: r.state()!.inviterSk })
      await r.keeper.channel(CONTROL_CHANNEL).send(JSON.stringify({ op: 'storage', nodes: [], version, sig }))
      await holdsList(p, [])

      await pick(p, PHOTO())
      await expect(p.locator('#fileTrayStateText')).toHaveText(WITHDRAWN)
      await expect(chip(p)).toHaveText('Not uploaded')
      await expect(p.locator('#chatForm button[type=submit]')).toBeDisabled()
      await openRoomInfoPage(p, 'Privacy and connection')
      await expect(p.locator('#roomFilesLine')).toHaveText(WITHDRAWN)
      expect(r.node.hitsTo('PUT')).toEqual([])
      expect(ada.offsite).toEqual([])

      // An older list, posted again by anybody, changes nothing; a newer one that names the node brings uploads back.
      const old = signRoomStorage({ roomId: r.keeper.roomId, version: version - 50, nodes: [r.node.origin], authoritySk: r.state()!.inviterSk })
      await r.keeper.channel(CONTROL_CHANNEL).send(JSON.stringify({ op: 'storage', nodes: [r.node.origin], version: version - 50, sig: old }))
      await p.waitForTimeout(1_500)
      await holdsList(p, [])
      const again = signRoomStorage({ roomId: r.keeper.roomId, version: version + 100, nodes: [r.node.origin], authoritySk: r.state()!.inviterSk })
      await r.keeper.channel(CONTROL_CHANNEL).send(JSON.stringify({ op: 'storage', nodes: [r.node.origin], version: version + 100, sig: again }))
      await holdsList(p, [r.node.origin])
    } finally { await ada.context.close(); await r.stop() }
  })

  test('a device that has no grant yet waits for the group’s storage, the file waits in the outbox, and it goes when the keeper lets the device in', async ({ browser, baseURL }) => {
    test.setTimeout(240_000)
    const r = await rig(baseURL!)
    const ada = await device(browser, baseURL!, r)
    let back: RoomAgent | undefined
    try {
      const p = ada.page
      const state = r.state()!
      // The keeper is away: the room is still there, with its list, but nobody can hand a device a grant.
      await r.keeper.leave()
      await enter(p, r.link, 'Ada')
      await holdsList(p, [r.node.origin])

      await pick(p, PHOTO())
      await expect(chip(p)).toHaveText('Waiting', { timeout: 30_000 })
      await expect(p.locator('#fileTrayStateText')).toHaveText(GROUP_STORAGE_MESSAGES['no-grant'])
      expect(r.node.hitsTo('PUT')).toEqual([])
      await send(p)
      const row = p.locator('#outbox .pendingMsg')
      await expect(row).toHaveCount(1)
      await expect(row.locator('.pendingStatus')).toHaveText(GROUP_STORAGE_WAITING)
      // Nothing of it has left, so it can still be deleted without a trace; and the page asks before it goes, for the sealed file is only here.
      await expect(row.getByRole('button', { name: 'Delete' })).toBeVisible()
      expect(await p.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented })).toBe(true)
      await expect(p.locator('#chatLog .attachment')).toHaveCount(0)

      // The keeper comes back, sees the device, and lets it in: the file goes up, then the message.
      back = await bringKeeperBack(baseURL!, r, state)
      await expect(p.locator('#chatLog .attachment')).toHaveCount(1, { timeout: 90_000 })
      await expect(p.locator('#outbox .pendingMsg')).toHaveCount(0)
      expect(r.node.hitsTo('PUT')).toMatchObject([{ token: true, status: 201 }])
      expect(await p.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented })).toBe(false)
    } finally { await ada.context.close(); await back?.leave().catch(() => {}); await r.stop() }
  })

  test('a device with no grant asks the keeper for them, and the file goes as soon as they come', async ({ browser, baseURL }) => {
    test.setTimeout(180_000)
    const r = await rig(baseURL!, { slow: true })
    const ada = await device(browser, baseURL!, r)
    try {
      const p = ada.page
      await enter(p, r.link, 'Ada')
      await holdsList(p, [r.node.origin])
      const asked = () => r.keeper.channel(CONTROL_CHANNEL).messages().filter((m) => m.text === JSON.stringify({ op: 'storage-grant?' })).length
      expect(asked()).toBe(0)
      // The file is tried at once, finds no grant, and the device asks the room's keeper.
      await pick(p, PHOTO())
      await expect.poll(asked, { timeout: 30_000 }).toBe(1)
      await expect(chip(p)).toHaveText(/^Waiting$|^\d+ B$|^[\d.]+ KB$/, { timeout: 30_000 })
      // The keeper answers a live ask with that device's grants; the file is on the node, and a second ask is not made inside ten minutes.
      await send(p)
      await expect(p.locator('#chatLog .attachment')).toHaveCount(1, { timeout: 60_000 })
      expect(r.node.hitsTo('PUT').filter((h) => h.status === 201)).toHaveLength(1)
      expect(asked()).toBe(1)
    } finally { await ada.context.close(); await r.stop() }
  })

  test('a node that is down holds the file the same way, and the message goes when it is back', async ({ browser, baseURL }) => {
    test.setTimeout(240_000)
    const r = await rig(baseURL!)
    const ada = await device(browser, baseURL!, r)
    try {
      const p = ada.page
      await enter(p, r.link, 'Ada')
      await holdsGrants(p, r.node)
      r.node.down = true
      await pick(p, PHOTO())
      await expect(chip(p)).toHaveText('Waiting', { timeout: 30_000 })
      await expect(p.locator('#fileTrayStateText')).toContainText(GROUP_STORAGE_WAITING)
      await send(p)
      await expect(p.locator('#outbox .pendingMsg .pendingStatus')).toHaveText(GROUP_STORAGE_WAITING)
      await expect(p.locator('#chatLog .attachment')).toHaveCount(0)
      r.node.down = false
      // The outbox tries again on its own back-off; Retry does not wait for it.
      await p.locator('#outbox .pendingMsg').getByRole('button', { name: 'Retry' }).click({ timeout: 10_000 }).catch(() => { /* The back-off got there first. */ })
      await expect(p.locator('#chatLog .attachment')).toHaveCount(1, { timeout: 60_000 })
      expect(r.node.hitsTo('PUT').filter((h) => h.status === 201)).toHaveLength(1)
    } finally { await ada.context.close(); await r.stop() }
  })

  test('Leave and tidy up deletes the files on the node with the signed delete, and a node that was down is asked again at the next launch', async ({ browser, baseURL }, info) => {
    test.skip(info.project.name === 'chromium-desktop', 'one browser project is enough')
    test.setTimeout(240_000)
    const r = await rig(baseURL!)
    const ada = await device(browser, baseURL!, r)
    try {
      const p = ada.page
      await enter(p, r.link, 'Ada')
      await holdsGrants(p, r.node)
      for (const [i, colour] of ([[200, 80, 60], [60, 90, 200]] as const).entries()) {
        await pick(p, PHOTO(`photo-${i + 1}.png`, [...colour]))
        await expect(chip(p)).toHaveText(/^\d+ B$|^[\d.]+ KB$/, { timeout: 30_000 })
        await send(p)
        await expect(p.locator('#chatLog .attachment')).toHaveCount(i + 1, { timeout: 30_000 })
      }
      expect(r.node.blobs.size).toBe(2)

      // The node is down for the tidy-up.
      r.node.down = true
      await leaveRoom(p, { tidy: true })
      await p.locator('#tidyUpRun').click()
      await expect(p.locator('#tidyUpDone')).toBeVisible({ timeout: 60_000 })
      await expect(p.locator('#tidyUpSteps li[data-step="files"] .tidyResult')).toContainText('Deleted 0 of 2.')
      expect(r.node.blobs.size).toBe(2)
      // What is kept names no room, and says which deletes go to a group node.
      const kept = await p.evaluate(() => ({ journal: localStorage.getItem('kithmoot.blob-deletes.v1'), groups: localStorage.getItem('kithmoot.blob-delete-groups.v1') }))
      expect(kept.journal).toBeTruthy()
      expect(JSON.parse(kept.groups!)).toHaveLength(2)
      for (const url of JSON.parse(kept.groups!) as string[]) expect(url.startsWith(`${r.node.origin}/`)).toBe(true)

      // At the next launch the node is back: the kept delete goes, the node takes it, and with no room to read with the outcome is said as it is.
      r.node.down = false
      const launched = p.waitForEvent('load')
      await p.locator('#tidyUpDone').click()
      await launched
      await expect.poll(() => r.node.blobs.size, { timeout: 60_000 }).toBe(0)
      await expect.poll(() => p.evaluate(() => localStorage.getItem('kithmoot.blob-deletes.v1')), { timeout: 30_000 }).toBeNull()
      await expect.poll(() => p.evaluate(() => localStorage.getItem('kithmoot.blob-delete-groups.v1'))).toBeNull()
      expect(r.node.hitsTo('DELETE').filter((h) => h.status === 204)).toHaveLength(2)
      // The room is gone from this device, grants and list with it.
      expect(await p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('kithmoot.storage-grants.v1.') || k.startsWith('kithmoot.room-storage.v1.')))).toEqual([])
      expect(ada.offsite).toEqual([])
    } finally { await ada.context.close(); await r.stop() }
  })

  test('with the room still open, the tidy-up confirms each delete with a signed read', async ({ browser, baseURL }, info) => {
    test.skip(info.project.name === 'chromium-desktop', 'one browser project is enough')
    test.setTimeout(180_000)
    const r = await rig(baseURL!)
    const ada = await device(browser, baseURL!, r)
    try {
      const p = ada.page
      await enter(p, r.link, 'Ada')
      await holdsGrants(p, r.node)
      await pick(p, PHOTO())
      await expect(chip(p)).toHaveText(/^\d+ B$|^[\d.]+ KB$/, { timeout: 30_000 })
      await send(p)
      await expect(p.locator('#chatLog .attachment')).toHaveCount(1, { timeout: 30_000 })
      await leaveRoom(p, { tidy: true })
      await p.locator('#tidyUpRun').click()
      await expect(p.locator('#tidyUpDone')).toBeVisible({ timeout: 60_000 })
      await expect(p.locator('#tidyUpSteps li[data-step="files"] .tidyResult')).toContainText('Deleted 1 of 1.')
      expect(r.node.blobs.size).toBe(0)
      const deletes = r.node.hitsTo('DELETE')
      expect(deletes).toMatchObject([{ token: true, status: 204 }])
      // The look afterwards is a read with a token, answered 404: the file is gone, and this device could see that.
      const looks = r.node.hits.filter((h) => h.method === 'HEAD' && h.token)
      expect(looks.at(-1)).toMatchObject({ status: 404 })
      await expect(p.locator('#tidyUpSteps li[data-step="files"] .tidyResult')).not.toContainText('not confirmed')
    } finally { await ada.context.close(); await r.stop() }
  })

  /** A second room this device is in, so a visit to it is a room switch, then the room with the keeper away: no grant to be had until it returns. */
  async function waitingRoom(browser: Browser, baseURL: string, r: Rig, ada: Device): Promise<void> {
    const p = ada.page
    await p.goto(baseURL)
    await startRoom(p, { name: 'Ada', roomName: 'Side room' })
    await r.keeper.leave()
    await enter(p, r.link, 'Ada')
    await holdsList(p, [r.node.origin])
  }

  test('a file waiting in a room’s draft is still waiting after a visit to another room, and Send never publishes without it', async ({ browser, baseURL }) => {
    test.setTimeout(240_000)
    const r = await rig(baseURL!)
    const ada = await device(browser, baseURL!, r)
    let back: RoomAgent | undefined
    try {
      const p = ada.page
      const state = r.state()!
      await waitingRoom(browser, baseURL!, r, ada)
      await pick(p, PHOTO())
      await expect(chip(p)).toHaveText('Waiting', { timeout: 30_000 })

      // Away to the other room and back: the draft is where it was, and so is the file it names.
      await switchToRoom(p, 'Side room')
      await expect(p.locator('#roomIdentity')).toContainText('Side room')
      await switchToRoom(p, 'Our group')
      await expect(p.locator('#roomIdentity')).toContainText('Our group')
      await expect(chip(p)).toHaveText('Waiting')
      await expect(p.locator('#fileTrayStateText')).toHaveText(GROUP_STORAGE_MESSAGES['no-grant'])

      // Send: the message waits for the file; it is not published without it.
      await send(p)
      await expect(p.locator('#outbox .pendingMsg .pendingStatus')).toHaveText(GROUP_STORAGE_WAITING)
      await expect(p.locator('#chatLog .attachment')).toHaveCount(0)
      expect(r.node.blobs.size).toBe(0)

      // The keeper lets the device in: the file goes up, and only then the message.
      back = await bringKeeperBack(baseURL!, r, state)
      await expect(p.locator('#chatLog .attachment')).toHaveCount(1, { timeout: 90_000 })
      expect(r.node.blobs.size).toBe(1)
      expect(r.node.hitsTo('PUT').filter((h) => h.status === 201)).toHaveLength(1)
    } finally { await ada.context.close(); await back?.leave().catch(() => {}); await r.stop() }
  })

  test('a message waiting for the group’s storage does not trap the person: leaving asks, and Stay stays', async ({ browser, baseURL }) => {
    test.setTimeout(240_000)
    const r = await rig(baseURL!)
    const ada = await device(browser, baseURL!, r)
    try {
      const p = ada.page
      await waitingRoom(browser, baseURL!, r, ada)
      await pick(p, PHOTO())
      await expect(chip(p)).toHaveText('Waiting', { timeout: 30_000 })
      await send(p)
      await expect(p.locator('#outbox .pendingMsg .pendingStatus')).toHaveText(GROUP_STORAGE_WAITING)

      // The room list is not shut: the other room can be opened.
      await showChats(p)
      const side = p.locator('#roomList').getByRole('button', { name: 'Open Side room', exact: true })
      await expect(side).toBeEnabled()
      await side.click()
      const dialog = p.locator('#actionDialog')
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText('Leave with a message still waiting?')
      await expect(dialog).toContainText('it will not be sent, and the files waiting with it will be lost')
      // Stay: nothing changed.
      await dialog.getByRole('button', { name: 'Stay' }).click()
      await expect(p.locator('#roomIdentity')).toContainText('Our group')
      await expect(p.locator('#outbox .pendingMsg')).toHaveCount(1)

      // Leave: in the other room, and the message and its file are gone, as the person was told.
      await side.click()
      await p.locator('#actionDialog').getByRole('button', { name: 'Leave and drop it' }).click()
      await expect(p.locator('#roomIdentity')).toContainText('Side room')
      await switchToRoom(p, 'Our group')
      await expect(p.locator('#roomIdentity')).toContainText('Our group')
      await expect(p.locator('#outbox .pendingMsg')).toHaveCount(0)
      await expect(p.locator('#chatLog .attachment')).toHaveCount(0)
      await expect(p.locator('#attachStaged .attachChip')).toHaveCount(0)
      expect(r.node.blobs.size).toBe(0)
    } finally { await ada.context.close(); await r.stop() }
  })

  test('a stalled upload in the outbox is stopped by Delete, and the message is gone', async ({ browser, baseURL }) => {
    test.setTimeout(240_000)
    const r = await rig(baseURL!)
    const ada = await device(browser, baseURL!, r)
    try {
      const p = ada.page
      await enter(p, r.link, 'Ada')
      await holdsGrants(p, r.node)
      // The node is down when the file is picked, so it is held and waits in the outbox...
      r.node.down = true
      await pick(p, PHOTO())
      await expect(chip(p)).toHaveText('Waiting', { timeout: 30_000 })
      await send(p)
      const row = p.locator('#outbox .pendingMsg')
      await expect(row.locator('.pendingStatus')).toHaveText(GROUP_STORAGE_WAITING)
      // ...then it is back, and takes the file so slowly that the upload is still going.
      r.node.down = false
      r.node.uploadDelayMs = 120_000
      await row.getByRole('button', { name: 'Retry' }).click()
      await expect(row.locator('.pendingStatus')).toHaveText('Sending…')
      await expect.poll(() => r.node.hitsTo('PUT').length + r.node.blobs.size, { timeout: 30_000 }).toBeGreaterThan(0)
      // Delete works while it is sending: the upload is stopped and the message is gone.
      await row.getByRole('button', { name: 'Delete' }).click()
      await p.getByRole('button', { name: 'Delete message' }).click()
      await expect(p.locator('#outbox .pendingMsg')).toHaveCount(0, { timeout: 30_000 })
      await expect(p.locator('#chatLog .attachment')).toHaveCount(0)
      // And nothing goes later: the message was never published.
      r.node.uploadDelayMs = 0
      await p.waitForTimeout(2_000)
      await expect(p.locator('#chatLog .attachment')).toHaveCount(0)
    } finally { await ada.context.close(); await r.stop() }
  })

  test('a wrong clock is said in its own words in the tray, with no Try again that could not succeed', async ({ browser, baseURL }) => {
    test.setTimeout(240_000)
    const r = await rig(baseURL!)
    const ada = await device(browser, baseURL!, r)
    try {
      const p = ada.page
      await enter(p, r.link, 'Ada')
      await holdsGrants(p, r.node)

      // In the tray: its words, and no Try again, which could not succeed this session.
      r.node.skew = 300
      await pick(p, PHOTO('first.png'))
      await expect(p.locator('#fileTrayErrorText')).toContainText(GROUP_STORAGE_MESSAGES.clock, { timeout: 30_000 })
      await expect(p.locator('#fileTryAgain')).toBeHidden()
      await expect(chip(p)).toHaveText('Not uploaded')
      // The node refused the token as expired, and nothing was stored.
      expect(r.node.hitsTo('PUT').map((h) => [h.status, h.reason])).toEqual([[401, 'expired']])
      expect(r.node.blobs.size).toBe(0)
    } finally { await ada.context.close(); await r.stop() }
  })

  test('a message that cannot go because of the clock says so in the outbox, and the outbox leaves it alone', async ({ browser, baseURL }) => {
    test.setTimeout(240_000)
    const r = await rig(baseURL!)
    const ada = await device(browser, baseURL!, r)
    try {
      const p = ada.page
      await enter(p, r.link, 'Ada')
      await holdsGrants(p, r.node)
      r.node.down = true
      await pick(p, PHOTO())
      await expect(chip(p)).toHaveText('Waiting', { timeout: 30_000 })
      await send(p)
      const row = p.locator('#outbox .pendingMsg')
      await expect(row.locator('.pendingStatus')).toHaveText(GROUP_STORAGE_WAITING)
      r.node.down = false
      r.node.skew = 300
      await row.getByRole('button', { name: 'Retry' }).click()
      await expect(row.locator('.pendingStatus')).toHaveText(GROUP_STORAGE_MESSAGES.clock, { timeout: 30_000 })
      // The first back-off is fifteen seconds: past it, nothing has been asked of the node again.
      const asked = r.node.hits.length
      await p.waitForTimeout(17_000)
      expect(r.node.hits.length).toBe(asked)
      await expect(row.locator('.pendingStatus')).toHaveText(GROUP_STORAGE_MESSAGES.clock)
      // It can still be deleted, with nothing of it having left.
      await row.getByRole('button', { name: 'Delete' }).click()
      await p.getByRole('button', { name: 'Delete message' }).click()
      await expect(p.locator('#outbox .pendingMsg')).toHaveCount(0)
    } finally { await ada.context.close(); await r.stop() }
  })

  test('another tab’s older list, or its removal of the record, does not change a room that is open here', async ({ browser, baseURL }) => {
    test.setTimeout(180_000)
    const r = await rig(baseURL!)
    const ada = await device(browser, baseURL!, r)
    try {
      const p = ada.page
      await enter(p, r.link, 'Ada')
      await holdsList(p, [r.node.origin])
      await holdsGrants(p, r.node)
      const other = await ada.context.newPage()
      await other.goto(baseURL!)
      const key = await p.evaluate(() => Object.keys(localStorage).find((k) => k.startsWith('kithmoot.room-storage.v1.'))!)

      // A stale tab writes an older, empty list over the newer one: this tab goes on sending to the node.
      await other.evaluate((k) => localStorage.setItem(k, JSON.stringify({ nodes: [], version: 1 })), key)
      await p.waitForTimeout(500)
      await pick(p, PHOTO('one.png'))
      await expect(chip(p)).toHaveText(/^\d+ B$|^[\d.]+ KB$/, { timeout: 30_000 })
      await expect(p.locator('#fileTrayStateText')).toHaveText(LISTED)
      expect(r.node.hitsTo('PUT').filter((h) => h.status === 201)).toHaveLength(1)

      // Another tab forgets the record: the room is still open here, still the group's.
      await other.evaluate((k) => localStorage.removeItem(k), key)
      await p.waitForTimeout(500)
      await pick(p, PHOTO('two.png', [90, 60, 160]))
      await expect(p.locator('#attachStaged .attachChip')).toHaveCount(2)
      await expect(p.locator('#attachStaged .attachChip .s').nth(1)).toHaveText(/^\d+ B$|^[\d.]+ KB$/, { timeout: 30_000 })
      await expect(p.locator('#fileTrayStateText')).toHaveText(LISTED)
      expect(r.node.hitsTo('PUT').filter((h) => h.status === 201)).toHaveLength(2)
      await expect(p.locator('#fileNotice')).toBeHidden()
    } finally { await ada.context.close(); await r.stop() }
  })

  test('a plain room is unchanged: the one-time notice, the public default, and nothing for a group node', async ({ browser, baseURL }) => {
    test.setTimeout(120_000)
    const r = await rig(baseURL!)
    const ada = await device(browser, baseURL!, r)
    try {
      const p = ada.page
      const link = await createRoom(p, baseURL!, undefined, 'Ada')
      expect(link).toBeTruthy()
      await openRoomInfoPage(p, 'Privacy and connection')
      await expect(p.locator('#roomFilesLine')).toHaveText('Files you send in this room go to blossom.yakihonne.com.')
      await p.keyboard.press('Escape')
      await pick(p, PHOTO())
      await expect(p.locator('#fileNoticeTitle')).toHaveText('Files you send are stored on blossom.yakihonne.com')
      await expect(chip(p)).toHaveText('Not uploaded')
      expect(await p.evaluate((key) => localStorage.getItem(key), CONSENT)).toBeNull()
      expect(r.node.hits).toEqual([])
      expect(ada.offsite).toEqual([])
    } finally { await ada.context.close(); await r.stop() }
  })
})

/**
 * Pictures for the owner, when asked for (`S5B_SHOTS=<folder>`): each state of
 * the group-storage tray, Room info and a group file, at desktop and phone
 * width, light and dark. Not an assertion; the specs above are.
 */
const SHOTS = process.env.S5B_SHOTS
const LOOKS = [
  { name: 'desktop-light', viewport: { width: 1280, height: 860 }, dark: false },
  { name: 'desktop-dark', viewport: { width: 1280, height: 860 }, dark: true },
  { name: 'phone-light', viewport: { width: 390, height: 844 }, dark: false },
  { name: 'phone-dark', viewport: { width: 390, height: 844 }, dark: true },
] as const

for (const look of LOOKS) {
  test(`pictures: group storage, ${look.name}`, async ({ browser, baseURL }, info) => {
    test.skip(!SHOTS || info.project.name !== 'chromium', 'pictures are taken on request, once')
    test.setTimeout(420_000)
    mkdirSync(SHOTS!, { recursive: true })
    const shot = async (p: Page, state: string): Promise<void> => { await p.mouse.move(2, 2); await p.waitForTimeout(500); await p.screenshot({ path: `${SHOTS}/${state}-${look.name}.png` }) }

    // A listed room: staging, an upload in flight, Room info, and an opened file.
    const r = await rig(baseURL!)
    const a = await device(browser, baseURL!, r, look)
    const reader = await device(browser, baseURL!, r, look)
    try {
      const p = a.page
      await enter(p, r.link, 'Ada')
      await holdsGrants(p, r.node)
      r.node.uploadDelayMs = 6_000
      await pick(p, PHOTO('hilltop.png', [64, 130, 109]))
      await expect(chip(p)).toHaveText('Uploading…')
      await shot(p, 'uploading-chip')
      await expect(chip(p)).toHaveText(/^\d+ B$|^[\d.]+ KB$/, { timeout: 30_000 })
      await expect(p.locator('#fileTrayStateText')).toHaveText(LISTED)
      await shot(p, 'listed-tray')
      r.node.uploadDelayMs = 0
      await p.locator('#chatInput').fill('The view from the top')
      await send(p)
      await expect(p.locator('#chatLog .attachment')).toHaveCount(1, { timeout: 30_000 })
      await openRoomInfoPage(p, 'Privacy and connection')
      await shot(p, 'room-info-files-line')
      await p.keyboard.press('Escape')

      await enter(reader.page, r.link, 'Bob')
      await holdsGrants(reader.page, r.node)
      const opened = await openCard(reader.page, 'hilltop.png')
      await expect(opened.locator('img')).toHaveCount(1, { timeout: 30_000 })
      await opened.scrollIntoViewIfNeeded()
      await shot(reader.page, 'opened-group-file')

      // The same room, withdrawn.
      const version = Math.floor(Date.now() / 1000) + 100
      const sig = signRoomStorage({ roomId: r.keeper.roomId, version, nodes: [], authoritySk: r.state()!.inviterSk })
      await r.keeper.channel(CONTROL_CHANNEL).send(JSON.stringify({ op: 'storage', nodes: [], version, sig }))
      await holdsList(p, [])
      await pick(p, PHOTO('plan.png', [200, 130, 60]))
      await expect(p.locator('#fileTrayStateText')).toHaveText(WITHDRAWN)
      await shot(p, 'withdrawn-room')
    } finally { await a.context.close(); await reader.context.close(); await r.stop() }

    // A device with no grant yet: the file waits, and then the message waits in the outbox.
    const w = await rig(baseURL!, { roomName: 'Waiting room' })
    const b = await device(browser, baseURL!, w, look)
    try {
      await w.keeper.leave()
      await enter(b.page, w.link, 'Ada')
      await holdsList(b.page, [w.node.origin])
      await b.page.locator('#chatInput').fill('Photos from today')
      await pick(b.page, PHOTO('harbour.png', [60, 110, 170]))
      await expect(chip(b.page)).toHaveText('Waiting', { timeout: 30_000 })
      await shot(b.page, 'waiting-for-storage-tray')
      await send(b.page)
      await expect(b.page.locator('#outbox .pendingMsg .pendingStatus')).toHaveText(GROUP_STORAGE_WAITING)
      await shot(b.page, 'waiting-for-storage-outbox')
    } finally { await b.context.close(); await w.stop() }
  })
}
