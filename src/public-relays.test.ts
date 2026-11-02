import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PUBLIC_RELAYS, PUBLIC_RELAYS, isForgeSwornRelay } from './public-relays.js'

const JSON_PATH = new URL('../data/public-relays.json', import.meta.url)

describe('the curated public relays', () => {
  it('data/public-relays.json is byte-identical to the list', () => {
    expect(readFileSync(JSON_PATH, 'utf8')).toBe(JSON.stringify(PUBLIC_RELAYS, null, 2) + '\n')
  })

  it('names no ForgeSworn host', () => {
    for (const relay of PUBLIC_RELAYS) {
      expect(isForgeSwornRelay(relay.url), `${new URL(relay.url).hostname} is a ForgeSworn host`).toBe(false)
    }
    expect(isForgeSwornRelay('wss://relay2.forgesworn.dev/')).toBe(true)
    expect(isForgeSwornRelay('wss://box.kithmoot.app/')).toBe(true)
  })

  it('uses canonical wss:// URLs, once each', () => {
    const urls = PUBLIC_RELAYS.map(relay => relay.url)
    for (const url of urls) {
      expect(url).toMatch(/^wss:\/\//)
      const parsed = new URL(url)
      expect(url).toBe(`wss://${parsed.host}/`)
      expect(url).toBe(url.toLowerCase())
    }
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('keeps to the list rules', () => {
    expect(PUBLIC_RELAYS.length).toBeLessThanOrEqual(6)
    expect(DEFAULT_PUBLIC_RELAYS).toHaveLength(4)
    expect(new Set(DEFAULT_PUBLIC_RELAYS.map(relay => relay.operator)).size).toBe(4)
    expect(new Set(DEFAULT_PUBLIC_RELAYS.map(relay => new URL(relay.url).host)).size).toBe(4)
    const quiet = PUBLIC_RELAYS.filter(relay => relay.quietRooms)
    expect(quiet.length).toBeGreaterThanOrEqual(2)
    expect(quiet.some(relay => relay.default)).toBe(true)
  })

  it('dates every check with a valid ISO date', () => {
    for (const relay of PUBLIC_RELAYS) {
      expect(relay.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(new Date(`${relay.checked}T00:00:00Z`).toISOString().slice(0, 10)).toBe(relay.checked)
    }
  })
})
