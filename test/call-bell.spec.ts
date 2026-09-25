import { test, expect } from '@playwright/test'
import WebSocket from 'ws'
import type { Event } from 'nostr-tools/pure'
import { deriveRoom, generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { decodeRosterEvent } from '../src/roster.js'
import { callBellTag, decodeCallBellEvent } from '../src/call-bell.js'
import { KINDS } from '../src/kinds.js'
import { testRelaysFor } from './relays.js'
import { newDeviceContext, open, openCall, TEST_RELAY_WS } from './browser.js'

/**
 * The call bell, off the wire: starting a call publishes exactly one kind
 * 1464 to the room's relay, and ending it exactly one more, and neither
 * carries anything a relay could tie to the room's roster or to a key of the
 * person who rang. See "Call bell" in docs/protocol.md.
 */

/** Everything the relay carries for the filters from now on, ephemeral kinds
 *  included, which is why this is a live subscription and not a query. */
function listen(filters: Record<string, unknown>[]): { events: Event[]; close: () => void; ready: Promise<void> } {
  const socket = new WebSocket(TEST_RELAY_WS)
  const events: Event[] = []
  const ready = new Promise<void>((resolve, reject) => {
    socket.on('open', () => socket.send(JSON.stringify(['REQ', 'bell', ...filters])))
    socket.on('message', raw => {
      const frame = JSON.parse(String(raw))
      if (frame[0] === 'EOSE' && frame[1] === 'bell') resolve()
      if (frame[0] === 'EVENT' && frame[1] === 'bell') events.push(frame[2])
    })
    socket.on('error', reject)
  })
  return { events, close: () => socket.close(), ready }
}

test('starting a call rings one unlinkable bell, and ending it one more', async ({ browser, baseURL }) => {
  test.skip(test.info().project.name !== 'chromium', 'one browser is enough for a wire check')
  test.skip(!testRelaysFor(baseURL!)?.length, 'needs the local test relay to read the wire')
  const secret = generateRoomSecret()
  const { roomId, roomKey } = deriveRoom(secret)
  const url = encodeRoomLink(baseURL!, { secret, relays: testRelaysFor(baseURL!) ?? [], iceUrls: [] })
  const nowSeconds = Math.floor(Date.now() / 1000)
  const tags = [...new Set([nowSeconds - 120, nowSeconds, nowSeconds + 600].map(t => callBellTag(roomKey, t)))]
  const wire = listen([{ kinds: [KINDS.ROSTER], '#d': [roomId] }, { kinds: [KINDS.CALL_BELL], '#d': tags }])
  await wire.ready
  const bells = () => wire.events.filter(e => e.kind === KINDS.CALL_BELL)

  const context = await newDeviceContext(browser, baseURL!)
  try {
    const page = await context.newPage()
    await open(page, url, 'Ada')
    await page.locator('#join').click()
    await expect(page.locator('#roomArea')).toBeVisible()
    await page.waitForTimeout(2_000)
    expect(bells(), 'joining the room is not a call').toHaveLength(0)

    await openCall(page)
    await expect.poll(() => bells().length, { timeout: 30_000 }).toBe(1)
    // Heartbeats go on; the bell does not.
    await page.waitForTimeout(3_000)
    expect(bells()).toHaveLength(1)

    const [start] = bells()
    const decoded = decodeCallBellEvent(start!, { roomId, key: roomKey, now: Math.floor(Date.now() / 1000) })
    expect(decoded?.state).toBe('start')
    expect(start!.tags.map(t => t[0])).toEqual(['d', 'expiration'])
    expect(start!.tags[1]![1]).toBe(String(start!.created_at + 120))
    expect(start!.tags[0]![1]).not.toBe(roomId)

    const entries = wire.events
      .filter(e => e.kind === KINDS.ROSTER)
      .map(e => decodeRosterEvent(e, { roomId, roomKey, now: Math.floor(Date.now() / 1000) }))
      .filter(e => e !== null)
    expect(entries.length).toBeGreaterThan(0)
    const device = entries[0]!.device
    const participant = entries[0]!.participant
    expect(decoded?.device).toBe(device)
    expect(entries.some(e => e.call?.id === decoded?.call.id)).toBe(true)
    const outer = JSON.stringify(start).toLowerCase()
    expect(outer).not.toContain(device)
    expect(outer).not.toContain(participant)
    expect(outer).not.toContain(roomId)

    await page.locator('#leaveCall').click()
    await expect.poll(() => bells().length, { timeout: 30_000 }).toBe(2)
    const end = decodeCallBellEvent(bells()[1]!, { roomId, key: roomKey, now: Math.floor(Date.now() / 1000) })
    expect(end).toMatchObject({ state: 'end', call: decoded!.call, device })
    expect(bells()[1]!.pubkey).not.toBe(start!.pubkey)
  } finally {
    wire.close()
    await context.close()
  }
})
