// No jsdom in this workspace's vitest config (environment: 'node'), so the
// panel is drawn onto plain objects standing in for the five elements it
// touches, behind a stubbed `document.getElementById`. The hooks are fakes
// too: what is pinned here is which session the switch publishes to, what the
// panel says, and when the timer runs. The browser side is test/peer-assist.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomSession } from '../../src/index.js'
import { bitrate, blockSentence, installPeerAssist, quantity } from './call-assist.js'
import type { PeerAssistHooks } from './call-assist.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

const NO_RELAY = 'This browser cannot pass video on without unpacking it first, so it cannot help anybody. Chrome and Edge can. Safari and Firefox look like they can but have never actually managed it.'
const NOT_REACHABLE = 'Other people cannot reach this device directly through your router, going by the addresses it found. Offering to help would point them at a way in that is not there.'
const NOT_MEASURED = 'Your connection has not been measured yet. Join a room, give it a few seconds, and this fills in.'
const NOTHING_MEASURED_COST = 'Nothing has been measured yet. Once there is video or sound moving, this will say what helping one pair really costs, instead of guessing.'

interface FakeElement {
  hidden: boolean
  disabled: boolean
  textContent: string
  attributes: Record<string, string>
  classes: Set<string>
  setAttribute(name: string, value: string): void
  classList: { add(name: string): void; remove(name: string): void }
}

function fakeElement(): FakeElement {
  const element: FakeElement = {
    hidden: false,
    disabled: false,
    textContent: '',
    attributes: {},
    classes: new Set(),
    setAttribute: (name, value) => {
      element.attributes[name] = value
    },
    classList: {
      add: (name) => void element.classes.add(name),
      remove: (name) => void element.classes.delete(name),
    },
  }
  return element
}

type FakeSession = RoomSession & { setAssist: ReturnType<typeof vi.fn> }

/** `canCarry` is what `RoomSession` reports: true for a room built with a relay
 *  registry, false for a chat-only one (which a Bothy room always is). */
function fakeSession(canCarry = true): FakeSession {
  return { canCarry, setAssist: vi.fn().mockResolvedValue(undefined) } as unknown as FakeSession
}

/** A connection whose statistics grow by `bytesPerPoll` each time they are asked for. */
function fakeConnection(bytesPerPoll: number, availableOutgoingBitrate: number) {
  let bytesSent = 0
  const getStats = vi.fn(async () => {
    const report = new Map<string, unknown>([
      ['out', { type: 'outbound-rtp', bytesSent }],
      ['pair', { type: 'candidate-pair', state: 'succeeded', availableOutgoingBitrate }],
    ])
    bytesSent += bytesPerPoll
    return report
  })
  return { connectionState: 'connected', getStats } as unknown as RTCPeerConnection & { getStats: typeof getStats }
}

let elements: Record<'assist' | 'toggleAssist' | 'assistIndicator' | 'assistCost' | 'assistCostNote', FakeElement>
let onScreen: RoomSession | undefined
let inCall: RoomSession | undefined
let generation: number
let setStatus: ReturnType<typeof vi.fn>
let setToggle: ReturnType<typeof vi.fn>
let connections: Map<string, RTCPeerConnection>

function hooks(): PeerAssistHooks {
  return {
    session: () => onScreen,
    mediaSession: () => inCall,
    roomGeneration: () => generation,
    connections,
    nameOfDevice: (device) => (device === A ? 'Priya' : device === B ? 'Sam' : device),
    setStatus: setStatus as unknown as PeerAssistHooks['setStatus'],
    describeError: (err) => (err instanceof Error ? err.message : String(err)),
    setToggle: setToggle as unknown as PeerAssistHooks['setToggle'],
    paused: () => false,
  }
}

/** What a desktop Chromium on an open network looks like to the module. */
function stubCapableDesktop(): void {
  vi.stubGlobal('RTCRtpSender', class { createEncodedStreams(): void {} })
  vi.stubGlobal('RTCRtpReceiver', class { createEncodedStreams(): void {} })
  vi.stubGlobal('navigator', { userAgentData: { mobile: false } })
}

beforeEach(() => {
  elements = {
    assist: fakeElement(),
    toggleAssist: fakeElement(),
    assistIndicator: fakeElement(),
    assistCost: fakeElement(),
    assistCostNote: fakeElement(),
  }
  vi.stubGlobal('document', { getElementById: (id: string) => (elements as Record<string, FakeElement>)[id] ?? null })
  vi.stubGlobal('navigator', {})
  onScreen = fakeSession()
  inCall = fakeSession()
  generation = 1
  setStatus = vi.fn()
  setToggle = vi.fn()
  connections = new Map()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the figures', () => {
  it('bitrate names nothing, kbps and Mbps', () => {
    expect(bitrate(0)).toBe('nothing')
    expect(bitrate(-5)).toBe('nothing')
    expect(bitrate(Number.NaN)).toBe('nothing')
    expect(bitrate(999)).toBe('1 kbps')
    expect(bitrate(640_000)).toBe('640 kbps')
    expect(bitrate(1_000_000)).toBe('1.0 Mbps')
    expect(bitrate(4_250_000)).toBe('4.3 Mbps')
  })

  it('quantity names kB, MB and GB', () => {
    expect(quantity(0)).toBe('0 kB')
    expect(quantity(1_499)).toBe('1 kB')
    expect(quantity(2_000_000)).toBe('2 MB')
    expect(quantity(2_500_000_000)).toBe('2.5 GB')
  })

  it('blockSentence reads the measured and form factor it is given', () => {
    expect(blockSentence('no-relay-support', false, undefined)).toBe(NO_RELAY)
    expect(blockSentence('not-publicly-reachable', false, undefined)).toBe(NOT_REACHABLE)
    expect(blockSentence('no-spare-uplink', false, 'desktop')).toBe(NOT_MEASURED)
    expect(blockSentence('no-spare-uplink', true, 'desktop')).toBe('Your connection has nothing left over once your own call is paid for.')
    expect(blockSentence('mobile', true, undefined)).toBe('This browser will not say whether it is a phone. If it is, leave this off.')
    expect(blockSentence('mobile', true, 'mobile')).toBe('This is a phone. Helping somebody uses its battery and its signal for as long as they need it.')
    expect(blockSentence('on-battery', true, 'desktop')).toBe('Running on battery. Helping somebody means sending steadily and working hard, and you will notice.')
    expect(blockSentence('metered', true, 'desktop')).toBe('This connection is one you pay for by the amount used, or you have asked to save data. Somebody is paying for every byte.')
  })
})

describe('the panel', () => {
  it('on a browser that cannot relay, says why in the hard blocks, in order, and disables the switch', () => {
    const assist = installPeerAssist(hooks())
    assist.render()

    expect(elements.assist.hidden).toBe(false)
    expect(elements.toggleAssist.hidden).toBe(false)
    expect(elements.assistCost.hidden).toBe(false)
    expect(elements.toggleAssist.disabled).toBe(true)
    expect(elements.toggleAssist.attributes['aria-pressed']).toBe('false')
    expect(setToggle).toHaveBeenLastCalledWith('toggleAssist', false)
    expect(elements.assistIndicator.textContent).toBe([NO_RELAY, NOT_REACHABLE, NOT_MEASURED].join(' '))
    expect(elements.assistIndicator.classes.has('mine')).toBe(false)
    expect(elements.assistCostNote.textContent).toBe(NOTHING_MEASURED_COST)
  })

  it('is hidden while no room is on screen', () => {
    const assist = installPeerAssist(hooks())
    onScreen = undefined
    assist.render()
    expect(elements.assist.hidden).toBe(true)
  })

  it('is explained, not offered, on a phone using mobile data', () => {
    vi.stubGlobal('navigator', { userAgentData: { mobile: true }, connection: { type: 'cellular' } })
    const assist = installPeerAssist(hooks())
    assist.render()

    expect(elements.toggleAssist.hidden).toBe(true)
    expect(elements.assistCost.hidden).toBe(true)
    expect(elements.assistIndicator.textContent).toBe(
      'Not offered on a phone using mobile data. Helping somebody would spend your data and your battery on their call.',
    )
  })

  it('on a capable, measured desktop, invites the person and states the measured cost', async () => {
    vi.useFakeTimers()
    stubCapableDesktop()
    const assist = installPeerAssist(hooks())
    assist.noteCandidate('candidate:1 1 udp 1686052607 93.184.216.34 54321 typ srflx raddr 93.184.216.34 rport 54321')
    connections.set('direct:x:1', fakeConnection(500_000, 20_000_000))
    assist.start()
    await vi.advanceTimersByTimeAsync(4000)

    expect(elements.toggleAssist.disabled).toBe(false)
    expect(elements.assistIndicator.textContent).toBe(
      'Your connection has room to spare, so it could help other people get through. ' +
        'About 4.0 Mbps of what you send, for each pair you help, and the same again coming in. ' +
        'Three pairs at full stretch is about 12.0 Mbps going out.',
    )
    expect(elements.assistIndicator.classes.has('mine')).toBe(false)
  })

  it('once on, says nobody has needed it, then names the pair it carries and what that costs', async () => {
    vi.useFakeTimers()
    stubCapableDesktop()
    const assist = installPeerAssist(hooks())
    assist.noteCandidate('candidate:1 1 udp 1686052607 93.184.216.34 54321 typ srflx raddr 93.184.216.34 rport 54321')
    connections.set('direct:x:1', fakeConnection(500_000, 20_000_000))
    assist.start()
    await vi.advanceTimersByTimeAsync(4000)

    await assist.toggle()
    expect(elements.toggleAssist.attributes['aria-pressed']).toBe('true')
    expect(setToggle).toHaveBeenLastCalledWith('toggleAssist', true)
    expect(elements.assistIndicator.textContent).toBe('Offering to help. Nobody has needed it yet.')

    expect(assist.relay.admit(A, B)).not.toBeNull()
    assist.render()
    expect(elements.assistIndicator.textContent).toBe(
      'Helping 1 of 3: Priya and Sam. About 4.0 Mbps going out, 0 kB passed on so far.',
    )
    expect(elements.assistIndicator.classes.has('mine')).toBe(true)
  })
})

describe('a room that cannot carry', () => {
  it('hides the panel when the call is in a chat-only room, and does not offer', async () => {
    const chatOnly = fakeSession(false)
    onScreen = chatOnly
    inCall = chatOnly
    const assist = installPeerAssist(hooks())
    assist.render()
    expect(elements.assist.hidden).toBe(true)

    await assist.toggle()
    assist.render()

    expect(chatOnly.setAssist).not.toHaveBeenCalled()
    // The person's choice is not flipped by a press that went nowhere.
    expect(elements.toggleAssist.attributes['aria-pressed']).toBe('false')
    expect(elements.assist.hidden).toBe(true)
  })

  it('keeps the panel for a docked call whose room can carry, over a chat-only room on screen', async () => {
    const chatOnly = fakeSession(false)
    const docked = fakeSession(true)
    onScreen = chatOnly
    inCall = docked
    const assist = installPeerAssist(hooks())
    assist.render()
    expect(elements.assist.hidden).toBe(false)

    await assist.toggle()

    // The docked call's room is the one asked, never the chat-only one.
    expect(docked.setAssist).toHaveBeenCalledTimes(1)
    expect(docked.setAssist).toHaveBeenLastCalledWith(expect.any(Function))
    expect(chatOnly.setAssist).not.toHaveBeenCalled()
    expect(elements.toggleAssist.attributes['aria-pressed']).toBe('true')
  })

  it('hides the panel and publishes nothing once the dock ends with the chat-only room still on screen', async () => {
    vi.useFakeTimers()
    stubCapableDesktop()
    const chatOnly = fakeSession(false)
    const docked = fakeSession(true)
    onScreen = chatOnly
    inCall = docked
    const assist = installPeerAssist(hooks())
    assist.noteCandidate('candidate:1 1 udp 1686052607 93.184.216.34 54321 typ srflx raddr 93.184.216.34 rport 54321')
    const pc = fakeConnection(500_000, 20_000_000)
    connections.set('direct:x:1', pc)
    assist.start()
    await vi.advanceTimersByTimeAsync(4000)
    await assist.toggle()
    assist.render()
    expect(elements.assist.hidden).toBe(false)
    expect(assist.offer()).not.toBeNull()
    expect(docked.setAssist).toHaveBeenCalledTimes(1)

    // The dock ends. Taking the carried pairs down and the choice back is
    // main.ts's job and is deliberately not done here, so that what holds the
    // line below is the room being unable to carry, not a tidy-up that happened
    // to have run: the offer is still on, and the room is no longer the call's.
    inCall = chatOnly
    ;(pc as unknown as { connectionState: string }).connectionState = 'closed'
    await vi.advanceTimersByTimeAsync(2000)

    // Nothing is carried and nothing measured, so the offer would be withdrawn
    // by a room that could carry; this one is not told either way.
    expect(assist.offer()).toBeNull()
    expect(chatOnly.setAssist).not.toHaveBeenCalled()
    expect(docked.setAssist).toHaveBeenCalledTimes(1)
    expect(elements.assist.hidden).toBe(true)

    await assist.toggle()
    expect(chatOnly.setAssist).not.toHaveBeenCalled()
  })

  it('leaves lastOffering alone, so a room that can carry is still told when it comes back', async () => {
    vi.useFakeTimers()
    stubCapableDesktop()
    const chatOnly = fakeSession(false)
    const carrying = fakeSession(true)
    onScreen = carrying
    inCall = carrying
    const assist = installPeerAssist(hooks())
    assist.noteCandidate('candidate:1 1 udp 1686052607 93.184.216.34 54321 typ srflx raddr 93.184.216.34 rport 54321')
    const pc = fakeConnection(500_000, 20_000_000)
    connections.set('direct:x:1', pc)
    assist.start()
    await vi.advanceTimersByTimeAsync(4000)
    await assist.toggle()
    carrying.setAssist.mockClear()

    // The connection goes quiet while the call is somewhere that cannot carry,
    // and the offer lapses. The chat-only room hears nothing about it.
    inCall = chatOnly
    ;(pc as unknown as { connectionState: string }).connectionState = 'closed'
    await vi.advanceTimersByTimeAsync(2000)
    expect(chatOnly.setAssist).not.toHaveBeenCalled()

    // Back in a room that can carry, the lapse is reported once.
    inCall = carrying
    await vi.advanceTimersByTimeAsync(2000)
    expect(carrying.setAssist).toHaveBeenCalledTimes(1)
    expect(chatOnly.setAssist).not.toHaveBeenCalled()
  })
})

describe('the switch', () => {
  it("publishes to the call's room, never the room on screen", async () => {
    const assist = installPeerAssist(hooks())
    const media = inCall as unknown as { setAssist: ReturnType<typeof vi.fn> }
    const screen = onScreen as unknown as { setAssist: ReturnType<typeof vi.fn> }

    await assist.toggle()
    expect(media.setAssist).toHaveBeenCalledTimes(1)
    expect(media.setAssist).toHaveBeenLastCalledWith(expect.any(Function))
    expect(screen.setAssist).not.toHaveBeenCalled()

    await assist.toggle()
    expect(media.setAssist).toHaveBeenCalledTimes(2)
    expect(media.setAssist).toHaveBeenLastCalledWith(null)
    expect(screen.setAssist).not.toHaveBeenCalled()
  })

  it('does nothing to a call that is not there, and still draws', async () => {
    const assist = installPeerAssist(hooks())
    inCall = undefined
    await assist.toggle()
    expect(elements.toggleAssist.attributes['aria-pressed']).toBe('true')
  })

  it('says so in the status line when publishing fails', async () => {
    const assist = installPeerAssist(hooks())
    ;(inCall as unknown as { setAssist: ReturnType<typeof vi.fn> }).setAssist.mockRejectedValueOnce(new Error('no route'))
    await assist.toggle()
    expect(setStatus).toHaveBeenCalledWith('no route')
  })

  it('is not pressed on a phone using mobile data', async () => {
    vi.stubGlobal('navigator', { userAgentData: { mobile: true }, connection: { saveData: true } })
    const assist = installPeerAssist(hooks())
    await assist.toggle()
    expect((inCall as unknown as { setAssist: ReturnType<typeof vi.fn> }).setAssist).not.toHaveBeenCalled()
  })
})

describe('reset', () => {
  it('drops the choice, and the next render shows it off', async () => {
    const assist = installPeerAssist(hooks())
    await assist.toggle()
    expect(elements.toggleAssist.attributes['aria-pressed']).toBe('true')

    assist.reset()
    // Resetting alone draws nothing: resetRoomState never did.
    expect(elements.toggleAssist.attributes['aria-pressed']).toBe('true')

    assist.render()
    expect(elements.toggleAssist.attributes['aria-pressed']).toBe('false')
    expect(setToggle).toHaveBeenLastCalledWith('toggleAssist', false)
  })

  it('opens the relay again after it was closed, so the next room can carry', () => {
    const assist = installPeerAssist(hooks())
    assist.relay.close()
    expect(assist.relay.closed).toBe(true)
    assist.reset()
    expect(assist.relay.closed).toBe(false)
    expect(assist.relay.admit(A, B)).not.toBeNull()
  })

  it('is what ending a docked call does: close, reset, draw, then the timer only if idle', async () => {
    vi.useFakeTimers()
    const assist = installPeerAssist(hooks())
    await assist.toggle()
    assist.start()
    assist.relay.admit(A, B)

    assist.relay.close()
    assist.reset()
    assist.render()
    assist.stopIfIdle()

    expect(assist.relay.pairs).toHaveLength(0)
    expect(assist.relay.closed).toBe(false)
    expect(elements.toggleAssist.attributes['aria-pressed']).toBe('false')
    // A room is still on screen, so the timer was left running.
    expect(vi.getTimerCount()).toBe(1)
  })
})

describe('the timer', () => {
  it('survives stopIfIdle while a room is open, and stops when none is', async () => {
    vi.useFakeTimers()
    const assist = installPeerAssist(hooks())
    const pc = fakeConnection(0, 0)
    connections.set('direct:x:1', pc)

    assist.start()
    assist.start() // a second start must not add a second timer
    expect(vi.getTimerCount()).toBe(1)

    assist.stopIfIdle()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(pc.getStats).toHaveBeenCalledTimes(1)

    onScreen = undefined
    assist.stopIfIdle()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(6000)
    expect(pc.getStats).toHaveBeenCalledTimes(1)
  })

  it('stop ends it whatever is on screen, and start can begin it again', async () => {
    vi.useFakeTimers()
    const assist = installPeerAssist(hooks())
    assist.start()
    assist.stop()
    expect(vi.getTimerCount()).toBe(0)
    assist.stop()
    assist.start()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('forgets a connection that has closed, and draws on every tick', async () => {
    vi.useFakeTimers()
    const assist = installPeerAssist(hooks())
    const closed = { connectionState: 'closed', getStats: vi.fn() } as unknown as RTCPeerConnection
    connections.set('direct:x:1', closed)
    assist.start()
    elements.assistIndicator.textContent = 'stale'
    await vi.advanceTimersByTimeAsync(2000)

    expect(connections.size).toBe(0)
    expect(closed.getStats).not.toHaveBeenCalled()
    expect(elements.assistIndicator.textContent).not.toBe('stale')
  })

  it('leaves the offer alone when the room moved on while a connection was answering', async () => {
    vi.useFakeTimers()
    const assist = installPeerAssist(hooks())
    await assist.toggle()
    const media = inCall as unknown as { setAssist: ReturnType<typeof vi.fn> }
    media.setAssist.mockClear()
    connections.set('direct:x:1', {
      connectionState: 'connected',
      getStats: async () => {
        generation += 1
        return new Map()
      },
    } as unknown as RTCPeerConnection)
    elements.assistIndicator.textContent = 'untouched'
    assist.start()
    await vi.advanceTimersByTimeAsync(2000)

    expect(media.setAssist).not.toHaveBeenCalled()
    expect(elements.assistIndicator.textContent).toBe('untouched')
  })
})

describe('connection keys', () => {
  it('are unique per connection, so one closing forgets only its own measurement', () => {
    const assist = installPeerAssist(hooks())
    expect(assist.connectionKey('direct', 'dev')).toBe('direct:dev:1')
    expect(assist.connectionKey('direct', 'dev')).toBe('direct:dev:2')
    expect(assist.connectionKey('turn', 'other')).toBe('turn:other:3')
  })
})

describe('while peer assist is paused', () => {
  it('hides the control and ignores a press, by default', async () => {
    const { paused: _ignored, ...rest } = hooks()
    const assist = installPeerAssist(rest)
    onScreen = fakeSession()
    assist.render()
    expect(document.getElementById('assist')!.hidden).toBe(true)
    await assist.toggle()
    expect(assist.offer()).toBeNull()
  })
})
