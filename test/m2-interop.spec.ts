import { test, expect } from '@playwright/test'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { base64urlnopad } from '@scure/base'
import { createRoom, newDeviceContext, joinWithMedia, expectToSeeAndHear, open } from './browser.js'

const previousUrl = process.env.M2_BASELINE_URL!
const previous = (path: string) => import(/* @vite-ignore */ pathToFileURL(join(process.env.M2_BASELINE_DIR!, path)).href)

for (const version of [2, 3]) test(`M2 and the previous release exchange media and chat in a v${version} room`, async ({ browser, baseURL }) => {
  const oldContext = await newDeviceContext(browser, previousUrl)
  const newContext = await newDeviceContext(browser, baseURL!)
  try {
    const oldPage = await oldContext.newPage(), newPage = await newContext.newPage()
    const creator = version === 2 ? oldPage : newPage
    const base = version === 2 ? previousUrl : baseURL!
    if (version === 2) {
      await creator.goto(base)
      await creator.locator('#roomType').selectOption('temporary')
      await creator.locator('#create').click()
      await expect.poll(() => creator.locator('#shareUrl').inputValue()).not.toBe('')
    } else await createRoom(creator, base)
    const link = await creator.locator('#shareUrl').inputValue()
    expect(JSON.parse(new TextDecoder().decode(base64urlnopad.decode(new URL(link).hash.slice(1)))).v).toBe(version)
    const at = (target: string) => new URL('#' + new URL(link).hash.slice(1), target).href
    await joinWithMedia(creator, link, version === 2 ? 'Previous release' : 'M2')
    await joinWithMedia(version === 2 ? newPage : oldPage, at(version === 2 ? baseURL! : previousUrl), version === 2 ? 'M2' : 'Previous release')
    await expectToSeeAndHear(oldPage, 'Previous release')
    await expectToSeeAndHear(newPage, 'M2')
    for (const [sender, receiver, text] of [[oldPage, newPage, 'From the previous release'], [newPage, oldPage, 'From M2']] as const) {
      await sender.locator('#chatInput').fill(text)
      await sender.locator('#chatInput').press('Enter')
      await expect(receiver.locator('#chatLog')).toContainText(text)
    }
  } finally { await oldContext.close(); await newContext.close() }
})

test('an unchanged previous-release keeper admits an M2 browser and exchanges encrypted chat', async ({ browser, baseURL }) => {
  const { RoomAgent } = await previous('dist/src/agent.js')
  const keeper = await RoomAgent.create({ base: baseURL, name: 'Previous keeper', relays: ['ws://127.0.0.1:7777'], announceJitterMs: 0 })
  const context = await newDeviceContext(browser, baseURL!)
  try {
    const page = await context.newPage()
    await open(page, keeper.url, 'M2 member')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await keeper.chat.send('The old keeper still works')
    await expect(page.locator('#chatLog')).toContainText('The old keeper still works')
    await page.locator('#chatInput').fill('M2 reply to old keeper')
    await page.locator('#chatInput').press('Enter')
    await expect.poll(() => keeper.chat.messages().some((m: { text: string }) => m.text === 'M2 reply to old keeper')).toBe(true)
  } finally { await context.close(); await keeper.leave() }
})
