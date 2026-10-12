import { _electron as electron, test, expect } from '@playwright/test'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {generateSecretKey, getPublicKey, finalizeEvent} from 'nostr-tools/pure'
import {encrypt, decrypt, getConversationKey} from 'nostr-tools/nip44'
import {HOME} from '../policy.mjs'
const desktop = fileURLToPath(new URL('../', import.meta.url))

test('the Electron sandbox hosts durable Boards and keeps labelled popouts through reload', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'kithmoot-desktop-boards-'))
  const app = await electron.launch({executablePath: process.env.DESKTOP_EXECUTABLE ?? process.env.ELECTRON_EXECUTABLE ?? join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: process.env.DESKTOP_EXECUTABLE ? [`--user-data-dir=${profile}`] : [desktop], env: {...process.env, KITHMOOT_DESKTOP_TEST_PROFILE: profile}})
  try {
    const context = app.context(), key = generateSecretKey(), pubkey = getPublicKey(key)
    await context.exposeFunction('boardKey', () => pubkey)
    await context.exposeFunction('boardSign', (event: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(event, key))
    await context.exposeFunction('boardEncrypt', (peer: string, text: string) => encrypt(text, getConversationKey(key, peer)))
    await context.exposeFunction('boardDecrypt', (peer: string, text: string) => decrypt(text, getConversationKey(key, peer)))
    await context.routeWebSocket(/.*/, ws => ws.close())
    await context.route(/^https:\/\/(relay\.damus\.io|nos\.lol|relay\.primal\.net|nostr\.oxtr\.dev)\/?$/, route => route.fulfill({status: 200, contentType: 'application/nostr+json', body: JSON.stringify({limitation: {max_message_length: 131072}})}))
    await context.addInitScript(() => {
      const host = window as typeof window & {boardKey(): Promise<string>; boardSign(event: unknown): Promise<unknown>; boardEncrypt(peer: string, text: string): Promise<string>; boardDecrypt(peer: string, text: string): Promise<string>}
      Object.defineProperty(window, 'nostr', {configurable: true, value: {getPublicKey: () => host.boardKey(), signEvent: (event: unknown) => host.boardSign(event), nip44: {encrypt: (peer: string, text: string) => host.boardEncrypt(peer, text), decrypt: (peer: string, text: string) => host.boardDecrypt(peer, text)}}})
    })
    const page = await app.firstWindow(), errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(HOME + '?signin=nostr')
    await page.getByRole('button', {name: /Browser extension/}).click()
    await expect(page.locator('#homeWork')).toBeVisible()
    await page.locator('#homeWork').click()
    const frame = page.frameLocator('#boardsPanel iframe')
    await frame.getByRole('button', {name: 'Not yet, remind me', exact: true}).click()
    await frame.getByRole('link', {name: /^Create (a )?board$/}).click()
    await frame.getByRole('textbox', {name: 'Board name', exact: true}).fill('Native board')
    await frame.getByRole('button', {name: 'Create board', exact: true}).click()
    await expect(frame.getByRole('heading', {name: 'Native board', exact: true})).toBeVisible()
    const composer = frame.getByRole('textbox', {name: 'Add a card to To do', exact: true})
    await composer.fill('Stored in the desktop profile'); await composer.press('Enter')
    await expect(frame.getByRole('link', {name: 'Stored in the desktop profile', exact: true})).toBeVisible()
    const child = page.waitForEvent('popup'); await page.locator('#boardsPopOut').click(); const popup = await child
    await expect(popup).toHaveTitle('KithMoot · Native board')
    await expect(popup.frameLocator('iframe').getByRole('link', {name: 'Stored in the desktop profile', exact: true})).toBeVisible()
    await popup.reload()
    await expect(popup.frameLocator('iframe').getByRole('link', {name: 'Stored in the desktop profile', exact: true})).toBeVisible()
    const boardState = await popup.frameLocator('iframe').locator('#app').evaluate(async () => ({secure: isSecureContext, node: typeof (window as typeof window & {require?: unknown}).require, workers: (await navigator.serviceWorker.getRegistrations()).length}))
    expect(boardState).toEqual({secure: true, node: 'undefined', workers: 0})
    await popup.getByRole('button', {name: 'Return to workspace', exact: true}).click()
    await expect(frame.getByRole('link', {name: 'Stored in the desktop profile', exact: true})).toBeVisible()
    expect(errors).toEqual([])
  } finally {await app.close(); await rm(profile, {recursive: true, force: true})}
})
