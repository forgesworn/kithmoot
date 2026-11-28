import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { wrapEvent } from 'nostr-tools/nip59'
import { NostrRelayPool } from '../src/relay-pool.js'
import { encodeRoomLink } from '../src/link.js'
import { deriveRoom, generateRoomSecret } from '../src/room.js'
import { dmPolicy } from '../src/dm.js'
import { TEST_RELAY_WS } from './browser.js'

/** The account Ada and the people around her, for People thread checks.
 *  Ada follows Priya, Bob, Chen, an unnamed key and Ellis; Priya and Bob
 *  have history with her, Sam (not followed) has written once, and an
 *  Ellis private chat is saved on the device. */
export interface PeopleScenario {
  ada: Uint8Array; priya: Uint8Array; bob: Uint8Array; chen: Uint8Array; nameless: Uint8Array; ellis: Uint8Array; sam: Uint8Array
  pubkeys: { ada: string; priya: string; bob: string; chen: string; nameless: string; ellis: string; sam: string }
  ellisRoom: { roomId: string; link: string; chatLabel: string; openedAt: number; readAt: number }
}

export function peopleScenario(baseURL: string): PeopleScenario {
  const keys = { ada: generateSecretKey(), priya: generateSecretKey(), bob: generateSecretKey(), chen: generateSecretKey(), nameless: generateSecretKey(), ellis: generateSecretKey(), sam: generateSecretKey() }
  const pubkeys = Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, getPublicKey(key)])) as PeopleScenario['pubkeys']
  const secret = generateRoomSecret(), { roomId } = deriveRoom(secret)
  const link = encodeRoomLink(baseURL, { secret, relays: [TEST_RELAY_WS], iceUrls: [], policy: dmPolicy(pubkeys.ada, pubkeys.ellis) })
  return { ...keys, pubkeys, ellisRoom: { roomId, link, chatLabel: 'Ellis Moore', openedAt: Math.floor(Date.now() / 1000), readAt: 0 } }
}

/** Publish the inbox lists, follows, names and message history. */
export async function seedPeople(scenario: PeopleScenario, baseURL: string, options: { profiles?: boolean } = {}): Promise<void> {
  const pool = new NostrRelayPool([TEST_RELAY_WS])
  const relay = new URL('/__test-relay', baseURL); relay.protocol = 'wss:'
  const now = Math.floor(Date.now() / 1000), { pubkeys: p } = scenario
  try {
    for (const key of [scenario.ada, scenario.priya, scenario.bob, scenario.chen, scenario.ellis, scenario.sam]) {
      await pool.publish(finalizeEvent({ kind: 10050, created_at: now - 600, tags: [['relay', relay.href]], content: '' }, key))
    }
    await pool.publish(finalizeEvent({ kind: 3, created_at: now - 600, tags: [p.priya, p.bob, p.chen, p.nameless, p.ellis].map(k => ['p', k]), content: '' }, scenario.ada))
    const names: [Uint8Array, string][] = [[scenario.priya, 'Priya Natarajan'], [scenario.bob, 'Bob Okafor'], [scenario.chen, 'Chen Wei'], [scenario.ellis, 'Ellis Moore'], [scenario.sam, 'Sam Rivers']]
    for (const [key, name] of names) await pool.publish(finalizeEvent({ kind: 0, created_at: now - 600, tags: [], content: JSON.stringify({ name }) }, key))
    const say = async (from: Uint8Array, to: string, text: string, at: number) => {
      const rumor = { kind: 14, created_at: at, tags: [['p', to]], content: text }
      await pool.publish(wrapEvent(rumor, from, to))
      // A sender's own copy, so that history shows both sides.
      if (from === scenario.ada) await pool.publish(wrapEvent(rumor, from, p.ada))
    }
    await say(scenario.priya, p.ada, 'Are you around this afternoon?', now - 3 * 3600)
    await say(scenario.ada, p.priya, 'Yes, after two.', now - 3 * 3600 + 120)
    await say(scenario.priya, p.ada, 'Lovely, I will ring then.', now - 3 * 3600 + 240)
    await say(scenario.priya, p.ada, 'Bring the notes if you can.', now - 3 * 3600 + 360)
    await say(scenario.ada, p.bob, 'Thanks for the files.', now - 86400 * 2)
    await say(scenario.sam, p.ada, 'Hello, you do not know me yet.', now - 1800)
    void options
  } finally { pool.close() }
}

/** Open a thread with anyone by pasting their npub into People's search. */
export async function openNpubThread(page: import('@playwright/test').Page, npub: string, pubkey: string): Promise<void> {
  await page.locator('#railPeople').click()
  await page.locator('#peopleQuery').fill(npub)
  await page.locator(`#peopleRows li[data-person="${pubkey}"] button`).first().click()
}

/** One more message to the account's inbox, as if sent just now. */
export async function say(scenario: PeopleScenario, from: Uint8Array, to: string, text: string): Promise<void> {
  const pool = new NostrRelayPool([TEST_RELAY_WS])
  try { await pool.publish(wrapEvent({ kind: 14, created_at: Math.floor(Date.now() / 1000), tags: [['p', to]], content: text }, from, to)) } finally { pool.close() }
  void scenario
}
