/**
 * Peer assist: the room's spare uplink comes from the people in it.
 *
 * Opt in, never on by default, and never quietly. Relaying spends this
 * person's bandwidth and battery on somebody else's call, so the only thing
 * that turns it on is them deciding to, and the only defaults here are about
 * whether to put the question in front of them at all.
 *
 * Moved out of main.ts as it stood. The library's own `src/peer-assist.ts`
 * decides; this is the part that measures, asks and says so. It owns the
 * person's choice, what this device is carrying, and the poll that keeps the
 * panel honest. The open connections, the session and the room generation stay
 * in main.ts and are read through the hooks, as in call-agents-hear.ts.
 */
import { ReachabilityProbe } from '../../src/reachability.js'
import { PeerRelay, detectRelayCapability } from '../../src/peer-relay.js'
import {
  ASSIST_STREAMS_PER_PAIR,
  MAX_ASSISTED_PAIRS,
  assistDecision,
  buildAssistOffer,
} from '../../src/peer-assist.js'
import type { AssistBlock, AssistEnvironment } from '../../src/peer-assist.js'
import { UplinkProbe } from '../../src/uplink.js'
import type { StatLike } from '../../src/uplink.js'
import type { AssistOffer } from '../../src/types.js'
import type { RoomSession } from '../../src/index.js'

export interface PeerAssistHooks {
  /** The room on screen, or undefined. */
  session(): RoomSession | undefined
  /** The room the call belongs to: the docked call's, else the one on screen.
   *  Only a session with `canCarry` can be asked to offer help: a room built
   *  chat-only, or one that follows a Bothy route, has no relay registry, so
   *  while one of those is the call's room the panel is not drawn at all. */
  mediaSession(): RoomSession | undefined
  roomGeneration(): number
  /** Every connection currently open, so the uplink probe has something to
   *  sample. Keyed by rung and remote device, because the mesh opens a fresh
   *  connection per rung and the old one lingers until it is closed. Owned by
   *  main.ts, which also uses it for teardown and diagnostics. */
  connections: Map<string, RTCPeerConnection>
  /** Whoever is in the room, by device, so a carried pair can be named rather
   *  than shown as two truncated keys. */
  nameOfDevice(device: string): string
  setStatus(text: string): void
  describeError(err: unknown): string
  setToggle(id: string, on: boolean): void
  /** Whether assist is paused. Defaults to `PEER_ASSIST_PAUSED`; tests of the
   *  control itself pass `() => false`. */
  paused?: () => boolean
}

export interface PeerAssist {
  /** What this device is carrying for other people, if anything. */
  readonly relay: PeerRelay
  /** The offer to publish, or null. Safe to hand out detached: it does not
   *  depend on `this`. */
  offer(): AssistOffer | null
  /** Feed in one gathered ICE candidate for the reachability measurement. */
  noteCandidate(candidate: string): void
  /** A key unique to one connection, for `connections` and `forget`. */
  connectionKey(tier: string, remote: string): string
  /** Stop counting a connection's uplink. */
  forget(key: string): void
  /** Draw the panel. */
  render(): void
  /** A room has opened: start the offer from the person's choice and poll. */
  start(): void
  /** Stop polling, whatever else is open. */
  stop(): void
  /** Stop polling, but only when no room is left on screen. */
  stopIfIdle(): void
  /** Drop the person's choice and be willing to carry again. Does not draw. */
  reset(): void
  /** The person pressed the switch. */
  toggle(): Promise<void>
}

/** True when the platform says this is a phone. `navigator.userAgentData` is
 *  a proper API rather than a user-agent string parse, and where it is absent
 *  the honest answer is "we could not tell" - which `assistDecision` reads as
 *  "do not volunteer this by default". */
function formFactor(): AssistEnvironment['formFactor'] {
  const data = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData
  if (typeof data?.mobile !== 'boolean') return undefined
  return data.mobile ? 'mobile' : 'desktop'
}

/** True when the connection is metered or the person has asked for data
 *  saving. Undefined where the platform will not say. */
function metered(): boolean | undefined {
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; type?: string }
  }).connection
  if (!connection) return undefined
  if (connection.saveData === true) return true
  if (connection.type === 'cellular') return true
  return undefined
}

/**
 * Whether to put the question in front of this person at all.
 *
 * A phone on mobile data is the one case where the control is not shown, only
 * explained. `assistDecision` would still permit it - it is their allowance to
 * spend, and the library does not get to refuse on their behalf - but offering
 * somebody a button that bills them by the byte for a stranger's video is not
 * a question worth asking, and a phone that answers it by accident pays for it.
 *
 * Everywhere else the control appears, always off, with whatever is standing
 * against it written underneath. Where a platform will not say whether it is
 * metered or on battery, that is a thing to tell somebody rather than a thing
 * to assume either way.
 */
function assistOfferable(): boolean {
  return !(formFactor() === 'mobile' && metered() === true)
}

// ---------------------------------------------------------------------------
// Saying what it costs, in numbers that were measured
// ---------------------------------------------------------------------------

export function bitrate(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return 'nothing'
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`
  return `${Math.round(bps / 1000)} kbps`
}

export function quantity(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`
  return `${Math.round(bytes / 1000)} kB`
}

/** Why this device is not being recommended, or cannot help at all, in the
 *  order somebody would want to hear it. `measured` is whether the uplink has
 *  been measured yet and `form` what the platform said it is, both passed in
 *  so this stays a pure function. */
export function blockSentence(block: AssistBlock, measured: boolean, form: AssistEnvironment['formFactor']): string {
  switch (block) {
    case 'no-relay-support':
      return 'This browser cannot pass video on without unpacking it first, so it cannot help anybody. Chrome and Edge can. Safari and Firefox look like they can but have never actually managed it.'
    case 'not-publicly-reachable':
      return 'Other people cannot reach this device directly through your router, going by the addresses it found. Offering to help would point them at a way in that is not there.'
    case 'no-spare-uplink':
      return measured
        ? 'Your connection has nothing left over once your own call is paid for.'
        : 'Your connection has not been measured yet. Join a room, give it a few seconds, and this fills in.'
    case 'mobile':
      return form === undefined
        ? 'This browser will not say whether it is a phone. If it is, leave this off.'
        : 'This is a phone. Helping somebody uses its battery and its signal for as long as they need it.'
    case 'on-battery':
      return 'Running on battery. Helping somebody means sending steadily and working hard, and you will notice.'
    case 'metered':
      return 'This connection is one you pay for by the amount used, or you have asked to save data. Somebody is paying for every byte.'
  }
}

/** Which blocks no amount of willingness can get past. Mirrors the split
 *  `assistDecision` makes, which is not exported as a list. */
const HARD_ASSIST_BLOCKS: readonly AssistBlock[] = ['no-relay-support', 'not-publicly-reachable', 'no-spare-uplink']

/**
 * Peer assist is paused (28 October 2026). The library hands a carried pair
 * to `onRelayStart`, but the app only redraws the indicator there and never
 * pumps the pair's frames, so a volunteer accepted pairs and carried nothing
 * while the pair stopped looking for another route. Until the frame pumps are
 * wired and a route counts only once relayed media arrives, this device
 * neither offers nor asks, and the control is hidden.
 */
export const PEER_ASSIST_PAUSED = true

export function installPeerAssist(hooks: PeerAssistHooks): PeerAssist {
  const paused = hooks.paused ?? (() => PEER_ASSIST_PAUSED)
  /** The person's own choice. Opt in, always - see `assistDecision`. */
  let assistEnabled = false

  /** What this device is carrying for other people, if anything. */
  const peerRelay = new PeerRelay()

  /** Reachability, measured from the candidates this device actually gathers,
   *  never guessed from a user agent. Fed by every connection the mesh opens. */
  const reachability = new ReachabilityProbe()

  /** What this device has spare, measured from its own connections - see
   *  `UplinkProbe`. Nothing else in this file invents a bandwidth figure, and
   *  before this has two samples of something the honest answer is "we have not
   *  measured", which `assistDecision` reads as a refusal. */
  const uplink = new UplinkProbe()

  /** Makes each connection's key its own, so a connection closing can only ever
   *  forget its own measurement. */
  let connectionSeq = 0

  /** Whether this browser can forward encoded frames without decoding them.
   *  Measured against the objects, not the user agent - see
   *  `detectRelayCapability`. Chromium can; Safari and Firefox expose only
   *  `RTCRtpScriptTransform` and have not been measured carrying a frame
   *  through it, so they are read as unable until somebody has. */
  const relayCapability = detectRelayCapability()

  let lastOffering = false
  let assistTimer: ReturnType<typeof setInterval> | undefined

  /** Set from the Battery Status API where it exists. Left undefined where it
   *  does not, which several browsers have removed on privacy grounds. */
  let onBattery: boolean | undefined
  void (async () => {
    const getBattery = (navigator as Navigator & {
      getBattery?: () => Promise<{ charging: boolean; addEventListener(type: string, cb: () => void): void }>
    }).getBattery
    if (!getBattery) return
    try {
      const battery = await getBattery.call(navigator)
      const read = (): void => {
        onBattery = !battery.charging
        renderAssist()
      }
      read()
      battery.addEventListener('chargingchange', read)
    } catch {
      // No answer is a perfectly good answer here - see `assistDecision`.
    }
  })()

  function assistEnvironment(): AssistEnvironment {
    return {
      reachability: reachability.reachability,
      canRelay: relayCapability.canForwardFrames,
      capacity: uplink.capacity(),
      formFactor: formFactor(),
      onBattery,
      metered: metered(),
    }
  }

  function currentAssistOffer(): AssistOffer | null {
    return buildAssistOffer(assistEnvironment(), peerRelay.relaying, assistEnabled)
  }

  /** What one pair costs this device: the pair's media in, and the same back
   *  out again to the far end. */
  function costPerPairBps(): number {
    return uplink.capacity().perPeerBps * ASSIST_STREAMS_PER_PAIR
  }

  /** The one sentence that has to be true: what this costs, per person, right
   *  now, from measurements rather than from a table of typical bitrates. */
  function costSentence(): string {
    const perPair = costPerPairBps()
    if (perPair <= 0) {
      return 'Nothing has been measured yet. Once there is video or sound moving, this will say what helping one pair really costs, instead of guessing.'
    }
    return (
      `About ${bitrate(perPair)} of what you send, for each pair you help, and the same again coming in. ` +
      `Three pairs at full stretch is about ${bitrate(perPair * MAX_ASSISTED_PAIRS)} going out.`
    )
  }

  function sentence(block: AssistBlock): string {
    return blockSentence(block, uplink.measured(), formFactor())
  }

  /**
   * The control and the indicator.
   *
   * Called on every render and on every poll tick, so "you are carrying two
   * people" is on screen within a second or two of becoming true rather than
   * whenever something else happened to redraw.
   */
  function renderAssist(): void {
    const section = document.getElementById('assist')!
    const button = document.getElementById('toggleAssist') as HTMLButtonElement
    const indicator = document.getElementById('assistIndicator')!
    const costNote = document.getElementById('assistCostNote')!

    // Hidden, not disabled, for the same reason as the phone case below: a
    // switch that can never work here is still a switch somebody has to work
    // out. Two ways to have nothing to offer with: no room on screen, or a call
    // whose room was built without the means to carry anybody (chat-only, which
    // includes Bothy rooms). A docked call's own room is judged here, not the
    // chat-only one on screen over it, so the switch stays while docked and
    // goes when the dock ends with a chat-only room left behind.
    if (paused()) { section.hidden = true; return }
    section.hidden = hooks.session() === undefined || !hooks.mediaSession()?.canCarry
    costNote.textContent = costSentence()

    if (!assistOfferable()) {
      // Not a disabled button: a control that cannot be used is still a control
      // somebody has to work out, and this one is never going to be usable here.
      button.hidden = true
      document.getElementById('assistCost')!.hidden = true
      indicator.textContent =
        'Not offered on a phone using mobile data. Helping somebody would spend your data and your battery on their call.'
      indicator.classList.remove('mine')
      return
    }

    button.hidden = false
    document.getElementById('assistCost')!.hidden = false

    const decision = assistDecision(assistEnvironment(), assistEnabled)
    const hard = decision.blocks.filter((block) => HARD_ASSIST_BLOCKS.includes(block))
    const soft = decision.blocks.filter((block) => !HARD_ASSIST_BLOCKS.includes(block))

    button.disabled = hard.length > 0 && !assistEnabled
    hooks.setToggle('toggleAssist', assistEnabled)
    button.setAttribute('aria-pressed', String(assistEnabled))

    if (hard.length > 0) {
      indicator.textContent = hard.map(sentence).join(' ')
      indicator.classList.remove('mine')
      return
    }

    if (!assistEnabled) {
      indicator.textContent = soft.length
        ? soft.map(sentence).join(' ')
        : `Your connection has room to spare, so it could help other people get through. ${costSentence()}`
      indicator.classList.remove('mine')
      return
    }

    const pairs = peerRelay.pairs
    if (pairs.length === 0) {
      indicator.textContent = soft.length
        ? `Offering to help. Nobody has needed it yet. ${soft.map(sentence).join(' ')}`
        : 'Offering to help. Nobody has needed it yet.'
      indicator.classList.remove('mine')
      return
    }

    // Named rather than counted: "carrying Priya and Sam" is a thing somebody
    // can check against the room in front of them, and a number is not.
    const carried = pairs.map((pair) => `${hooks.nameOfDevice(pair.a)} and ${hooks.nameOfDevice(pair.b)}`).join(', ')
    const stats = peerRelay.stats
    indicator.textContent =
      `Helping ${pairs.length} of ${peerRelay.max}: ${carried}. ` +
      `About ${bitrate(costPerPairBps() * pairs.length)} going out, ${quantity(stats.bytesOut)} passed on so far.`
    indicator.classList.add('mine')
  }

  /**
   * Sample every open connection, then say what changed.
   *
   * One `getStats()` per connection per tick and nothing else: no probe
   * traffic, no extra sockets. Two seconds is fast enough that the indicator
   * tracks a call somebody is watching, and slow enough to be free.
   */
  async function pollAssist(): Promise<void> {
    const generation = hooks.roomGeneration()
    const now = Date.now()
    for (const [key, pc] of [...hooks.connections]) {
      if (pc.connectionState === 'closed') {
        hooks.connections.delete(key)
        uplink.forget(key)
        continue
      }
      try {
        const stats: StatLike[] = []
        ;(await pc.getStats()).forEach((stat) => stats.push(stat as StatLike))
        if (generation !== hooks.roomGeneration()) return
        uplink.update(key, stats, now)
      } catch {
        // A connection that will not answer for its own statistics tells us
        // nothing, which is exactly what it contributes until it does.
      }
    }

    // An offer that has gone stale in either direction is the failure this
    // whole module argues against: advertising a capability that is no longer
    // there, or sitting on one that is. Either way the roster is republished
    // and the relay's own gate is brought back into step with it.
    const offering = currentAssistOffer() !== null
    const carrier = hooks.mediaSession()
    // A room that cannot carry is never told about an offer, and `lastOffering`
    // is left alone so a room that can still gets the republish it is owed.
    if (carrier?.canCarry && offering !== lastOffering) {
      lastOffering = offering
      void carrier.setAssist(currentAssistOffer).catch(() => {})
    }
    renderAssist()
  }

  function startAssistPolling(): void {
    if (assistTimer !== undefined) return
    assistTimer = setInterval(() => void pollAssist(), 2000)
  }

  /**
   * Turn carrying on or off.
   *
   * Off is the case that has to work properly. It stops carrying everybody
   * before it stops advertising, so there is no window where the room believes
   * an offer already withdrawn, and the pairs that were being carried fall to
   * the next rung of their own ladder. Nothing about this device's own call
   * changes either way.
   */
  async function toggleAssist(): Promise<void> {
    if (paused() || !assistOfferable()) return
    // The panel is hidden for a call whose room cannot carry, so this is
    // unreachable by hand. It is here so nothing else can reach it either: the
    // choice is not flipped and nothing is published, which keeps a device from
    // advertising help it cannot give.
    const carrier = hooks.mediaSession()
    if (carrier && !carrier.canCarry) return
    assistEnabled = !assistEnabled
    renderAssist()
    try {
      // The call's room, not whichever room is on screen while docked.
      await hooks.mediaSession()?.setAssist(assistEnabled ? currentAssistOffer : null)
      lastOffering = currentAssistOffer() !== null
    } catch (err) {
      hooks.setStatus(hooks.describeError(err))
    }
    renderAssist()
  }

  function stop(): void {
    if (assistTimer !== undefined) clearInterval(assistTimer)
    assistTimer = undefined
  }

  return {
    relay: peerRelay,
    offer: currentAssistOffer,
    noteCandidate: (candidate) => {
      reachability.add({ candidate })
    },
    connectionKey: (tier, remote) => `${tier}:${remote}:${++connectionSeq}`,
    forget: (key) => uplink.forget(key),
    render: renderAssist,
    start: () => {
      // The offer starts at whatever the person has already chosen, which is
      // off unless they turned it on before joining.
      lastOffering = currentAssistOffer() !== null
      startAssistPolling()
    },
    stop,
    stopIfIdle: () => {
      // The timer is device-wide: it only stops when no room is left open.
      if (!hooks.session()) stop()
    },
    reset: () => {
      assistEnabled = false
      lastOffering = false
      peerRelay.reopen()
    },
    toggle: toggleAssist,
  }
}
