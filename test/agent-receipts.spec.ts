import { test, expect } from '@playwright/test'
import { RoomAgent } from '../src/agent.js'
import { AgentRuntime } from '../src/node/runtime.js'
import { goToConversation, open, startRelay } from './browser.js'

test('an agent acknowledges a mention in a named conversation with a visible received time', async ({ browser, baseURL }) => {
  test.setTimeout(45000)
  const relay = await startRelay(7794)
  const tally = await RoomAgent.create({ base: baseURL!, name: 'Tally', relays: [relay.url] })
  const runtime = new AgentRuntime(tally, { persona: { name: 'Tally', system: '' } }).start()
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' })
  const failures: string[] = []
  const off = runtime.on(event => {
    if (event.type !== 'channel' || !event.addressed || event.message.participant === tally.participant) return
    // The receipt path works without starting a model or finishing another job.
    void runtime.acknowledge(event.channel, event.message.id).catch(err => failures.push(String(err)))
  })
  try {
    await tally.setChannel('security', true)
    const page = await context.newPage()
    await open(page, tally.url, 'Ada')
    await page.locator('#join').click()
    await goToConversation(page, 'security')
    await page.locator('#chatInput').fill('@Tally can you look at this?')
    await page.locator('#chatForm button[type=submit]').click()
    const receipt = page.locator('#chatLog .msg').filter({ hasText: 'can you look at this?' }).getByRole('button', { name: 'Add 👍 reaction, 1', exact: true })
    await expect(receipt).toBeVisible()
    await expect(receipt).toHaveAttribute('title', /Tally.*received.*reply may still be pending/)
    await receipt.hover()
    expect(failures).toEqual([])
    await goToConversation(page, 'Chat')
    await expect(page.locator('#chatLog .msg')).toHaveCount(0)
  } finally { off(); await context.close(); await runtime.close(); await relay.stop() }
})
