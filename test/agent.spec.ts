import { test, expect } from '@playwright/test'
import { withRelays } from './relays.js'
import { SYNTHETIC_MIC, createRoom, goToConversation, joinWithMedia, newDeviceContext, startRelay } from './browser.js'
import { RoomAgent } from '../src/agent.js'
import { AgentRuntime } from '../src/node/runtime.js'
import type { RuntimeEvent } from '../src/node/runtime.js'
import { FixedTranscriber } from '../src/node/transcriber.js'
import { createWeriftFactory } from '../src/node/webrtc.js'

/**
 * An agent in the room, without a browser.
 *
 * The claim: a Node process that reads the same link a person was sent is
 * a member of the room on the same terms - in the roster, in the chat, on
 * the agents' channel, and, when a person allows it, on the end of their
 * microphone. Nothing here drives a browser on the agent's behalf; the
 * browser in this test is the PERSON, and the agent is this test process
 * holding a `RoomAgent` over a real relay socket and a real WebRTC stack.
 *
 * The listening half is the part worth a real browser: Chromium's fake
 * microphone is a tone, which the agent's Opus decoder and utterance
 * splitter turn into utterances, and a fixed transcriber turns into lines
 * in the transcript channel - only once the person has said agents may
 * hear them, and never before.
 */

const RELAY_PORT = 7781

test('an agent joins from the link, chats, whispers, and hears only what it is allowed to', async ({ browser, baseURL }) => {
  test.skip(!baseURL, 'no baseURL resolved from playwright.config.ts')
  test.setTimeout(240_000)

  const relay = await startRelay(RELAY_PORT)
  const context = await newDeviceContext(browser, baseURL!)
  // Her microphone is a tone, whatever the fake device is doing today.
  await context.addInitScript(SYNTHETIC_MIC)
  let agent: RoomAgent | undefined
  let runtime: AgentRuntime | undefined
  try {
    const page = await context.newPage()
    const url = withRelays(await createRoom(page, baseURL!), [relay.url])
    await joinWithMedia(page, url, 'Alice')

    // The agent reads the link, is admitted by Alice's tab, and joins with
    // a WebRTC stack so media can reach it.
    const factory = await createWeriftFactory()
    agent = await RoomAgent.join({ link: url, name: 'Ada', factory })
    runtime = new AgentRuntime(agent, { persona: { name: 'Ada', system: '' } }).start()
    const events: RuntimeEvent[] = []
    runtime.on((e) => events.push(e))

    // Alice sees the agent: a name in the agents row, marked as one, and
    // no empty tile in the grid for something with nothing on screen.
    await expect(page.locator('#agentsRow .agentChip', { hasText: 'Ada' })).toHaveCount(1, { timeout: 60_000 })
    await expect(page.locator('#agentsRow .agentChip .badge.agent')).toHaveCount(1)
    await expect(page.locator('#room .participant')).toHaveCount(1)

    // Chat both ways.
    await runtime.say('hello from the agent')
    await expect(page.locator('#chatLog')).toContainText('hello from the agent', { timeout: 30_000 })
    await page.locator('#chatInput').fill('hello Ada')
    await page.locator('#chatInput').press('Enter')
    await expect
      .poll(() => events.some((e) => e.type === 'chat' && e.message.text === 'hello Ada'), { timeout: 30_000 })
      .toBe(true)

    // The agents' conversation, readable by Alice. It is a tab in the
    // channel bar rather than a panel of its own: the panels were removed
    // when the reserved conversations turned out to be rendered twice, once
    // as tabs and once stacked below with a second composer, which is what
    // somebody looking for one agents conversation met two of.
    await runtime.whisper('note to the other agents')
    await goToConversation(page, 'Agents')
    await expect(page.locator('#chatLog')).toContainText('note to the other agents', { timeout: 30_000 })

    // Listening. Alice has not said agents may hear her, so nothing reaches
    // the agent: no track, no utterance, no transcript.
    const transcriber = new FixedTranscriber('(speech)')
    runtime.listen(transcriber)
    await page.waitForTimeout(8_000)
    expect(transcriber.heard, 'the agent heard something before it was allowed to').toHaveLength(0)
    await goToConversation(page, 'Transcript')
    await expect(page.locator('#chatLog')).not.toContainText('(speech)')

    // She turns it on: her microphone's tone reaches the agent, is cut into
    // utterances, and comes back as transcript lines she can read.
    await page.locator('#toggleAgentsHear').click()
    await expect(page.locator('#toggleAgentsHear')).toHaveAttribute('data-on', 'true')
    await expect
      .poll(() => transcriber.heard.length, { message: 'the agent never heard an utterance', timeout: 90_000 })
      .toBeGreaterThan(0)
    await expect(page.locator('#chatLog')).toContainText('(speech)', { timeout: 60_000 })
    await expect(page.locator('#chatLog')).toContainText('said')

    // And off again: the tracks are removed, and the utterances stop.
    await page.locator('#toggleAgentsHear').click()
    await page.waitForTimeout(3_000)
    const heardAtOff = transcriber.heard.length
    await page.waitForTimeout(8_000)
    expect(transcriber.heard.length, 'the agent kept hearing after it was switched off').toBeLessThanOrEqual(heardAtOff + 1)
  } finally {
    await runtime?.close()
    await context.close()
    await relay.stop()
  }
})
