import { test, expect, type Page } from '@playwright/test'
import { createRoom, expectToSeeAndHear, joinWithMedia, newDeviceContext } from './browser.js'

/**
 * What a call actually tells the far end about this device's network.
 *
 * A page holding camera permission gathers a raw host candidate for every
 * interface (LAN, VPN tunnel, Tailscale, unique-local IPv6). The library must
 * send none of them (src/local-address-filter.ts): only mDNS names, loopback
 * and reflexive or relay candidates with their related address zeroed. This
 * records what each page gathered and what the other page was handed, through
 * a real call, and checks the second never contains the first.
 */

const RECORD = () => {
  const win = window as unknown as { __gathered: string[]; __received: string[] }
  win.__gathered = []
  win.__received = []
  const proto = RTCPeerConnection.prototype
  const setRemote = proto.setRemoteDescription
  const addCandidate = proto.addIceCandidate
  proto.setRemoteDescription = function (this: RTCPeerConnection, description?: RTCSessionDescriptionInit) {
    if (description?.sdp) win.__received.push(description.sdp)
    return Reflect.apply(setRemote, this, [description]) as Promise<void>
  } as typeof proto.setRemoteDescription
  proto.addIceCandidate = function (this: RTCPeerConnection, candidate?: RTCIceCandidateInit | null) {
    if (candidate?.candidate) win.__received.push(candidate.candidate)
    return Reflect.apply(addCandidate, this, [candidate]) as Promise<void>
  } as typeof proto.addIceCandidate
  const Original = window.RTCPeerConnection
  window.RTCPeerConnection = class extends Original {
    constructor(...args: [RTCConfiguration?]) {
      super(...args)
      this.addEventListener('icecandidate', (event) => {
        if (event.candidate?.candidate) win.__gathered.push(event.candidate.candidate)
      })
    }
  } as unknown as typeof RTCPeerConnection
}

/** Every address a candidate or description names: connection, raddr, c=, a=rtcp:. */
function addresses(text: string): string[] {
  const found: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const candidate = /candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ \S+(?: .*?raddr (\S+))?/.exec(line)
    if (candidate) {
      found.push(candidate[1]!)
      if (candidate[2]) found.push(candidate[2])
    }
    const connection = /^c=IN IP[46] ([^\s/]+)/.exec(line)
    if (connection) found.push(connection[1]!)
    const rtcp = /^a=rtcp:\d+ IN IP[46] (\S+)/.exec(line)
    if (rtcp) found.push(rtcp[1]!)
  }
  return found
}

function isPrivate(address: string): boolean {
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(address)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
  }
  const lower = address.toLowerCase()
  return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)
}

/** A host candidate naming an IP literal that is not loopback. */
function rawHost(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const host = /candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ host/.exec(line)
    if (!host) return false
    const address = host[1]!
    return !/\.local$/i.test(address) && !/^127\./.test(address) && address !== '::1'
  })
}

const read = (page: Page) => page.evaluate(() => {
  const win = window as unknown as { __gathered: string[]; __received: string[] }
  return { gathered: win.__gathered, received: win.__received }
})

test('a call hands the far end no local network address', async ({ browser, baseURL }) => {
  test.setTimeout(240_000)
  const contexts = await Promise.all([newDeviceContext(browser, baseURL!), newDeviceContext(browser, baseURL!)])
  try {
    for (const context of contexts) await context.addInitScript(RECORD)
    const [alice, bob] = await Promise.all(contexts.map((context) => context.newPage()))
    const url = await createRoom(alice!, baseURL!, undefined, 'Alice')
    await joinWithMedia(alice!, url, 'Alice')
    await joinWithMedia(bob!, url, 'Bob')
    await expectToSeeAndHear(alice!, 'Alice')
    await expectToSeeAndHear(bob!, 'Bob')

    const a = await read(alice!), b = await read(bob!)
    // The pages really did gather something worth hiding; otherwise this
    // proves nothing. Every developer machine and CI runner has a private
    // interface address.
    const gathered = [...a.gathered, ...b.gathered].flatMap(addresses).filter(isPrivate)
    expect(gathered.length, 'neither page gathered a private address, so nothing was tested').toBeGreaterThan(0)

    for (const [who, received] of [['Alice', a.received], ['Bob', b.received]] as const) {
      expect(received.length, `${who} was handed no description or candidate`).toBeGreaterThan(0)
      const leaked = received.flatMap(addresses).filter(isPrivate)
      expect(leaked, `${who} was handed a local network address`).toEqual([])
      expect(received.filter(rawHost), `${who} was handed a raw host candidate`).toEqual([])
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
  }
})
