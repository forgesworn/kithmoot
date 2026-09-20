import { SlotPeer } from '../src/slot-peer.js'
import type { SlotPeerOptions } from '../src/slot-peer.js'
import type { ChannelClock } from '../src/signal-channel.js'
import type { SignalBody } from '../src/signal.js'
import type { TrackRole } from '../src/types.js'
import { createFakeFactory, fakeTrack, FakeRTCPeerConnection } from './fake-rtc.js'

/**
 * Two profile-2 peers wired to each other over a wire a test can cut.
 *
 * Deliberately not `FakeRtcLink`: that fixture drives a negotiation itself,
 * and what is under test here is precisely who drives it, in which order, and
 * how many times. So the peers negotiate and this only carries - or drops, or
 * duplicates - what they say.
 */

/** The polite side, by pubkey order, and the impolite one. */
export const POLITE = 'a'.repeat(64)
export const IMPOLITE = 'b'.repeat(64)

/** A clock a test turns by hand, for both the reliable channel's backoff and
 *  the peer's own ICE-restart timers. */
export interface TestClock extends ChannelClock {
  advance(ms: number): void
  readonly pending: number
}

export function testClock(): TestClock {
  let now = 0
  let next = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  return {
    now: () => now,
    setTimer(ms: number, run: () => void) {
      const handle = ++next
      timers.set(handle, { at: now + ms, run })
      return handle
    },
    clearTimer(handle: unknown) {
      timers.delete(handle as number)
    },
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        let due: [number, { at: number; run: () => void }] | undefined
        for (const entry of timers) {
          if (entry[1].at > target) continue
          if (!due || entry[1].at < due[1].at) due = entry
        }
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].run()
      }
      now = target
    },
    get pending() {
      return timers.size
    },
  }
}

/** Every microtask and every already-due macrotask, several times over: a
 *  negotiation step is queued behind the last one and each hop is a promise. */
export async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Tracks named by the slot they belong in, so `trackRole` is exact rather
 *  than inferred. */
export function slotTrack(role: TrackRole, tag = '1'): MediaStreamTrack {
  return fakeTrack(role === 'mic' || role === 'screen-audio' ? 'audio' : 'video', `${role}-${tag}`)
}

export const byName: (track: MediaStreamTrack) => TrackRole | undefined = (track) => {
  const id = track.id
  if (id.startsWith('screen-audio')) return 'screen-audio'
  if (id.startsWith('screen')) return 'screen'
  if (id.startsWith('camera')) return 'camera'
  if (id.startsWith('mic')) return 'mic'
  return undefined
}

export interface Sent {
  from: 'polite' | 'impolite'
  body: SignalBody
}

export class SlotPair {
  readonly clock = testClock()
  readonly sent: Sent[] = []
  /** Return true to lose a signal on the wire. */
  cut: (sent: Sent) => boolean = () => false
  readonly polite: SlotPeer
  readonly impolite: SlotPeer
  readonly politeFactory = createFakeFactory()
  readonly impoliteFactory = createFakeFactory()
  readonly downgrades: Sent[] = []
  readonly tracks = new Map<'polite' | 'impolite', { track: MediaStreamTrack; role?: TrackRole }[]>([
    ['polite', []],
    ['impolite', []],
  ])

  constructor(options: Partial<SlotPeerOptions> = {}) {
    this.polite = this.#make('polite', POLITE, IMPOLITE, this.politeFactory, options)
    this.impolite = this.#make('impolite', IMPOLITE, POLITE, this.impoliteFactory, options)
  }

  #make(
    side: 'polite' | 'impolite',
    local: string,
    remote: string,
    factory: ReturnType<typeof createFakeFactory>,
    options: Partial<SlotPeerOptions>,
  ): SlotPeer {
    let n = 0
    return new SlotPeer({
      factory,
      localDevice: local,
      remoteDevice: remote,
      trackRole: byName,
      clock: this.clock,
      random: () => 0.5,
      connectionId: () => `${side === 'polite' ? 'aa' : 'bb'}${String(++n).padStart(14, '0')}`,
      onSignal: (body) => {
        const sent: Sent = { from: side, body }
        this.sent.push(sent)
        if (this.cut(sent)) return
        void this.#other(side).handleSignal(body).catch(() => {})
      },
      onTrack: (track, _receiver, role) => {
        this.tracks.get(side)!.push({ track, role })
      },
      onDowngrade: (body) => this.downgrades.push({ from: side, body }),
      ...options,
    })
  }

  #other(side: 'polite' | 'impolite'): SlotPeer {
    return side === 'polite' ? this.impolite : this.polite
  }

  /** Every connection the two sides have ever built, newest last. */
  connections(side: 'polite' | 'impolite'): FakeRTCPeerConnection[] {
    return side === 'polite' ? this.politeFactory.instances : this.impoliteFactory.instances
  }

  live(side: 'polite' | 'impolite'): FakeRTCPeerConnection {
    const open = this.connections(side).filter((pc) => !pc.closed)
    return open[open.length - 1]!
  }

  of(side: 'polite' | 'impolite'): SlotPeer {
    return side === 'polite' ? this.polite : this.impolite
  }

  /** Signals of these types since the mark, either way. */
  since(mark: number, ...types: SignalBody['type'][]): Sent[] {
    return this.sent.slice(mark).filter((s) => types.length === 0 || types.includes(s.body.type))
  }

  /** Drive both connections to `connected`, as one candidate each way would. */
  async connect(): Promise<void> {
    for (const side of ['polite', 'impolite'] as const) {
      const pc = this.live(side)
      pc.autoConnectOnCandidate = true
      pc.emitCandidate()
    }
    await settle()
    for (const side of ['polite', 'impolite'] as const) this.live(side).setConnectionState('connected')
    await settle()
  }

  close(): void {
    this.polite.close()
    this.impolite.close()
  }
}
