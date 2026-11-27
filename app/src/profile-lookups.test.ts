import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils'
import { createMadeHere, hostList, lookupHosts } from './profile-lookups.js'

const keyPair = () => { const secret = generateSecretKey(); return { hex: bytesToHex(secret), pubkey: getPublicKey(secret) } }

describe('createMadeHere', () => {
  it('is true for the public key of the participant key kept on this device, and for nobody else', () => {
    const mine = keyPair(), other = keyPair()
    const madeHere = createMadeHere(() => mine.hex)
    expect(madeHere(mine.pubkey)).toBe(true)
    expect(madeHere(other.pubkey)).toBe(false)
    // The secret itself is not a public key, and a short prefix is not either.
    expect(madeHere(mine.hex)).toBe(false)
    expect(madeHere(mine.pubkey.slice(0, 16))).toBe(false)
  })

  it('is false when this browser keeps no participant key, as when only an account is signed in', () => {
    const someone = keyPair()
    expect(createMadeHere(() => null)(someone.pubkey)).toBe(false)
    expect(createMadeHere(() => undefined)(someone.pubkey)).toBe(false)
    expect(createMadeHere(() => '')(someone.pubkey)).toBe(false)
  })

  it('is false when storage throws or holds something that is not a key', () => {
    const someone = keyPair()
    expect(createMadeHere(() => { throw new Error('blocked') })(someone.pubkey)).toBe(false)
    expect(createMadeHere(() => 'not hex at all')(someone.pubkey)).toBe(false)
    expect(createMadeHere(() => 'ab'.repeat(5))(someone.pubkey)).toBe(false)
  })

  it('follows the stored key when it changes', () => {
    const first = keyPair(), second = keyPair()
    let stored: string | null = first.hex
    const madeHere = createMadeHere(() => stored)
    expect(madeHere(first.pubkey)).toBe(true)
    expect(madeHere(first.pubkey)).toBe(true)
    expect(madeHere(second.pubkey)).toBe(false)
    stored = second.hex
    expect(madeHere(second.pubkey)).toBe(true)
    expect(madeHere(first.pubkey)).toBe(false)
    stored = null
    expect(madeHere(second.pubkey)).toBe(false)
  })
})

describe('lookupHosts', () => {
  it('names each host once, in order, and leaves out what does not parse', () => {
    expect(lookupHosts(['wss://nos.lol', 'wss://nos.lol/', 'not a url', 'wss://purplepag.es', 'ws://127.0.0.1:7777/x']))
      .toEqual(['nos.lol', 'purplepag.es', '127.0.0.1:7777'])
    expect(lookupHosts([])).toEqual([])
  })

  it('reads the list it is given, so a change to the public list shows', () => {
    const list = ['wss://purplepag.es', 'wss://relay.damus.io']
    expect(lookupHosts(list)).toEqual(['purplepag.es', 'relay.damus.io'])
    list.push('wss://relay.primal.net')
    expect(lookupHosts(list)).toEqual(['purplepag.es', 'relay.damus.io', 'relay.primal.net'])
  })
})

describe('hostList', () => {
  it('reads as a sentence', () => {
    expect(hostList([])).toBe('')
    expect(hostList(['a.example'])).toBe('a.example')
    expect(hostList(['a.example', 'b.example'])).toBe('a.example and b.example')
    expect(hostList(['a.example', 'b.example', 'c.example'])).toBe('a.example, b.example and c.example')
  })
})

describe('the app asks only through the wrapper', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')

  it('opens directory subscriptions only through the private-room guard', () => {
    expect(main.match(/\bprofiles\.want\(/g)).toHaveLength(1)
    const wrapper = main.slice(main.indexOf('function wantProfiles('), main.indexOf('function renderLookupHosts('))
    expect(wrapper).toContain('if (privateProfileRoute()) return')
    expect(wrapper).toContain("profiles.want(peers, 'public')")
  })
})
