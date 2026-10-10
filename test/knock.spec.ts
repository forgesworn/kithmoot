import { test, expect, type Browser, type Page } from '@playwright/test'
import { newDeviceContext, openNewRoomForm } from './browser.js'
import { testRelaysFor } from './relays.js'

async function askedRoom(browser: Browser, baseURL: string) {
  const hostContext = await newDeviceContext(browser, baseURL, { viewport: { width: 390, height: 844 } })
  const guestContext = await newDeviceContext(browser, baseURL)
  const relay = testRelaysFor(baseURL)?.[0]
  if (!relay) throw new Error('Grant fault checks require a local relay')
  await hostContext.addInitScript(url => localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: [{ url, read: true, write: true }] })), relay)
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()
  return { hostContext, guestContext, host, guest, relay }
}

async function startAskedRoom(host: Page, guest: Page, baseURL: string) {
  await host.goto(baseURL)
  await openNewRoomForm(host)
  await host.locator('#roomName').fill('Admission delivery')
  await host.locator('#roomAsk').check()
  await host.locator('#create').click()
  await expect.poll(() => host.locator('#shareUrl').inputValue()).not.toBe('')
  const link = await host.locator('#shareUrl').inputValue()
  await host.locator('#displayName').fill('Ada')
  await host.locator('#join').click()
  await expect(host.locator('#roomArea')).toBeVisible()
  await guest.addInitScript(() => localStorage.setItem('kithmoot.name', 'Rowan'))
  await guest.goto(link)
  const card = host.locator('#approvals .approvalCard.knock')
  await expect(card).toContainText('Rowan wants to join')
  return card
}

test('grant feedback waits for publication, then the guest can join', async ({ browser, baseURL }, testInfo) => {
  const { hostContext, guestContext, host, guest, relay } = await askedRoom(browser, baseURL!)
  const releases: Array<() => void> = []
  await hostContext.routeWebSocket(relay, ws => {
    const upstream = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && frame[1].kind === 20467) { releases.push(() => upstream.send(raw)); return }
      upstream.send(raw)
    })
    upstream.onMessage(raw => ws.send(raw))
  })
  try {
    if (testInfo.project.name === 'chromium-desktop') await host.setViewportSize({ width: 1200, height: 800 })
    const card = await startAskedRoom(host, guest, baseURL!)
    await card.getByRole('button', { name: 'Let in', exact: true }).click()
    await expect.poll(() => releases.length).toBe(1)
    await expect(host.locator('#chatLog')).not.toContainText('You let Rowan in.')
    await expect(card).toContainText('Sending invitation')
    await expect(host.locator('#status')).toContainText('Sending the invitation to Rowan')
    await expect(card.getByRole('button', { name: 'Let in', exact: true })).toBeDisabled()
    await expect(guest.locator('#join')).toBeHidden()
    await expect(guest.locator('#roomArea')).toBeHidden()
    await host.screenshot({ path: testInfo.outputPath('admission-sending.png') })
    releases[0]()
    await expect(host.locator('#chatLog')).toContainText('Invitation sent to Rowan.')
    await expect(card).toHaveCount(0)
    await expect(guest.locator('#status')).toContainText('You are on the list')
    await guest.locator('#join').click()
    await expect(guest.locator('#roomArea')).toBeVisible()
  } finally { await hostContext.close(); await guestContext.close() }
})

test('refusal feedback waits for relay acceptance and does not admit the guest', async ({ browser, baseURL }) => {
  const { hostContext, guestContext, host, guest, relay } = await askedRoom(browser, baseURL!)
  const releases: Array<() => void> = []
  await hostContext.routeWebSocket(relay, ws => {
    const upstream = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && frame[1].kind === 20467) { releases.push(() => upstream.send(raw)); return }
      upstream.send(raw)
    })
    upstream.onMessage(raw => ws.send(raw))
  })
  try {
    const card = await startAskedRoom(host, guest, baseURL!)
    await card.getByRole('button', { name: 'Decline', exact: true }).click()
    await expect.poll(() => releases.length).toBe(1)
    await expect(card.getByRole('status')).toContainText('Sending refusal')
    await expect(card.getByRole('button', { name: 'Decline', exact: true })).toBeDisabled()
    await expect(card.getByRole('button', { name: 'Let in', exact: true })).toBeDisabled()
    await expect(host.locator('#chatLog')).not.toContainText('You declined Rowan.')
    await expect(guest.locator('#arrivalTitle')).toHaveText('Waiting to be admitted')
    releases[0]()
    await expect(guest.locator('#arrivalTitle')).toHaveText('Your request was declined')
    await expect(guest.locator('#roomArea')).toBeHidden()
    await expect(guest.locator('#join')).toBeHidden()
    await expect(card).toHaveCount(0)
    expect(releases).toHaveLength(1)
  } finally { await hostContext.close(); await guestContext.close() }
})

test('a rejected refusal stays visible and its retry preserves the signed response', async ({ browser, baseURL }) => {
  const { hostContext, guestContext, host, guest, relay } = await askedRoom(browser, baseURL!)
  const responses: string[] = []
  await hostContext.routeWebSocket(relay, ws => {
    const upstream = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && frame[1].kind === 20467) {
        responses.push(String(raw))
        if (responses.length === 1) { ws.send(JSON.stringify(['OK', frame[1].id, false, 'Synthetic refusal rejection'])); return }
      }
      upstream.send(raw)
    })
    upstream.onMessage(raw => ws.send(raw))
  })
  try {
    const card = await startAskedRoom(host, guest, baseURL!)
    await host.locator('#chatInput').fill('Keep this unfinished note')
    await card.getByRole('button', { name: 'Decline', exact: true }).click()
    await expect(card.getByRole('status')).toContainText('Refusal was not confirmed')
    await expect(host.locator('#chatLog')).not.toContainText('You declined Rowan.')
    await expect(guest.locator('#arrivalTitle')).toHaveText('Waiting to be admitted')
    await card.getByRole('button', { name: 'Retry decline', exact: true }).click()
    await expect(guest.locator('#arrivalTitle')).toHaveText('Your request was declined')
    await expect(guest.locator('#arrivalLead')).toContainText('Ask them before trying again')
    await expect(guest.locator('#join')).toBeHidden()
    await expect(guest.locator('#roomArea')).toBeHidden()
    await expect(host.locator('#chatInput')).toHaveValue('Keep this unfinished note')
    await expect(card).toHaveCount(0)
    expect(responses).toHaveLength(2); expect(responses[0]).toBe(responses[1])
    await guest.locator('#retryArrival').click()
    await expect(card).toContainText('Rowan wants to join')
    await card.getByRole('button', { name: 'Let in', exact: true }).click()
    await expect(guest.locator('#status')).toContainText('You are on the list')
    await expect(guest.locator('#displayName')).toHaveValue('Rowan')
  } finally { await hostContext.close(); await guestContext.close() }
})

test('a rejected grant stays failed and a fresh guest request can succeed', async ({ browser, baseURL }, testInfo) => {
  const { hostContext, guestContext, host, guest, relay } = await askedRoom(browser, baseURL!)
  let grants = 0
  await hostContext.routeWebSocket(relay, ws => {
    const upstream = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && frame[1].kind === 20467 && ++grants === 1) {
        ws.send(JSON.stringify(['OK', frame[1].id, false, 'Synthetic grant rejection']))
        return
      }
      upstream.send(raw)
    })
    upstream.onMessage(raw => ws.send(raw))
  })
  try {
    // Advance only the guest's timers after observing failure; keeping its
    // wall clock fixed lets a deliberate retry use a fresh, valid request.
    await guest.clock.install()
    await guest.clock.setFixedTime(new Date())
    const card = await startAskedRoom(host, guest, baseURL!)
    await card.getByRole('button', { name: 'Let in', exact: true }).click()
    await expect(card.getByRole('status')).toContainText('Invitation could not be sent')
    await expect(host.locator('#chatLog')).not.toContainText('Invitation sent to Rowan.')
    await expect(guest.locator('#join')).toBeHidden()
    await expect(guest.locator('#roomArea')).toBeHidden()
    await host.screenshot({ path: testInfo.outputPath('admission-failed.png') })
    await card.getByRole('button', { name: 'Dismiss', exact: true }).click()
    await expect(card).toHaveCount(0)
    await guest.clock.runFor(120_001)
    await expect(guest.locator('#retryArrival')).toBeVisible()
    await guest.locator('#retryArrival').click()
    await expect(card).toContainText('Rowan wants to join')
    await card.getByRole('button', { name: 'Let in', exact: true }).click()
    await expect(host.locator('#chatLog')).toContainText('Invitation sent to Rowan.')
    await expect(guest.locator('#status')).toContainText('You are on the list')
    await expect(guest.locator('#displayName')).toHaveValue('Rowan')
    expect(grants).toBe(2)
  } finally { await hostContext.close(); await guestContext.close() }
})

test('leaving the room cancels its pending decision without granting entry', async ({ browser, baseURL }) => {
  const { hostContext, guestContext, host, guest, relay } = await askedRoom(browser, baseURL!)
  let grants = 0
  await hostContext.routeWebSocket(relay, ws => {
    const upstream = ws.connectToServer()
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EVENT' && frame[1].kind === 20467) grants++
      upstream.send(raw)
    })
    upstream.onMessage(raw => ws.send(raw))
  })
  try {
    const card = await startAskedRoom(host, guest, baseURL!)
    await host.locator('#backToRooms').click()
    await host.locator('#roomSwitcherHome').click()
    await openNewRoomForm(host)
    await host.locator('#roomName').fill('Another room')
    await host.locator('#create').click()
    await host.locator('#join').click()
    await expect(host.locator('#roomTitle')).toHaveText('Another room')
    await expect(card).toHaveCount(0)
    await expect(host.locator('#chatLog')).not.toContainText('Rowan')
    await expect(guest.locator('#join')).toBeHidden()
    await expect(guest.locator('#roomArea')).toBeHidden()
    expect(grants).toBe(0)
  } finally { await hostContext.close(); await guestContext.close() }
})

test('another same-name request preserves the first request’s focused and pressed button', async ({ browser, baseURL }) => {
  const { hostContext, guestContext, host, guest } = await askedRoom(browser, baseURL!)
  const otherContext = await newDeviceContext(browser, baseURL!)
  try {
    const first = await startAskedRoom(host, guest, baseURL!)
    const request = await first.getAttribute('data-request')
    const admit = first.getByRole('button', { name: 'Let in', exact: true })
    await admit.focus()
    const other = await otherContext.newPage()
    await other.addInitScript(() => localStorage.setItem('kithmoot.name', 'Rowan'))
    await other.goto(guest.url())
    const cards = host.locator('#approvals .approvalCard.knock')
    await expect(cards).toHaveCount(2)
    const original = host.locator(`.knock[data-request="${request}"]`)
    await expect(original.getByRole('button', { name: 'Let in', exact: true })).toBeFocused()
    const devices = await cards.locator('.knockEvidence').allTextContents()
    expect(devices[0]).not.toBe(devices[1])
    await cards.nth(1).getByRole('button', { name: 'Decline', exact: true }).click()
    const button = original.getByRole('button', { name: 'Let in', exact: true })
    const bounds = (await button.boundingBox())!
    await host.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await host.mouse.down()
    const third = await otherContext.newPage()
    await third.goto(guest.url())
    await expect(cards).toHaveCount(2)
    await host.mouse.up()
    await expect(guest.locator('#status')).toContainText('You are on the list')
    await expect(third.locator('#join')).toBeHidden()
    await expect(other.locator('#join')).toBeHidden()
  } finally { await hostContext.close(); await guestContext.close(); await otherContext.close() }
})

test('an explicit open-door choice survives reopening a temporary room', async ({ browser, baseURL }) => {
  const { hostContext, guestContext, host, guest } = await askedRoom(browser, baseURL!)
  const nextContext = await newDeviceContext(browser, baseURL!)
  try {
    const first = await startAskedRoom(host, guest, baseURL!)
    const link = guest.url()
    await first.getByRole('button', { name: 'Let in', exact: true }).click()
    await expect(guest.locator('#status')).toContainText('You are on the list')
    await guestContext.close()
    await host.locator('#roomMenu').click()
    await expect(host.locator('#toggleKnock')).toHaveAttribute('data-on', 'true')
    await host.locator('#toggleKnock').click()
    await expect(host.locator('#toggleKnock')).toHaveAttribute('data-on', 'false')
    await host.reload()
    await host.locator('#join').click()
    await expect(host.locator('#roomArea')).toBeVisible()
    await host.locator('#roomMenu').click()
    await expect(host.locator('#toggleKnock')).toHaveAttribute('data-on', 'false')
    const next = await nextContext.newPage()
    await next.goto(link)
    await expect(next.locator('#status')).toContainText('You are on the list')
    await expect(host.locator('#approvals .approvalCard.knock')).toHaveCount(0)
  } finally { await nextContext.close(); await guestContext.close(); await hostContext.close() }
})

test('an admitted member asks before passing a closed-room invitation to another guest', async ({ browser, baseURL }) => {
  const { hostContext, guestContext, host, guest } = await askedRoom(browser, baseURL!)
  const nextContext = await newDeviceContext(browser, baseURL!)
  try {
    const first = await startAskedRoom(host, guest, baseURL!)
    const link = guest.url()
    await first.getByRole('button', { name: 'Let in', exact: true }).click()
    await expect(guest.locator('#status')).toContainText('You are on the list')
    await guest.locator('#join').click()
    await expect(guest.locator('#roomArea')).toBeVisible()
    const next = await nextContext.newPage()
    await next.addInitScript(() => localStorage.setItem('kithmoot.name', 'Later guest'))
    await next.goto(link)
    const memberQueue = guest.locator('#approvals .approvalCard.knock')
    await expect(memberQueue).toContainText('Later guest wants to join')
    await expect(next.locator('#join')).toBeHidden()
    await expect(next.locator('#roomArea')).toBeHidden()
    // A delegated member can admit deliberately; being admitted does not
    // silently turn their device into an automatic invitation responder.
    await memberQueue.getByRole('button', { name: 'Let in', exact: true }).click()
    await expect(next.locator('#status')).toContainText('You are on the list')
    await next.locator('#join').click()
    await expect(next.locator('#roomArea')).toBeVisible()
  } finally { await nextContext.close(); await guestContext.close(); await hostContext.close() }
})

// A room where people with the link ask, and somebody in it lets them in.
// The creator picks that at the start form; a joiner opening the link waits
// on the door; the creator sees who is asking, with their name, and either
// lets them in or declines, in which case the door says nobody let them in.
test('people with the link ask, and the person in the room lets them in or declines', async ({ browser, baseURL }) => {
  test.setTimeout(240_000)
  const a = await newDeviceContext(browser, baseURL!), b = await newDeviceContext(browser, baseURL!), c = await newDeviceContext(browser, baseURL!)
  try {
    const host = await a.newPage()
    const relays = testRelaysFor(baseURL!)
    if (relays) await host.addInitScript(urls => localStorage.setItem('kithmoot.relays.v1', JSON.stringify({ default: urls.map(url => ({ url, read: true, write: true })) })), relays)
    await host.goto(baseURL!)
    await openNewRoomForm(host)
    await host.locator('#roomName').fill('Asked in')
    await host.locator('#roomAsk').check()
    await host.locator('#create').click()
    const share = host.locator('#shareUrl')
    await expect.poll(async () => (await share.inputValue()).length, { timeout: 30_000 }).toBeGreaterThan(0)
    const link = await share.inputValue()
    await host.locator('#displayName').fill('Ada')
    await host.locator('#join').click()
    await expect(host.locator('#roomArea')).toBeVisible()

    // Rowan asks. The host sees who, by name, and lets them in.
    // Rowan's name goes in the request, so it is typed before the link
    // opens: the door for a room that asks first has no Join to press yet.
    const rowan = await b.newPage()
    await rowan.addInitScript(() => localStorage.setItem('kithmoot.name', 'Rowan'))
    await rowan.goto(link)
    await expect(rowan.locator('#status')).toContainText('Asking to be let in', { timeout: 60_000 })
    await expect(rowan.locator('#arrivalTitle')).toHaveText('Waiting to be admitted')
    await expect(rowan.locator('#arrivalLead')).toContainText('Someone already in the room needs to let you in')
    const card = host.locator('#approvals .approvalCard.knock')
    await expect(card).toContainText('Rowan wants to join', { timeout: 60_000 })
    await card.getByRole('button', { name: 'Let in', exact: true }).click()
    await expect(rowan.locator('#status')).toContainText('You are on the list', { timeout: 60_000 })
    await expect(host.locator('#chatLog')).toContainText('Invitation sent to Rowan.')
    await expect(rowan.locator('#join')).toBeVisible()
    await expect(rowan.locator('#displayName')).toHaveValue('Rowan')
    await rowan.locator('#join').click()
    await expect(rowan.locator('#roomArea')).toBeVisible()

    // Sam asks and receives an authenticated refusal, with no room capability.
    const sam = await c.newPage()
    await sam.addInitScript(() => localStorage.setItem('kithmoot.name', 'Sam'))
    await sam.goto(link)
    const second = host.locator('#approvals .approvalCard.knock')
    await expect(second).toContainText('Sam wants to join', { timeout: 60_000 })
    await second.getByRole('button', { name: 'Decline', exact: true }).click()
    await expect(host.locator('#chatLog')).toContainText('You declined Sam.')
    await expect(sam.locator('#arrivalTitle')).toHaveText('Your request was declined')
    await expect(sam.locator('#roomArea')).toBeHidden()
    await expect(sam.locator('#join')).toBeHidden()
    await expect(host.locator('#approvals .approvalCard.knock')).toHaveCount(0)

    // The switch is in Room details for the device that answers the link.
    await host.locator('#roomMenu').click()
    await expect(host.locator('#toggleKnock')).toHaveAttribute('data-on', 'true')
  } finally { await a.close(); await b.close(); await c.close() }
})
