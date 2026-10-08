import { test, expect, type Browser } from '@playwright/test'
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from 'nostr-tools/pure'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
import { npubEncode } from 'nostr-tools/nip19'
import { RoomAgent } from '../src/agent.js'
import { encodeRoomLink } from '../src/link.js'
import { agentRelaysFor } from './relays.js'

/** Synthetic NIP-07 signer: private keys stay in the test process. */
async function signedDevice(browser: Browser, base: string, nip44 = true) {
  const key = generateSecretKey(), pubkey = getPublicKey(key)
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
  return { context, pubkey, relay: relay.href }
}

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
