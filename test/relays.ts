import type { Page } from '@playwright/test'
import { base64urlnopad } from '@scure/base'

/**
 * Which relays the acceptance specs pin a room to.
 *
 * Unset: the app's own defaults, which are real public relays - the live
 * check, with real relay weather. `E2E_RELAYS=local`: the relay in
 * `test/ws-relay.mjs`, which playwright.config.ts starts alongside the app -
 * the CI gate, deterministic and offline. A comma-separated list names any
 * other relays.
 */
export const LOCAL_TEST_RELAY = 'ws://127.0.0.1:7777'

export function testRelays(): string[] | undefined {
  const env = process.env.E2E_RELAYS
  if (!env) return undefined
  if (env === 'local') return [LOCAL_TEST_RELAY]
  return env.split(',').map((s) => s.trim()).filter(Boolean)
}

/** `url` with its relay list replaced by the test relays, when there are
 *  any; otherwise `url` untouched. */
export function pinToTestRelays(url: string): string {
  const relays = testRelays()
  return relays ? withRelays(url, relays) : url
}

/**
 * Rewrite the relay hint list inside a join URL's fragment, leaving every
 * other field exactly as the app wrote it.
 *
 * Parsed and re-encoded generically rather than rebuilt from known fields,
 * so a fragment that grows a new key later still round-trips untouched.
 */
export function withRelays(url: string, relays: string[]): string {
  const parsed = new URL(url)
  const payload = JSON.parse(
    new TextDecoder().decode(base64urlnopad.decode(parsed.hash.slice(1))),
  ) as Record<string, unknown>
  payload.r = relays
  parsed.hash = base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(payload)))
  return parsed.href
}

/**
 * Open a room link.
 *
 * A goto() to a URL that differs from the page's current one only in its
 * fragment is a same-document navigation: the app's module-level entry
 * point never re-runs and a patched relay list is silently ignored. So when
 * that is what this navigation would be, the page is reloaded afterwards,
 * which is what re-reads the fragment.
 */
export async function openRoomUrl(page: Page, url: string): Promise<void> {
  const before = page.url()
  await page.goto(url)
  if (sameDocument(before, url)) await page.reload()
}

function sameDocument(a: string, b: string): boolean {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search
  } catch {
    return false
  }
}
