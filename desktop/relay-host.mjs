import { createSocket } from 'node:dgram'
import { isIPv4 } from 'node:net'
import { controlRelayList, pairingPublicKey } from './relay-identity.mjs'
import { createRelaySupervisor } from './relay-supervisor.mjs'
import { DAILY_LIMIT_BYTES, defaultSettings, localDay } from './relay-settings.mjs'

/**
 * The built-in call relay as the main process drives it: the saved identity,
 * this computer's address on its network, and one supervised `spry-node` run
 * at a time (docs/design/2026-10-28-built-in-relay.md, 1.3).
 *
 * It keeps the shape the window, quit and update flows in main.mjs already
 * use (`state`, `present`, `stop`, `resume`). Nothing here is shown to people
 * yet: the only way in is a development dialog, enabled with
 * KITHMOOT_DESKTOP_RELAY=on, until the settings screen (K5) has had the
 * owner's review.
 */

const HEX64 = /^[0-9a-f]{64}$/
const messages = {
  ERR_NO_ACCOUNT: 'Open KithMoot with an account before turning on the call relay.',
  ERR_HAND_PAIRED: 'This account already uses a Spry node it was paired with, so the call relay on this computer stays off.',
  ERR_OTHER_ACCOUNT: 'The call relay on this computer belongs to another account.',
  ERR_NO_CONTROL_RELAYS: 'None of your Nostr relays can carry call relay requests (they must be wss:// addresses on a domain name).',
  ERR_NO_NETWORK: 'This computer is not connected to a network.',
  ERR_HELPER: 'The call relay is missing from this install or does not match it.',
  ERR_DAILY_LIMIT: "Today's relay allowance is used up. It can start again tomorrow.",
  ERR_CRASHED_TWICE: 'The call relay stopped unexpectedly twice, so it was left off.',
  ERR_START_FAILED: 'The call relay could not start.',
  ERR_STOP_TIMEOUT: 'The call relay has not exited.',
}
function hostError(code) { return Object.assign(new Error(messages[code]), { code }) }

/** Plain words for the node's reasons a network cannot host (design, 2.4). */
export const CANNOT_HOST_TEXT = Object.freeze({
  'no-gateway': 'This computer has no route to the internet.',
  vpn: "A VPN is on. People can't reach a relay behind it.",
  'wrong-interface': 'This computer reaches its router through another connection. Try again once the network settles.',
  'no-answer': "Your router didn't allow automatic setup. Turn on UPnP in its settings, or ask whoever runs your network.",
  refused: 'Your router refused to open the ports the relay needs.',
  failed: 'Your router could not open the ports the relay needs.',
  'carrier-grade-nat': 'Your internet provider shares one address between many customers, so nothing outside can reach this computer.',
  'double-nat': "There's a second router between you and the internet. Automatic setup can't open it.",
  'unusable-address': "Your router reported an internet address people can't reach.",
  'too-few-ports': 'Your router opened too few ports for the relay.',
  record: "The relay couldn't save its list of router ports, so it gave them back.",
  expired: 'Your router dropped the relay and would not take it back.',
})

/**
 * This computer's address on the network its default route uses. A UDP
 * socket connected to a documentation address (192.0.2.1) takes the address
 * the operating system would send from; connecting a UDP socket sends nothing.
 */
export function defaultRouteAddress({ create = createSocket } = {}) {
  return new Promise((resolve, reject) => {
    let socket
    try { socket = create('udp4') } catch { reject(hostError('ERR_NO_NETWORK')); return }
    const done = (error, address) => { try { socket.close() } catch { /* Already closed. */ } if (error) reject(error); else resolve(address) }
    socket.once('error', () => done(hostError('ERR_NO_NETWORK')))
    try {
      socket.connect(9, '192.0.2.1', () => {
        let address
        try { ({ address } = socket.address()) } catch { /* Checked below. */ }
        const [a, b] = typeof address === 'string' && isIPv4(address) ? address.split('.').map(Number) : [0]
        if (!a || a === 127 || a >= 224 || (a === 169 && b === 254)) done(hostError('ERR_NO_NETWORK'))
        else done(undefined, address)
      })
    } catch { done(hostError('ERR_NO_NETWORK')) }
  })
}

/** Up to four of the person's relays that can carry `spry:` control. */
export function pickControlRelays(urls) {
  const out = []
  for (const url of Array.isArray(urls) ? urls : []) {
    if (out.length === 4) break
    try {
      const [normal] = controlRelayList([url])
      if (!out.includes(normal)) out.push(normal)
    } catch { /* Not usable for control: skip it. */ }
  }
  return out
}

/** What the renderer last said about the account on screen. */
export function sanitiseRelayContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const participant = typeof value.participant === 'string' && HEX64.test(value.participant) ? value.participant : undefined
  const relays = Array.isArray(value.relays) ? value.relays.filter(url => typeof url === 'string' && url.length <= 512).slice(0, 32) : []
  return { participant, relays, handPaired: value.handPaired === true }
}

export function createRelayHost({ enabled, identity, settings, executable, createSupervisor = createRelaySupervisor,
  localAddress = defaultRouteAddress, showDialog, changed = () => {}, now = () => new Date(), timers = globalThis,
  crashRestartMs = 10_000, networkPollMs = 15_000, wakeWaitMs = 120_000, dailyLimit = DAILY_LIMIT_BYTES }) {
  const available = enabled === true
  let supervisor
  let status = { status: 'off' }
  let owner
  let context
  let generation = 0
  let blocked = false
  let starting
  let stopping
  let presenting
  // Whether the person wants the relay on: set by Turn on or Start it when
  // KithMoot opens, cleared only by their own Stop. Sleep, quit and updates
  // stop the relay without changing it, so waking brings the relay back.
  let wanted = false
  let crashRestarted = false
  let crashTimer
  let networkTimer
  let lastAddress
  let openTried = false
  let prefs
  let runBytes = 0
  let savedAt = 0
  const visible = () => {
    const { status: phase, error, reason, mapping, counts, control, urls, allocationPorts, local } = status
    return { status: phase, ...(error ? { error } : {}), ...(reason ? { reason, reasonText: CANNOT_HOST_TEXT[reason] } : {}),
      ...(mapping ? { mapping } : {}), ...(counts ? { counts } : {}), ...(control ? { control } : {}),
      ...(urls ? { urls } : {}), ...(allocationPorts !== undefined ? { allocationPorts } : {}), ...(local ? { local } : {}) }
  }
  const today = () => {
    const day = localDay(now())
    return { day, bytes: prefs?.day === day ? prefs.dayBytes : 0 }
  }
  const state = () => ({ available, blocked, wanted, startOnOpen: prefs?.startOnOpen === true, today: today().bytes, dailyLimit, ...visible() })
  const publish = next => { status = next; changed(state()) }
  const fail = (code, message) => publish({ status: 'failed', error: { code, message: message ?? messages[code] } })
  async function loadPrefs() {
    if (!prefs) prefs = settings ? await settings.load() : defaultSettings()
    return prefs
  }
  async function savePrefs() {
    savedAt = now().getTime()
    try { await settings?.save(prefs) } catch { /* Counted again from the next status line. */ }
  }
  /**
   * The pairing the renderer uses for this computer's own relay, exactly as it
   * would use a claimed one, plus the local listener its own device must use
   * (a router without NAT loopback drops what is sent to its own public
   * address). Only while the relay runs.
   */
  function pairing() {
    if (status.status !== 'running' || !owner || !status.endpoint || !status.pairing || !status.local) return undefined
    return { v: 1, endpoint: status.endpoint, id: status.pairing, secretKey: owner.pairingSecret, participant: owner.participant,
      local: { ...status.local } }
  }
  function setContext(value) {
    const next = sanitiseRelayContext(value)
    if (!next) return
    context = next
    if (available && next.participant && !openTried) {
      openTried = true
      void loadPrefs().then(loaded => { if (loaded.startOnOpen && !wanted) void start({ person: true }) })
    }
  }
  async function setStartOnOpen(on) {
    await loadPrefs()
    prefs = { ...prefs, startOnOpen: on === true }
    await savePrefs()
    changed(state())
  }
  /** Relayed bytes from a status line, against today's limit. */
  function count(next) {
    if (!next.counts) return
    const delta = Math.max(0, next.counts.bytesRelayed - runBytes)
    runBytes = next.counts.bytesRelayed
    if (!prefs || !delta) return
    const { day, bytes } = today()
    prefs = { ...prefs, day, dayBytes: bytes + delta }
    const over = prefs.dayBytes >= dailyLimit
    if (over || now().getTime() - savedAt > 30_000) void savePrefs()
    if (over) void halt().then(() => fail('ERR_DAILY_LIMIT'))
  }
  function watchNetwork() {
    if (networkTimer || !available) return
    networkTimer = timers.setInterval(async () => {
      if (!wanted || blocked) return
      let address
      try { address = await localAddress() } catch { address = undefined }
      const changedNetwork = address !== lastAddress
      lastAddress = address
      if (!changedNetwork || starting || stopping) return
      // A new network: stop forwarding on the old one, and try this one.
      if (supervisor) await halt()
      if (address && wanted && !blocked) void start()
    }, networkPollMs)
  }
  function unwatchNetwork() {
    if (networkTimer) timers.clearInterval(networkTimer)
    networkTimer = undefined
  }
  function onRunState(active, next) {
    if (supervisor !== active) return
    count(next)
    // A run that ended by itself leaves its words on show and lets the
    // person start again; a stop in progress finishes in halt().
    if (!['failed', 'cannot-host'].includes(next.status) || stopping) { publish(next); return }
    supervisor = undefined
    if (next.status === 'failed' && next.error?.code === 'ERR_RELAY_EXITED' && wanted) {
      if (!crashRestarted) {
        crashRestarted = true
        publish(next)
        crashTimer = timers.setTimeout(() => { crashTimer = undefined; if (wanted && !blocked && !supervisor) void start() }, crashRestartMs)
        return
      }
      wanted = false
      unwatchNetwork()
      fail('ERR_CRASHED_TWICE')
      return
    }
    publish(next)
  }
  /**
   * Turn the relay on. `person: true` is the person's own Turn on (or their
   * Start it when KithMoot opens): it marks the relay wanted and resets the
   * one automatic restart after a crash.
   */
  async function start({ person = false } = {}) {
    if (!available || blocked || starting || supervisor) return starting
    if (person) { wanted = true; crashRestarted = false }
    if (crashTimer) { timers.clearTimeout(crashTimer); crashTimer = undefined }
    if (wanted) watchNetwork()
    const token = generation
    starting = (async () => {
      let active
      try {
        const current = context
        if (!current?.participant) throw hostError('ERR_NO_ACCOUNT')
        if (current.handPaired) throw hostError('ERR_HAND_PAIRED')
        await loadPrefs()
        if (today().bytes >= dailyLimit) throw hostError('ERR_DAILY_LIMIT')
        publish({ status: 'starting' })
        let saved = await identity.load()
        if (saved && saved.participant !== current.participant) throw hostError('ERR_OTHER_ACCOUNT')
        if (!saved) {
          const relays = pickControlRelays(current.relays)
          if (!relays.length) throw hostError('ERR_NO_CONTROL_RELAYS')
          saved = await identity.create({ participant: current.participant, controlRelays: relays })
        }
        let path
        try { path = await executable() } catch { throw hostError('ERR_HELPER') }
        const bind = await localAddress()
        lastAddress = bind
        if (token !== generation || blocked) { publish({ status: 'off' }); return }
        owner = saved
        runBytes = 0
        active = createSupervisor({ executable: path, onState: next => onRunState(active, next) })
        supervisor = active
        await active.start({ turnSecret: saved.turnSecret, pairingPublicKey: pairingPublicKey(saved.pairingSecret),
          stateFile: identity.stateFile, controlRelays: saved.controlRelays, bind, listenPort: saved.listenPort })
        if (token !== generation || blocked) await halt()
      } catch (error) {
        if (!active) {
          fail(error?.code ?? 'ERR_START_FAILED', error?.code ? error.message : 'The call relay could not start.')
        } else if (supervisor === active) {
          // The supervisor published its own reason; keep it on show.
          const finished = active.state()
          if (['failed', 'cannot-host'].includes(finished.status)) { supervisor = undefined; publish(finished) }
          else await halt()
        }
      } finally { starting = undefined }
    })()
    return starting
  }
  /** Stop the run without changing whether the person wants the relay. */
  async function halt({ block = false } = {}) {
    generation++
    if (block) blocked = true
    if (crashTimer) { timers.clearTimeout(crashTimer); crashTimer = undefined }
    changed(state())
    if (stopping) return stopping
    const active = supervisor
    if (!active) { if (!['failed', 'cannot-host'].includes(status.status)) publish({ status: 'off' }); return true }
    stopping = (async () => {
      try {
        await active.stop()
        if (supervisor === active) { supervisor = undefined; publish({ status: 'off' }) }
        if (prefs && settings) await savePrefs()
        return true
      } catch {
        fail('ERR_STOP_TIMEOUT')
        return false
      } finally { stopping = undefined }
    })()
    return stopping
  }
  /**
   * `stop()` is the person's own Stop: the relay stays off until they turn it
   * on again. `stop({ block: true })` is the app's (sleep, closing, quitting,
   * installing an update): the relay is held off until `resume`.
   */
  async function stop({ block = false } = {}) {
    if (!block) { wanted = false; unwatchNetwork() }
    return halt({ block })
  }
  /** Lift a blocking stop. With `restart`, a relay the person wanted on
   *  starts again once this computer has a network (after sleep, a cancelled
   *  quit or a failed update). */
  async function resume({ restart = false } = {}) {
    const operation = halt({ block: true })
    const token = generation
    const stopped = await operation
    if (!stopped || token !== generation) return stopped
    blocked = false
    changed(state())
    if (restart && wanted) void startWhenOnline(token)
    return stopped
  }
  async function startWhenOnline(token) {
    const deadline = now().getTime() + wakeWaitMs
    for (;;) {
      if (token !== generation || blocked || !wanted || supervisor || starting) return
      try { await localAddress(); break } catch { /* No network yet. */ }
      if (now().getTime() >= deadline) { fail('ERR_NO_NETWORK'); return }
      await new Promise(resolve => timers.setTimeout(resolve, 5000))
    }
    if (token === generation && !blocked && wanted) await start()
  }
  function describe() {
    const lines = []
    const view = visible()
    if (view.mapping) lines.push(`Router: opened by ${({ pcp: 'PCP', natpmp: 'NAT-PMP', upnp: 'UPnP' })[view.mapping.method]}, ${view.mapping.allocationPorts} of ${view.mapping.requested} call ports${view.mapping.permanent ? ' (permanent: a crash may leave them open until KithMoot next starts)' : ''}${view.mapping.restored ? `, ${view.mapping.restored} put back after the router dropped them` : ''}.`)
    if (view.control) lines.push(view.control.relays ? 'Reachable over your Nostr relays.' : 'Not connected to your Nostr relays yet.')
    if (view.counts) lines.push(`In use: ${view.counts.allocations} now; ${view.counts.bytesRelayed.toLocaleString('en-GB')} bytes relayed since it started.`)
    lines.push(`Relayed today: ${today().bytes.toLocaleString('en-GB')} of ${dailyLimit.toLocaleString('en-GB')} bytes.`)
    return lines.join('\n')
  }
  async function ask(options) {
    await loadPrefs()
    const answer = await showDialog({ ...options, checkboxLabel: 'Start it when KithMoot opens', checkboxChecked: prefs.startOnOpen })
    if (typeof answer?.checkboxChecked === 'boolean' && answer.checkboxChecked !== prefs.startOnOpen) await setStartOnOpen(answer.checkboxChecked)
    return answer ?? { response: 0 }
  }
  /** Development dialog only: start, see and stop the relay. */
  async function present() {
    if (presenting || !available) return presenting
    const token = generation
    presenting = (async () => {
      try {
        const view = visible()
        if (supervisor && ['starting', 'running', 'stopping'].includes(view.status)) {
          const { response } = await ask({ message: `Call relay on this computer: ${({ starting: 'Starting', running: 'Running', stopping: 'Stopping' })[view.status]}`,
            detail: describe() || 'Waiting for the router and your Nostr relays.', buttons: ['Close', 'Stop'], defaultId: 0, cancelId: 0 })
          if (response === 1 && token === generation) await stop()
          return
        }
        if (blocked) return
        if (view.status === 'failed' && view.error?.code === 'ERR_IDENTITY') {
          // Keys this build cannot read (another build's keychain entry, a
          // damaged file) can only be replaced, which gives the relay a new
          // address: rooms get its new offer as they open.
          const { response } = await showDialog({ type: 'warning', message: "The call relay's saved keys could not be read",
            detail: 'This happens after switching between builds of KithMoot. Remove them to start the relay afresh with new keys. People will use its new address the next time they open your rooms.',
            buttons: ['Cancel', 'Remove keys'], defaultId: 0, cancelId: 0 })
          if (response === 1 && token === generation && !blocked && !supervisor) {
            await identity.remove()
            publish({ status: 'off' })
          }
          return
        }
        const failure = view.status === 'cannot-host' ? view.reasonText ?? 'This network cannot host a call relay.' : view.status === 'failed' ? view.error?.message : undefined
        const { response } = await ask({ type: 'warning', message: failure ? 'The call relay stopped' : 'Turn on the call relay on this computer? (development build)',
          detail: `${failure ? `${failure}\n\n` : ''}When two people can't connect directly, a call relay passes their encrypted audio and video along. People in your rooms can use this computer as their relay. It uses your upload bandwidth while they're on a call, up to ${(dailyLimit / 1e9).toLocaleString('en-GB')} GB a day, and they'll see your internet address. KithMoot asks your router to open the ports it needs and closes them when the relay stops. It stops when KithMoot closes and while this computer sleeps. You run it, and you can stop it at any time.`,
          buttons: ['Cancel', failure ? 'Try again' : 'Turn on'], defaultId: 0, cancelId: 0 })
        if (response !== 1 || token !== generation || blocked) return
        await start({ person: true })
      } finally { presenting = undefined }
    })()
    return presenting
  }
  return { state, pairing, setContext, setStartOnOpen, start, stop, resume, present }
}

/** Cancellation invalidates an outstanding stop before it can reissue Quit. */
export function createHostingQuitGuard({ stop, quit, failed }) {
  let epoch = 0
  let quitting = false
  let confirmed = false
  function cancel() { epoch++; quitting = false; confirmed = false }
  async function request() {
    if (quitting || confirmed) return false
    const token = ++epoch
    quitting = true
    const stopped = await stop({ block: true })
    if (token !== epoch) return false
    if (!stopped) { cancel(); await failed(); return false }
    confirmed = true
    quit()
    return true
  }
  return { request, cancel, get quitting() { return quitting }, get confirmed() { return confirmed } }
}
