import { describe, expect, it } from 'vitest'
import { addressHost, callPathView, clockText, type CallPathInput } from './call-path-words.js'

const none: CallPathInput = {
  spry: { state: 'none' }, server: { state: 'none' }, publicRelays: { enabled: false, chosen: false }, hideIp: false,
}
const view = (change: Partial<CallPathInput> = {}) => callPathView({ ...none, ...change })
const running = { running: true, rowSub: 'On · in use now' }

describe('how calls connect (section 6.1)', () => {
  it('CS1: nothing set up', () => {
    const v = view()
    expect(v.head).toBe('Direct only')
    expect(v.body).toBe('Calls connect device to device. Some networks block that, so a call may not connect. Set up a relay below to carry those calls.')
    expect(v.rootSub).toBe('Direct only')
    expect(v.failure).toBeUndefined()
  })
  it('CS2: built-in, Spry or relay server wins', () => {
    expect(view({ builtIn: running }).head).toBe("Direct, or through this computer's relay")
    expect(view({ spry: { state: 'paired' } }).head).toBe('Direct, or through your Spry node')
    const server = view({ server: { state: 'saved', host: 'relay.example.org' } })
    expect(server.head).toBe('Direct, or through your relay server')
    expect(server.body).toBe("Calls connect device to device when they can. When they can't, they go through your relay server.")
    expect(server.rootSub).toBe('Direct, or through your relay server')
  })
  it('CS3: a chosen public relay', () => {
    const v = view({ publicRelays: { enabled: true, chosen: true } })
    expect(v.head).toBe('Direct, or through a public relay')
    expect(v.body).toBe("Calls connect device to device when they can. When they can't, they go through the public call relay you chose, unless the room brings its own.")
  })
  it('public relays that are on but not chosen change nothing', () => {
    expect(view({ publicRelays: { enabled: true, chosen: false } }).head).toBe('Direct only')
  })
  it('CS4: Hide my IP with a winner', () => {
    const v = view({ hideIp: true, server: { state: 'saved', host: 'r.example' } })
    expect(v.head).toBe('Always through your relay server')
    expect(v.body).toBe("Hide my IP address is on, so calls never connect directly. People on the call don't see your IP address.")
    expect(v.rootSub).toBe('Always through your relay server')
    expect(view({ hideIp: true, builtIn: running }).head).toBe("Always through this computer's relay")
  })
  it('CS5: Hide my IP and nothing to carry the call', () => {
    const v = view({ hideIp: true })
    expect(v.head).toBe('No relay for calls')
    expect(v.body).toBe('Hide my IP address is on, so a call can only start in a room that brings its own relay. Set up a relay below, or turn off Hide my IP address.')
    expect(v.rootSub).toBe('Hide my IP is on · no relay')
  })
  it('the order is relay server, Spry, the built-in relay, public', () => {
    const all = { builtIn: running, spry: { state: 'paired' as const }, server: { state: 'saved' as const, host: 'a' }, publicRelays: { enabled: true, chosen: true } }
    expect(view(all).winner).toBe('server')
    expect(view({ ...all, server: { state: 'none' } }).winner).toBe('spry')
    expect(view({ ...all, server: { state: 'none' }, spry: { state: 'none' } }).winner).toBe('builtin')
    expect(view({ ...all, server: { state: 'none' }, spry: { state: 'none' }, builtIn: { running: false, rowSub: 'Off' } }).winner).toBe('public')
  })
  it('a built-in relay that is not running is not the winner', () => {
    expect(view({ builtIn: { running: false, rowSub: 'Starting…' } }).head).toBe('Direct only')
  })
  it('CS6: Spry failure, only when Spry carries the calls', () => {
    const failedAt = new Date(2026, 9, 31, 14, 2).getTime()
    const v = view({ spry: { state: 'paired', failedAt } })
    expect(v.failure).toBe("Your Spry node didn't answer at 14:02, so that call had no relay. Check that Spry is running on your node.")
    expect(view({ spry: { state: 'paired', failedAt }, hideIp: true }).failure).toBe("Your Spry node didn't answer at 14:02, so that call couldn't start. Check that Spry is running on your node.")
    expect(view({ spry: { state: 'paired', failedAt }, server: { state: 'saved', host: 'a' } }).failure).toBeUndefined()
  })
})

describe('row second lines (section 6.2)', () => {
  it('Your Spry node', () => {
    expect(view().rows.spry).toBe('Not paired')
    expect(view({ spry: { state: 'paired' } }).rows.spry).toBe('Paired')
    expect(view({ spry: { state: 'paired' }, server: { state: 'saved', host: 'a' } }).rows.spry).toBe('Paired · your relay server comes first')
    const failedAt = new Date(2026, 9, 31, 14, 2).getTime()
    expect(view({ spry: { state: 'paired', failedAt } }).rows.spry).toBe('Paired · no answer at 14:02')
    expect(view({ spry: { state: 'unreadable' } }).rows.spry).toBe("Can't be read · pair again")
  })
  it('Relay server', () => {
    expect(view().rows.server).toBe('Not set up')
    expect(view({ server: { state: 'saved', host: 'relay.example.org' } }).rows.server).toBe('Set up · relay.example.org')
    expect(view({ server: { state: 'unreadable' } }).rows.server).toBe("Can't be read · save it again")
  })
  it('Public call relays', () => {
    expect(view().rows.public).toBe('Off')
    expect(view({ publicRelays: { enabled: true, chosen: false } }).rows.public).toBe('On · none chosen')
    expect(view({ publicRelays: { enabled: true, chosen: true } }).rows.public).toBe('On · one chosen')
    expect(view({ publicRelays: { enabled: true, chosen: true }, server: { state: 'saved', host: 'a' } }).rows.public).toBe('On · not used: you have your own relay')
    expect(view({ publicRelays: { enabled: true, chosen: false }, spry: { state: 'paired' } }).rows.public).toBe('On · not used: you have your own relay')
    expect(view({ publicRelays: { enabled: true, chosen: false }, builtIn: running }).rows.public).toBe('On · not used: you have your own relay')
  })
  it('Advanced', () => {
    expect(view().rows.advanced).toBe('STUN server: Cloudflare')
    expect(view({ stun: 'stun:stun.example.org:3478' }).rows.advanced).toBe('STUN server: stun.example.org')
  })
  it('the built-in row carries the relay page\'s own words, and is absent without it', () => {
    expect(view({ builtIn: running }).rows.builtIn).toBe('On · in use now')
    expect(view().rows.builtIn).toBeUndefined()
  })
})

describe('helpers', () => {
  it('addressHost strips scheme, port, query and brackets', () => {
    expect(addressHost('turn:relay.example.org:3478')).toBe('relay.example.org')
    expect(addressHost('turns:relay.example.org:5349?transport=tcp')).toBe('relay.example.org')
    expect(addressHost('turn:relay.example.org')).toBe('relay.example.org')
    expect(addressHost('stun:[2001:db8::1]:3478')).toBe('2001:db8::1')
    expect(addressHost(undefined)).toBe('')
  })
  it('clockText pads', () => {
    expect(clockText(new Date(2026, 0, 1, 9, 5).getTime())).toBe('09:05')
  })
})
