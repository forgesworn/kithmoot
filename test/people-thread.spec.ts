import { test, expect, type Page } from '@playwright/test'
import { type Event } from 'nostr-tools/pure'
import { unwrapEvent } from 'nostr-tools/nip17'
import { accountDevice, configureAccountTestRelay, signInAccount } from './nostr-account.js'
import { readContactInvitation } from '../src/contact-invitation.js'
import { openSettings } from './browser.js'
import { peopleScenario, seedPeople } from './people-scenario.js'

/** Kind 1059 publications from this page, in order. */
function wraps(page: Page): Event[] {
  const events: Event[] = []
  page.on('websocket', socket => socket.on('framesent', frame => {
    try { const value = JSON.parse(String(frame.payload)); if (value[0] === 'EVENT' && value[1]?.kind === 1059) events.push(value[1]) } catch { /* Not a publication. */ }
  }))
  return events
}

/** Every REQ and EVENT frame this page sends, whichever relay carries it. */
function frames(page: Page): { reqs: unknown[][]; events: Event[] } {
  const seen = { reqs: [] as unknown[][], events: [] as Event[] }
  page.on('websocket', socket => socket.on('framesent', frame => {
    try {
      const value = JSON.parse(String(frame.payload))
      if (value[0] === 'REQ') seen.reqs.push(value)
      if (value[0] === 'EVENT') seen.events.push(value[1])
    } catch { /* Not JSON. */ }
  }))
  return seen
}

/** A click the page makes for itself, which no person pressed. */
const synthetic = (page: Page, selector: string) => page.evaluate(sel => {
  document.querySelector(sel)?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}, selector)

async function start(browser: Parameters<typeof accountDevice>[0], baseURL: string, options: { width?: number; height?: number; profiles?: boolean; nip44?: boolean } = {}) {
  const scenario = peopleScenario(baseURL)
  const context = await accountDevice(browser, baseURL, scenario.ada, options.nip44 !== false)
  await context.addInitScript(on => localStorage.setItem('kithmoot.profiles.enabled', String(on)), options.profiles !== false)
  await context.addInitScript(({ self, room }) => {
    localStorage.setItem(`kithmoot.account.${self}.kithmoot.room.${room.roomId}`, JSON.stringify(room))
  }, { self: scenario.pubkeys.ada, room: scenario.ellisRoom })
  await seedPeople(scenario, baseURL)
  const page = await context.newPage(), sent = wraps(page), seen = frames(page)
  await page.setViewportSize({ width: options.width ?? 1440, height: options.height ?? 900 })
  await configureAccountTestRelay(page, baseURL); await signInAccount(page, baseURL)
  await page.locator('#railPeople').click()
  await expect(page.locator('#peopleList')).toBeVisible()
  return { scenario, context, page, sent, seen }
}

const row = (page: Page, name: string | RegExp) => page.locator('#peopleRows li[data-person]').filter({ hasText: name })

test('People lists Messages, Contacts, Following and On Nostr in that order, each person once', async ({ browser, baseURL }) => {
  const { context, page, scenario } = await start(browser, baseURL!)
  try {
    await expect(row(page, 'Priya Natarajan')).toBeVisible()
    const headings = await page.locator('#peopleRows h3').allTextContents()
    expect(headings.slice(0, 3)).toEqual(['Messages', 'Contacts', 'Following'])
    // Unread first: Priya (3 from her) and Sam's request, then Bob.
    const firstTwo = (await page.locator('#peopleRows > li[data-person]').allInnerTexts()).slice(0, 2).join(' ')
    expect(firstTwo).toContain('Priya Natarajan')
    expect(firstTwo).toContain('npub1')
    for (const key of Object.values(scenario.pubkeys)) expect(await page.locator(`#peopleRows li[data-person="${key}"]`).count()).toBeLessThanOrEqual(1)
    await expect(page.locator('#peopleRows li[data-person="' + scenario.pubkeys.ellis + '"]')).toContainText('Private chat')
  } finally { await context.close() }
})

test('a People row names the person, unread count, time and preview', async ({ browser, baseURL }) => {
  const { context, page } = await start(browser, baseURL!)
  try {
    const priya = row(page, 'Priya Natarajan')
    await expect(priya).toContainText('Bring the notes if you can.')
    await expect(priya.getByRole('button')).toHaveAccessibleName(/^Priya Natarajan, 3 unread, .*Bring the notes if you can\.$/)
    await expect(row(page, 'Bob Okafor')).toContainText('You: Thanks for the files.')
  } finally { await context.close() }
})

test('there is no Public profiles switch in the People list', async ({ browser, baseURL }) => {
  const { context, page } = await start(browser, baseURL!)
  try {
    await expect(page.locator('#peoplePublicProfiles')).toHaveCount(0)
    await expect(page.locator('#peopleNostrOpen')).toHaveCount(0)
  } finally { await context.close() }
})

test('a thread opens inline with bubbles, and opening it marks the messages read', async ({ browser, baseURL }) => {
  const { context, page, scenario } = await start(browser, baseURL!)
  try {
    // Priya's three unread messages and Sam's one.
    await expect(page.locator('#railPeopleCount')).toHaveText('4')
    await row(page, 'Priya Natarajan').getByRole('button').first().click()
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    await expect(page.locator('#peopleNostrDialog')).toHaveCount(0)
    const log = page.getByRole('log', { name: 'Messages with Priya Natarajan' })
    await expect(log).toBeVisible()
    await expect(log.locator('.theirs')).toHaveCount(3)
    await expect(log.locator('.mine')).toHaveCount(1)
    await expect(log).toContainText('Today')
    await expect(log.locator('time').first()).toHaveText(/^\d{1,2}:\d{2}/)
    await expect(page.locator('#peoplePaneTitle')).toHaveText('Priya Natarajan')
    await expect(page.getByRole('button', { name: 'Mark as read' })).toHaveCount(0)
    await expect(page.locator('#railPeopleCount')).toHaveText('1')
    void scenario
  } finally { await context.close() }
})

test('Enter sends one encrypted message to the person and one copy to the account', async ({ browser, baseURL }) => {
  const { context, page, sent, scenario } = await start(browser, baseURL!)
  try {
    await row(page, 'Priya Natarajan').getByRole('button').first().click()
    const input = page.getByRole('textbox', { name: 'Message Priya Natarajan on Nostr' })
    await input.fill('On my way.'); await input.press('Enter')
    await expect(page.getByRole('log').locator('.mine', { hasText: 'On my way.' })).toHaveCount(1)
    await expect(page.locator('#peopleThread')).toContainText('Sent to their inbox relay')
    await expect(input).toBeFocused()
    await expect.poll(() => sent.length).toBe(2)
    const toPriya = sent.find(event => event.tags[0]?.[1] === scenario.pubkeys.priya)!
    expect(unwrapEvent(toPriya, scenario.priya)).toMatchObject({ kind: 14, content: 'On my way.' })
    expect(sent.some(event => event.tags[0]?.[1] === scenario.pubkeys.ada)).toBe(true)
    await expect(page.getByRole('log').locator('.mine', { hasText: 'On my way.' })).toHaveCount(1)
  } finally { await context.close() }
})

test('request sender is not looked up until you reply', async ({ browser, baseURL }) => {
  const { context, page, scenario, seen } = await start(browser, baseURL!)
  try {
    const sam = page.locator(`#peopleRows li[data-person="${scenario.pubkeys.sam}"]`)
    await expect(sam).toContainText('Message request')
    await expect(sam).toBeVisible()
    await expect(sam).not.toContainText('Sam Rivers')
    const asksAbout = (key: string) => seen.reqs.filter(req => req.slice(2).some(filter => (filter as { kinds?: number[]; authors?: string[] }).kinds?.includes(0)
      && (filter as { authors?: string[] }).authors?.includes(key)))
    expect(asksAbout(scenario.pubkeys.sam)).toHaveLength(0)
    await sam.getByRole('button').first().click()
    await expect(page.locator('#peopleThread')).toBeVisible()
    await expect(page.locator('#peopleThread')).not.toContainText('Sam Rivers')
    expect(asksAbout(scenario.pubkeys.sam)).toHaveLength(0)
    await expect(page.locator('#peopleThread img, .peopleHeaderName img, #peoplePaneTitle img')).toHaveCount(0)
  } finally { await context.close() }
})

test('request bar blocks without publishing', async ({ browser, baseURL }) => {
  const { context, page, scenario, seen } = await start(browser, baseURL!)
  try {
    await page.locator(`#peopleRows li[data-person="${scenario.pubkeys.sam}"] button`).first().click()
    await expect(page.locator('.peopleRequestBar')).toContainText('Replying lets them know')
    await page.locator('.peopleRequestBar').getByRole('button', { name: 'Block' }).click()
    await expect(page.locator(`#peopleRows li[data-person="${scenario.pubkeys.sam}"]`)).toHaveCount(0)
    await expect(page.locator('#peopleStatus')).toContainText('is blocked on this device. Settings › Privacy lists who you have blocked.')
    expect(seen.events).toEqual([])
  } finally { await context.close() }
})

test('public profiles control only while off', async ({ browser, baseURL }) => {
  const on = await start(browser, baseURL!)
  try {
    await expect(on.page.locator('#peopleList [role="switch"]')).toHaveCount(0)
    await expect(on.page.locator('.peopleTurnOn:visible')).toHaveCount(0)
  } finally { await on.context.close() }
  const off = await start(browser, baseURL!, { profiles: false })
  try {
    await expect(off.page.locator('#peopleList [role="switch"]')).toHaveCount(0)
    await expect(off.page.locator('#peopleRows')).toContainText('Turn on public profiles to see who you follow.')
    await off.page.getByRole('button', { name: 'Turn on public profiles' }).click()
    await expect(off.page.locator('.peopleTurnOn:visible')).toHaveCount(0)
    await expect(row(off.page, 'Chen Wei')).toBeVisible()
  } finally { await off.context.close() }
})

test('no lookups with profiles off', async ({ browser, baseURL }) => {
  const { context, page, scenario, seen } = await start(browser, baseURL!, { profiles: false })
  try {
    await page.locator(`#peopleRows li[data-person="${scenario.pubkeys.priya}"] button`).first().click()
    const input = page.locator('#peopleThreadInput')
    await expect(input).toBeVisible()
    await input.fill('Hello'); await input.press('Enter')
    await expect(page.locator('#peopleThread')).toContainText('Sent to their inbox relay')
    await page.locator('.peopleHeaderName').click()
    await expect(page.locator('.peopleInfo')).toBeVisible()
    const lookups = seen.reqs.filter(req => req.slice(2).some(filter => {
      const f = filter as { kinds?: number[]; search?: string; authors?: string[] }
      // The account's own name for its menu is not a lookup of anyone else.
      const others = f.authors?.some(author => author !== scenario.pubkeys.ada) ?? true
      return (f.kinds?.includes(0) || f.kinds?.includes(3)) && others || f.search !== undefined
    }))
    expect(lookups).toEqual([])
  } finally { await context.close() }
})

test('publishes only gift wraps', async ({ browser, baseURL }) => {
  const { context, page, seen } = await start(browser, baseURL!)
  try {
    await row(page, 'Priya Natarajan').getByRole('button').first().click()
    const input = page.getByRole('textbox', { name: 'Message Priya Natarajan on Nostr' })
    await input.fill('Nothing else goes out.'); await input.press('Enter')
    await expect(page.locator('#peopleThread')).toContainText('Sent to their inbox relay')
    await page.locator('.peopleHeaderName').click()
    await row(page, 'Chen Wei').getByRole('button').first().click()
    expect(seen.events.length).toBeGreaterThan(0)
    expect(new Set(seen.events.map(event => event.kind))).toEqual(new Set([1059]))
  } finally { await context.close() }
})

test('untrusted clicks do nothing', async ({ browser, baseURL }) => {
  const { context, page, scenario, sent } = await start(browser, baseURL!)
  try {
    await row(page, 'Priya Natarajan').getByRole('button').first().click()
    const input = page.getByRole('textbox', { name: 'Message Priya Natarajan on Nostr' })
    await input.fill('A page cannot press Send.')
    await synthetic(page, '#peopleThreadSend')
    await page.locator('#peopleInvite').click()
    for (const name of [/^A private chat/, /^A room/]) {
      await page.evaluate(label => {
        for (const item of document.querySelectorAll('#peopleInviteMenu [role="menuitem"]')) if (new RegExp(label).test(item.textContent ?? '')) item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      }, name.source)
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    expect(sent).toEqual([])
    await expect(page.locator('#roomArea')).toBeHidden()
    // Sam's Block, from a page rather than a person.
    await page.locator('#peopleRows li[data-person="' + scenario.pubkeys.sam + '"] button').first().click()
    await synthetic(page, '.peopleRequestBar button')
    await page.waitForTimeout(300)
    await expect(page.locator(`#peopleRows li[data-person="${scenario.pubkeys.sam}"]`)).toHaveCount(1)
  } finally { await context.close() }
})

test('composer unavailable states', async ({ browser, baseURL }) => {
  const off = await start(browser, baseURL!)
  try {
    await openSettings(off.page, 'Account')
    await off.page.locator('#nostrInboxSwitch').uncheck()
    await off.page.locator('#railPeople').click()
    await expect(off.page.locator('#peopleInboxLine')).toContainText('Your Nostr inbox is off on this device.')
    await row(off.page, 'Priya Natarajan').getByRole('button').first().click()
    await expect(off.page.locator('.peopleThreadBar')).toContainText('Your Nostr inbox is off on this device.')
    await expect(off.page.locator('#peopleThreadSend')).toBeHidden()
    await off.page.locator('.peopleThreadBar').getByRole('button', { name: 'Turn on inbox' }).click()
    await expect(off.page.getByRole('textbox', { name: 'Message Priya Natarajan on Nostr' })).toBeVisible()
  } finally { await off.context.close() }
  const noEncryption = await start(browser, baseURL!, { nip44: false })
  try {
    await row(noEncryption.page, 'Priya Natarajan').getByRole('button').first().click()
    await expect(noEncryption.page.locator('.peopleThreadBar')).toContainText('can’t encrypt')
    await expect(noEncryption.page.locator('#peopleThreadSend')).toBeHidden()
  } finally { await noEncryption.context.close() }
})

test('invite menu routes to the right chat', async ({ browser, baseURL }) => {
  const { context, page, scenario } = await start(browser, baseURL!)
  try {
    // Ellis already has a chat: the item says so and opens it.
    await row(page, 'Ellis Moore').getByRole('button').first().click()
    await page.locator('#peopleInvite').click()
    const existing = page.getByRole('menuitem', { name: /^A private chat/ })
    await expect(existing).toContainText('You already have one. Open it.')
    await existing.click()
    await expect(page.locator('#roomTitle')).toHaveText('Ellis Moore')
    await expect(page.locator('#roomList').getByRole('button', { name: 'Open Ellis Moore', exact: true })).toHaveCount(1)
    // Sam is a stranger and no node is paired: no calls, both items disabled with reasons.
    await page.locator('#railPeople').click()
    await page.locator(`#peopleRows li[data-person="${scenario.pubkeys.sam}"] button`).first().click()
    await expect(page.getByRole('button', { name: 'Voice call' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Video call' })).toHaveCount(0)
    await page.locator('#peopleInvite').click()
    for (const name of [/^A private chat/, /^A room/]) await expect(page.getByRole('menuitem', { name })).toBeDisabled()
    await expect(page.getByRole('menuitem', { name: /^A private chat/ })).toContainText('Pair your KithMoot node in Settings › Calls')
    await page.keyboard.press('Escape')
  } finally { await context.close() }
})

test('invitation goes with a note', async ({ browser, baseURL }) => {
  const { context, page, scenario, sent } = await start(browser, baseURL!)
  try {
    await row(page, 'Priya Natarajan').getByRole('button').first().click()
    await page.locator('#peopleInvite').click()
    await page.getByRole('menuitem', { name: /^A private chat/ }).click()
    await expect(page.locator('#roomArea')).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => sent.filter(event => event.tags[0]?.[1] === scenario.pubkeys.priya).length, { timeout: 30_000 }).toBe(2)
    const toPriya = sent.filter(event => event.tags[0]?.[1] === scenario.pubkeys.priya).map(event => unwrapEvent(event, scenario.priya))
    expect(toPriya[0]).toMatchObject({ kind: 14, content: 'I’ve invited you to a private chat on KithMoot.'.replace('’', "'") })
    expect(toPriya[0]!.tags.some(tag => tag[0] !== 'p')).toBe(false)
    expect(readContactInvitation(toPriya[0], scenario.pubkeys.priya, Math.floor(Date.now() / 1000))).toBeUndefined()
    expect(readContactInvitation(toPriya[1], scenario.pubkeys.priya, Math.floor(Date.now() / 1000))).toMatchObject({ sender: scenario.pubkeys.ada })
    await page.locator('#railPeople').click()
    await row(page, 'Priya Natarajan').getByRole('button').first().click()
    await expect(page.getByRole('log').locator('.mine', { hasText: "I've invited you to a private chat on KithMoot." })).toHaveCount(1)
  } finally { await context.close() }
  // Ellis already has a chat, so opening it sends nothing.
  const second = await start(browser, baseURL!)
  try {
    await row(second.page, 'Ellis Moore').getByRole('button').first().click()
    await second.page.locator('#peopleInvite').click()
    await second.page.getByRole('menuitem', { name: /^A private chat/ }).click()
    await expect(second.page.locator('#roomTitle')).toHaveText('Ellis Moore')
    await second.page.waitForTimeout(1500)
    expect(second.sent).toEqual([])
  } finally { await second.context.close() }
})

test('sending works with a room open', async ({ browser, baseURL }) => {
  const { context, page, scenario, sent } = await start(browser, baseURL!)
  try {
    await row(page, 'Ellis Moore').getByRole('button').first().click()
    await page.locator('#peopleInvite').click()
    await page.getByRole('menuitem', { name: /^A private chat/ }).click()
    await expect(page.locator('#roomTitle')).toHaveText('Ellis Moore')
    await expect(page.locator('#roomArea')).toHaveJSProperty('inert', false, { timeout: 30_000 })
    await page.locator('#railPeople').click()
    await row(page, 'Priya Natarajan').getByRole('button').first().click()
    const input = page.getByRole('textbox', { name: 'Message Priya Natarajan on Nostr' })
    await expect(input).toBeVisible()
    await input.fill('Still here.'); await input.press('Enter')
    await expect(page.locator('#peopleThread')).toContainText('Sent to their inbox relay')
    expect(sent.filter(event => event.tags[0]?.[1] === scenario.pubkeys.priya)).toHaveLength(1)
    expect(sent.filter(event => event.tags[0]?.[1] === scenario.pubkeys.ada)).toHaveLength(1)
    await page.reload()
    await page.locator('#railPeople').click()
    await row(page, 'Priya Natarajan').getByRole('button').first().click()
    await expect(page.getByRole('textbox', { name: 'Message Priya Natarajan on Nostr' })).toBeVisible()
  } finally { await context.close() }
})

test('settings account nostr group', async ({ browser, baseURL }) => {
  const { context, page } = await start(browser, baseURL!)
  try {
    await openSettings(page, 'Account')
    await expect(page.getByRole('button', { name: 'New Nostr message' })).toHaveCount(0)
    await expect(page.locator('#nostrMessageDialog, #nostrMessageEntry')).toHaveCount(0)
    await expect(page.locator('#nostrInboxSwitch')).toBeChecked()
    await expect(page.locator('#nostrInboxRelaysOpen')).toBeVisible()
    await page.locator('#nostrOpenPeople').click()
    await expect(page.locator('#peopleList')).toBeVisible()
  } finally { await context.close() }
})

test('inbox switch lives in settings', async ({ browser, baseURL }) => {
  const { context, page } = await start(browser, baseURL!)
  try {
    for (const name of ['Turn off inbox', 'Refresh', 'Inbox relays']) await expect(page.locator('#peopleList').getByRole('button', { name, exact: true })).toHaveCount(0)
    await openSettings(page, 'Account')
    await page.locator('#nostrInboxSwitch').uncheck()
    await page.locator('#railPeople').click()
    await expect(page.locator('#peopleInboxLine')).toContainText('Your Nostr inbox is off on this device.')
    await page.locator('#peopleInboxLine').getByRole('button', { name: 'Turn on' }).click()
    await expect(page.locator('#peopleInboxLine')).not.toContainText('Your Nostr inbox is off')
  } finally { await context.close() }
})

test('incoming message announced', async ({ browser, baseURL }) => {
  const { context, page, scenario } = await start(browser, baseURL!)
  try {
    await row(page, 'Priya Natarajan').getByRole('button').first().click()
    await expect(page.getByRole('log')).toBeVisible()
    await page.locator('#peopleThreadInput').focus()
    const { say } = await import('./people-scenario.js')
    await say(scenario, scenario.priya, scenario.pubkeys.ada, 'See you at four.')
    await expect(page.locator('#peopleThreadAnnounce')).toHaveText('Priya Natarajan: See you at four.', { timeout: 30_000 })
    await expect(page.getByRole('log')).toContainText('See you at four.')
    await expect(page.locator('#peopleThreadInput')).toBeFocused()
  } finally { await context.close() }
})
