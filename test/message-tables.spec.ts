import { test, expect } from '@playwright/test'
import { generateRoomSecret } from '../src/room.js'
import { encodeRoomLink } from '../src/link.js'
import { RoomAgent } from '../src/agent.js'
import { generateSecretKey } from 'nostr-tools/pure'
import { localIdentity } from '../src/identity.js'
import { TEST_RELAY_WS } from './browser.js'

/**
 * A table pasted into a message is drawn as a table on the reader's
 * screen, while the words on the wire stay exactly as typed: Edit gets
 * them back, an older client shows them, and the room sees nothing new.
 * See app/src/message-tables.ts and docs/messages.md.
 */

// A decoder comparison drawn by a terminal, as pasted.
const DECODERS = [
  '┌──────────────────────┬──────┬───────────┬──────────────┬──────┐',
  '│         Set          │ Ours │ zxing-cpp │ ZXing (Java) │ jsQR │',
  '├──────────────────────┼──────┼───────────┼──────────────┼──────┤',
  '│ 185 photographs      │ 166  │ 170       │ 159          │ 155  │',
  '├──────────────────────┼──────┼───────────┼──────────────┼──────┤',
  '│ 62 bug-report images │ 47   │ 51        │ 40           │ 26   │',
  '├──────────────────────┼──────┼───────────┼──────────────┼──────┤',
  '│ 560 synthetic frames │ 518  │ 503       │ 143          │ 185  │',
  '└──────────────────────┴──────┴───────────┴──────────────┴──────┘',
].join('\n')

const WIDE = [
  '| Relay | Region | Median latency | p95 latency | Uptime this month | Events per second | Refusals | Notes |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
  '| first | Helsinki | 41 ms | 120 ms | 99.98% | 1,204 | 0 | steady all week |',
  '| second | Falkenstein | 38 ms | 97 ms | 99.91% | 980 | 3 | one restart |',
].join('\n')

const LONG = ['| Row | Value |', '| --- | ---: |', ...Array.from({ length: 30 }, (_, i) => `| row ${i} | ${i * 7} |`)].join('\n')

test('a pasted table reads as a table, scrolls when it is wide, folds between rows, and keeps its words on the wire', async ({ browser, baseURL }) => {
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  await context.routeWebSocket(url => url.href !== relay.href, ws => ws.close())
  await context.route('**/turn', route => route.fulfill({ status: 503, body: '' }))
  const link = encodeRoomLink(baseURL!, { secret: generateRoomSecret(), name: 'Bench', relays: [relay.href], iceUrls: [] })
  const rowan = await RoomAgent.join({ link, identity: localIdentity(generateSecretKey()), relays: [TEST_RELAY_WS], name: 'Rowan' })
  try {
    const page = await context.newPage(); await page.goto(link)
    await page.locator('#displayName').fill('Ada'); await page.locator('#join').click()

    // Rowan pastes the comparison with a line either side of it.
    await rowan.chat.send(`Decoder results so far:\n${DECODERS}\nOurs leads on two of three.`)
    const comparison = page.locator('#chatLog .msg').filter({ hasText: 'Decoder results so far:' })
    const table = comparison.locator('.messageTable table')
    await expect(table).toBeVisible()
    await expect(table.locator('thead th')).toHaveText(['Set', 'Ours', 'zxing-cpp', 'ZXing (Java)', 'jsQR'])
    await expect(table.locator('tbody tr')).toHaveCount(3)
    await expect(table.locator('tbody tr').nth(0).locator('td')).toHaveText(['185 photographs', '166', '170', '159', '155'])
    await expect(table.locator('tbody tr').nth(1).locator('td')).toHaveText(['62 bug-report images', '47', '51', '40', '26'])
    await expect(table.locator('tbody tr').nth(2).locator('td')).toHaveText(['560 synthetic frames', '518', '503', '143', '185'])
    await expect(table.locator('thead th').first()).toHaveAttribute('scope', 'col')
    // No box characters are left on screen; the words either side stay.
    await expect(comparison.locator('.text')).not.toContainText('│')
    await expect(comparison.locator('.text')).toContainText('Decoder results so far:')
    await expect(comparison.locator('.text')).toContainText('Ours leads on two of three.')
    // Short enough that nothing folds.
    await expect(comparison.getByRole('button', { name: 'Read more' })).toHaveCount(0)

    // A table wider than a phone scrolls sideways inside its bubble rather
    // than widening the conversation, and says so to a keyboard or reader.
    await rowan.chat.send(WIDE)
    const wide = page.locator('#chatLog .msg').filter({ hasText: 'Falkenstein' }).locator('.messageTable')
    await expect(wide.locator('tbody tr')).toHaveCount(2)
    await expect(wide.locator('tbody tr').first().locator('td').nth(2)).toHaveClass(/end/)
    await expect(wide).toHaveAttribute('tabindex', '0')
    await expect(wide).toHaveAttribute('aria-label', 'Table, scrolls sideways')
    expect(await wide.evaluate(frame => frame.scrollWidth > frame.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    // A long table folds between whole rows, never through one.
    await rowan.chat.send(LONG)
    const long = page.locator('#chatLog .msg').filter({ hasText: 'row 0' })
    const rows = long.locator('.messageTable tbody tr')
    await expect(rows.first()).toBeVisible()
    // Two narrow columns fit a phone, so the table is no extra Tab stop.
    await expect(long.locator('.messageTable')).not.toHaveAttribute('tabindex', '0')
    const folded = await rows.count()
    expect(folded).toBeGreaterThan(0)
    expect(folded).toBeLessThan(30)
    await expect(rows.last().locator('td')).toHaveText([`row ${folded - 1}`, String((folded - 1) * 7)])
    await long.getByRole('button', { name: 'Read more' }).click()
    await expect(rows).toHaveCount(30)
    await expect(rows.last().locator('td')).toHaveText(['row 29', '203'])
    await long.getByRole('button', { name: 'Collapse' }).click()
    await expect(rows).toHaveCount(folded)

    // Ada pastes the same table herself. It is drawn for her too, the room
    // receives the characters she typed, and Edit hands them back as typed.
    await page.locator('#chatInput').fill(DECODERS)
    await page.locator('#chatInput').press('Enter')
    await expect.poll(() => rowan.chat.messages().filter(m => m.text === DECODERS).length).toBe(1)
    const own = page.locator('#chatLog .msg.mine').filter({ hasText: '560 synthetic frames' })
    await expect(own.locator('.messageTable tbody tr')).toHaveCount(3)
    await own.locator('.messageMore').click()
    await page.locator('#messageActionPanel').getByRole('button', { name: 'Edit this message' }).click()
    await expect(page.locator('#composerContext')).toContainText('Editing your message')
    await expect(page.locator('#chatInput')).toHaveValue(DECODERS)
    await page.locator('#composerContext').getByRole('button', { name: 'Stop editing' }).click()
    await expect(page.locator('#composerContext')).toBeHidden()
  } finally {
    await rowan.leave()
    await context.close()
  }
})
