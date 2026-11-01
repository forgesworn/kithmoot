/**
 * The words and the rules for the built-in call relay's page on the desktop
 * app (docs: .claude/handover/k5-relay-settings-spec.md, sections 6 and 9).
 *
 * The page is a function of the main process's state and the last outside
 * check. Everything it says is composed here from codes (`status`, `wanted`,
 * `reason`, `error.code`, `counts`, `control`); the main process's own
 * `reasonText` and `error.message` are for its log and are never shown.
 *
 * Pure: no DOM, no storage. `relay-settings-page.ts` draws what this returns.
 */

/** What the main process reports about the relay (`desktop/relay-host.mjs`, `state()`). */
export interface RelayHostState {
  available: boolean
  blocked?: boolean
  wanted?: boolean
  startOnOpen?: boolean
  /** Bytes relayed today, against `dailyLimit`. */
  today?: number
  dailyLimit?: number
  status: 'off' | 'starting' | 'running' | 'stopping' | 'failed' | 'cannot-host'
  error?: { code?: string }
  reason?: string
  mapping?: { method?: string; allocationPorts?: number; requested?: number; permanent?: boolean; restored?: number }
  counts?: { allocations: number; bytesRelayed: number; lastAllocation?: number | null }
  control?: { relays: number }
  /** 'vpn' while the relay runs at a VPN's port forwarding, not the home router. */
  via?: 'vpn'
  /** Only in a development run with a preview switch: the check to show. */
  preview?: { check?: string }
}

export type RelayCheckKind = 'checking' | 'reachable' | 'same-network' | 'inbound' | 'unreachable' | 'declined' | 'credentials'
  | 'no-answer' | 'left' | 'not-hosting'

/** The last outside check, kept in memory for one run of the relay. */
export interface RelayCheckResult {
  kind: RelayCheckKind
  /** "your other device", or the member's name as the page shows it. */
  who: string
  /** Milliseconds since the epoch. */
  at?: number
  /** The step the check stopped at, for Details. */
  stage?: string
}

export type RelayControl = { kind: 'turn-on' | 'stop' | 'stopping' | 'remove-keys' | 'none'; label: string }

export interface RelayView {
  /** The spec's state id (S1 to S14), for tests and the preview. */
  id: string
  rowSub: string
  line1: string
  line2?: string
  line3?: string
  /** Whether lines 2 and 3 are the running relay's two facts. */
  running: boolean
  control: RelayControl
  /** The Check button, with its label, or undefined. */
  check?: { label: string; disabled: boolean }
  startOnOpenShown: boolean
  startOnOpenChecked: boolean
  /** Details lines; empty when the relay is not running. */
  details: string[]
  note?: string
  /** The rail's Relay on item. */
  indicator: boolean
  /** T-OWNCALLS: shown under the facts while running with a relay server saved. */
  ownCalls?: string
}

export interface RelayViewInput {
  state: RelayHostState | undefined
  /** This account has a Spry node it paired by hand. */
  handPaired: boolean
  check?: RelayCheckResult
  /** A room is open that shares this relay and another device is in it. */
  canCheck: boolean
  /** A relay server is saved on this device, so its own calls use that first. */
  serverSaved?: boolean
  now?: Date
}

const DEVICE = 'computer'
export const T = {
  row: `Call relay on this ${DEVICE}`,
  title: `Call relay on this ${DEVICE}`,
  turnOn: 'Turn on…',
  stop: 'Stop',
  stopping: 'Stopping…',
  check: 'Check from another device…',
  checking: 'Checking…',
  startOnOpen: 'Start it when KithMoot opens',
  details: 'Details',
  intro: `When two people can't connect directly, a call relay passes their encrypted audio and video along. Turn this on to let people in rooms you made use this ${DEVICE} as their relay. It uses your upload bandwidth while they're on a call, and they'll see your internet address. You run it, and you can stop it at any time.`,
  noteOn: "People in rooms you made use this relay when they can't connect directly. In other rooms, turn on Share my call relay here in the room's Privacy and connection. They see your internet address.",
  off: 'Off',
  offStartsOnOpen: 'Off. It starts next time KithMoot opens.',
  starting: 'Starting…',
  startingNext: 'Setting up your router. This can take up to a minute.',
  running: `Running on this ${DEVICE}`,
  runningNoControl: 'Running, waiting for your Nostr relays',
  runningNoControlNext: 'Nobody can use it until KithMoot reaches at least one of your Nostr relays.',
  waiting: 'Waiting for a network',
  waitingNext: `It starts when this ${DEVICE} is back online.`,
  cant: "Can't run on this network",
  cantRetry: `It tries again when this ${DEVICE} joins another network.`,
  crashed: 'The relay stopped unexpectedly',
  crashedNext: 'Starting it again…',
  stoppedHead: 'Stopped',
  crashedTwice: 'The relay stopped unexpectedly twice, so it was left off.',
  crashedTwiceNext: 'Turn it on again to try once more. If it keeps stopping, restart KithMoot.',
  startFailed: "The relay couldn't start.",
  retry: 'Try turning it on again.',
  helper: 'Part of KithMoot that runs the relay is missing or damaged.',
  helperNext: 'Reinstall KithMoot from kithmoot.app, then try again.',
  exited: 'The relay stopped unexpectedly.',
  keys: "The relay's saved keys couldn't be read. This happens after switching between builds of KithMoot.",
  removeKeys: 'Remove keys…',
  stopSlow: 'Still stopping',
  stopSlowNext: "The relay hasn't stopped yet. Press Stop again.",
  limit: 'Paused for today',
  limitNext: 'It starts again after midnight.',
  spry: 'You already use your own Spry relay',
  spryNext: `Your calls go through your Spry node, so this ${DEVICE}'s relay stays off. To use this one instead, unpair your Spry node first.`,
  noAccount: "Start or open a room first, so the relay knows whose rooms it serves.",
  otherAccount: `This ${DEVICE}'s relay is set up for another account you use here. Switch to that account to use it.`,
  noControl: 'None of your Nostr relays can carry requests for the call relay. Add one whose address starts with wss:// and uses a domain name, in Nostr relays.',
  ownCalls: "Your own calls use your relay server, which comes first. People in your rooms can still use this relay.",
  indicator: 'Relay on',
  indicatorName: 'Call relay on',
} as const

/** Section 6.5: why this network cannot host. One table; unknown codes get the last line. */
export const CANNOT_HOST_WORDS: Readonly<Record<string, string>> = Object.freeze({
  'no-gateway': `This ${DEVICE} has no route to the internet.`,
  vpn: "A VPN is on. People can't reach a relay behind it.",
  'wrong-interface': `This ${DEVICE} reaches its router through another connection. It tries again once the network settles.`,
  'no-answer': "Your router didn't allow automatic setup. Turn on UPnP in its settings, or ask whoever runs your network.",
  refused: 'Your router refused to open what the relay needs.',
  failed: "Your router couldn't open what the relay needs.",
  'carrier-grade-nat': `Your internet provider shares one address between many customers, so nothing outside can reach this ${DEVICE}.`,
  'double-nat': "There's a second router between you and the internet. Automatic setup can't open it.",
  'unusable-address': "Your router reported an internet address people can't reach.",
  'too-few-ports': 'Your router opened too little for the relay to work.',
  record: "The relay couldn't save its list of router openings, so it gave them back.",
  expired: "Your router dropped the relay and wouldn't take it back.",
})
const CANNOT_HOST_UNKNOWN = "This network can't host a call relay."
export function cannotHostWords(reason: string | undefined): string {
  return reason !== undefined && Object.hasOwn(CANNOT_HOST_WORDS, reason) ? CANNOT_HOST_WORDS[reason]! : CANNOT_HOST_UNKNOWN
}

/** The notice before Turn on. The approved wording of 30 October 2026 (T-ON-NOTICE). */
// K5 NOTICE SLOT: the approved notice (design 3.5, G7). One constant, so a change of wording is a one-line swap.
export const RELAY_TURN_ON_NOTICE = (limit: string): string =>
  `People in rooms you made, and rooms where you share it, can send their encrypted calls through this ${DEVICE} when they can't connect directly. They'll see your internet address. It uses your upload bandwidth, up to ${limit} a day. KithMoot asks your router to open what the relay needs and closes it again when the relay stops. You run this relay and can stop it at any time. Check that the laws that apply to you and your internet provider's terms allow it.`

export const T_ON_HIDEIP = "Hide my IP address doesn't hide your address from people who use your relay."

/** The Turn on dialog's words. The notice, and the extra line when Hide my IP is on, are one message of two paragraphs. */
export function turnOnDialog(dailyLimit: number | undefined, hideIp: boolean): { title: string; message: string; confirmLabel: string; cancelLabel: string } {
  const notice = RELAY_TURN_ON_NOTICE(formatBytes(dailyLimit ?? DEFAULT_LIMIT))
  return {
    title: `Turn on the call relay on this ${DEVICE}?`,
    message: hideIp ? `${notice}\n\n${T_ON_HIDEIP}` : notice,
    confirmLabel: 'Turn on',
    cancelLabel: 'Cancel',
  }
}

export const REMOVE_KEYS_DIALOG = {
  title: "Remove the relay's saved keys?",
  message: 'The relay starts afresh with new keys. People will use its new address the next time they open your rooms.',
  confirmLabel: 'Remove keys',
} as const

export const CHECK_DIALOG = {
  title: 'Check from another device',
  confirmLabel: 'Check',
  cancelLabel: 'Cancel',
  legend: 'Device to check from',
  self: 'Your other device',
  body: (room: string) => `Pick someone in ${room}. Their device connects to your relay once and tells you whether it got through. Your relay sees their internet address, as it would on a call. For your phone, turn its Wi-Fi off first.`,
} as const

const DEFAULT_LIMIT = 5_000_000_000

/** Decimal units, en-GB: "0 MB", "under 1 MB", "300 MB", "1.2 GB", "5 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  if (bytes < 1_000_000) return 'under 1 MB'
  const megabytes = Math.round(bytes / 1_000_000)
  if (megabytes < 1000) return `${megabytes} MB`
  return `${(bytes / 1_000_000_000).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 1 })} GB`
}

const pad = (value: number) => String(value).padStart(2, '0')
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
/** "at 14:02", or "yesterday at 14:02" once the run has crossed midnight. */
export function whenText(at: number, now: Date = new Date()): string {
  const date = new Date(at)
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return sameDay(date, now) ? `at ${clock}` : `yesterday at ${clock}`
}

/** Section 6.3. */
export function reachableLine(check: RelayCheckResult | undefined, canCheck: boolean, now: Date = new Date()): string {
  if (!check) return canCheck ? 'Not checked from outside yet'
    : 'Not checked from outside yet. To check, open a room you made that your phone or a friend is in.'
  const when = check.at === undefined ? '' : whenText(check.at, now)
  switch (check.kind) {
    case 'checking': return `Checking from ${check.who}…`
    case 'reachable': return `Reachable, checked from ${check.who} ${when}`
    case 'same-network': return `Not proved yet: ${check.who} is on the same network as this ${DEVICE}. Check from a device on another network, such as your phone with Wi-Fi off.`
    case 'inbound': return `Opened on your router, but people still can't reach it (checked from ${check.who} ${when})`
    case 'unreachable': return `Can't be reached from ${check.who}'s network (checked ${when})`
    case 'declined': return `${check.who} couldn't check just now. Try again in a minute, or pick someone else.`
    case 'credentials': return `Your relay didn't let ${check.who} in, so nothing was checked. Ask them to open the room again, then check again.`
    case 'no-answer': return `No answer from ${check.who}. Check that KithMoot is open on that device.`
    case 'left': return `${check.who} has left the room. Pick someone else.`
    case 'not-hosting': return "Your relay isn't shared in this room, so nobody here can check it."
  }
}

/** What the page keeps from a host's reply (`RelayTestOutcome` in relay-outside-test.ts). */
export function checkFromOutcome(outcome: { answered: boolean; ok?: boolean; stage?: string; sameNetwork?: true; at?: number }, who: string, now: number): RelayCheckResult {
  if (!outcome.answered) return { kind: 'no-answer', who, at: now }
  const at = now
  if (outcome.ok) return outcome.sameNetwork ? { kind: 'same-network', who, at } : { kind: 'reachable', who, at }
  if (outcome.sameNetwork) return { kind: 'same-network', who, at, ...(outcome.stage ? { stage: outcome.stage } : {}) }
  switch (outcome.stage) {
    case 'inbound': return { kind: 'inbound', who, at, stage: 'inbound' }
    case 'declined': return { kind: 'declined', who, at, stage: 'declined' }
    case 'credentials': return { kind: 'credentials', who, at, stage: 'credentials' }
    default: return { kind: 'unreachable', who, at, ...(outcome.stage ? { stage: outcome.stage } : {}) }
  }
}

/** Section 6.4. Only while running. */
export function useLine(state: RelayHostState, now: Date = new Date()): string {
  const limit = formatBytes(state.dailyLimit ?? DEFAULT_LIMIT)
  const today = formatBytes(state.today ?? 0)
  const counts = state.counts
  const relayed = `Relayed today: ${today} of ${limit}`
  if (counts && counts.allocations > 0) return `In use now · ${relayed}`
  if (counts?.lastAllocation) return `Last used ${whenText(counts.lastAllocation * 1000, now)} · ${relayed}`
  return `Not used yet · ${relayed}`
}

const METHODS: Record<string, string> = { upnp: 'UPnP', pcp: 'PCP', natpmp: 'NAT-PMP' }

/** Section 6.7. The only place router words appear. */
export function detailLines(state: RelayHostState, check: RelayCheckResult | undefined, now: Date = new Date()): string[] {
  const lines: string[] = []
  const { mapping, control, counts } = state
  const vpn = state.via === 'vpn'
  if (vpn) lines.push(`Runs through your VPN's port forwarding. People reach it at the VPN's address, not your home's.`)
  if (mapping?.method && Object.hasOwn(METHODS, mapping.method)) lines.push(`${vpn ? 'VPN' : 'Router'}: opened automatically using ${METHODS[mapping.method]}`)
  if (mapping && Number.isFinite(mapping.allocationPorts) && Number.isFinite(mapping.requested)) lines.push(`Openings on your ${vpn ? 'VPN' : 'router'}: ${mapping.allocationPorts} of ${mapping.requested}`)
  if (mapping?.permanent) lines.push('Your router only offers permanent openings. If KithMoot crashes they stay open until it next starts, when it removes them.')
  if (mapping?.restored && mapping.restored > 0) lines.push(`Your router dropped ${mapping.restored} ${mapping.restored === 1 ? 'opening' : 'openings'}; the relay put ${mapping.restored === 1 ? 'it' : 'them'} back.`)
  if (control) lines.push(`Nostr relays: ${control.relays > 0 ? 'connected' : 'not connected yet'}`)
  if (counts) {
    lines.push(`Connections now: ${counts.allocations}`)
    lines.push(`Relayed since it started: ${formatBytes(counts.bytesRelayed)}`)
  }
  lines.push(`Daily limit: ${formatBytes(state.dailyLimit ?? DEFAULT_LIMIT)}. When it's reached, the relay pauses until midnight.`)
  if (check && check.stage && !['reachable', 'checking'].includes(check.kind) && check.at !== undefined) {
    lines.push(`Last check: from ${check.who} ${whenText(check.at, now)}, stopped at the ${check.stage} step`)
  }
  return lines
}

/** Which of the spec's states (6.2) the main process's report is. */
export function relayScreen(state: RelayHostState, handPaired: boolean): string {
  const wanted = state.wanted === true
  if (state.blocked || state.status === 'stopping') return 'S12'
  switch (state.status) {
    case 'starting': return 'S3'
    case 'running':
      if (state.control && state.control.relays <= 0) return 'S14'
      return (state.counts?.allocations ?? 0) > 0 ? 'S5' : 'S4'
    case 'cannot-host': return wanted ? 'S7' : 'S7x'
    case 'failed': {
      switch (state.error?.code) {
        case 'ERR_NO_NETWORK': return wanted ? 'S11' : 'S8g'
        case 'ERR_RELAY_EXITED': return wanted ? 'S8a' : 'S8f'
        case 'ERR_CRASHED_TWICE': return 'S8b'
        case 'ERR_START_FAILED': return 'S8c'
        case 'ERR_HELPER': return 'S8d'
        case 'ERR_STOP_TIMEOUT': return 'S8e'
        case 'ERR_DAILY_LIMIT': return 'S9'
        case 'ERR_HAND_PAIRED': return 'S10a'
        case 'ERR_NO_ACCOUNT': return 'S10b'
        case 'ERR_OTHER_ACCOUNT': return 'S10c'
        case 'ERR_NO_CONTROL_RELAYS': return 'S10d'
        case 'ERR_IDENTITY': return 'S8h'
        default: return 'S8g'
      }
    }
    default:
      if (wanted) return 'S11'
      if (handPaired) return 'S10a'
      return state.startOnOpen ? 'S13' : 'S1'
  }
}

const ROW_SUB: Record<string, string> = {
  S1: 'Off', S10b: 'Off', S10c: 'Off', S10d: 'Off', S13: 'Off · starts when KithMoot opens',
  S3: 'Starting…', S4: 'On', S5: 'On · in use now', S14: 'On · waiting for Nostr relays',
  S11: 'Waiting for a network', S7: "Can't run on this network", S7x: "Can't run on this network",
  S8a: 'Restarting…', S8b: 'Stopped', S8c: 'Stopped', S8d: 'Stopped', S8f: 'Stopped', S8g: 'Stopped', S8h: 'Stopped',
  S8e: 'Stopping…', S12: 'Stopping…', S9: 'Paused until midnight', S10a: 'Not used: you have Spry',
}

const TURN_ON: RelayControl = { kind: 'turn-on', label: T.turnOn }
const STOP: RelayControl = { kind: 'stop', label: T.stop }
const NONE: RelayControl = { kind: 'none', label: '' }

/** Lines 1 to 3 and the control for the states that are not running. */
function plainLines(id: string, state: RelayHostState): { line1: string; line2?: string; line3?: string; control: RelayControl } {
  const limit = formatBytes(state.dailyLimit ?? DEFAULT_LIMIT)
  switch (id) {
    case 'S1': return { line1: T.off, line2: T.intro, control: TURN_ON }
    case 'S13': return { line1: T.offStartsOnOpen, line2: T.intro, control: TURN_ON }
    case 'S3': return { line1: T.starting, line2: T.startingNext, control: STOP }
    case 'S11': return { line1: T.waiting, line2: T.waitingNext, control: STOP }
    case 'S7': return { line1: T.cant, line2: cannotHostWords(state.reason), line3: T.cantRetry, control: STOP }
    case 'S7x': return { line1: T.cant, line2: cannotHostWords(state.reason), control: TURN_ON }
    case 'S8a': return { line1: T.crashed, line2: T.crashedNext, control: STOP }
    case 'S8b': return { line1: T.stoppedHead, line2: T.crashedTwice, line3: T.crashedTwiceNext, control: TURN_ON }
    case 'S8c': return { line1: T.stoppedHead, line2: T.startFailed, line3: T.retry, control: TURN_ON }
    case 'S8d': return { line1: T.stoppedHead, line2: T.helper, line3: T.helperNext, control: TURN_ON }
    case 'S8e': return { line1: T.stopSlow, line2: T.stopSlowNext, control: STOP }
    case 'S8f': return { line1: T.stoppedHead, line2: T.exited, line3: T.retry, control: TURN_ON }
    case 'S8h': return { line1: T.stoppedHead, line2: T.keys, control: { kind: 'remove-keys', label: T.removeKeys } }
    case 'S9': return { line1: T.limit, line2: `Today's limit of ${limit} is used up.`, line3: T.limitNext, control: STOP }
    case 'S10a': return { line1: T.spry, line2: T.spryNext, control: NONE }
    case 'S10b': return { line1: T.stoppedHead, line2: T.noAccount, control: TURN_ON }
    case 'S10c': return { line1: T.stoppedHead, line2: T.otherAccount, control: TURN_ON }
    case 'S10d': return { line1: T.stoppedHead, line2: T.noControl, control: TURN_ON }
    case 'S12': return { line1: T.stopping, control: { kind: 'stopping', label: T.stopping } }
    default: return { line1: T.stoppedHead, line2: T.startFailed, line3: T.retry, control: TURN_ON }
  }
}

/** The whole page for one report. Undefined until the first report arrives. */
export function relayView(input: RelayViewInput): RelayView | undefined {
  const { state, handPaired, check, canCheck } = input
  if (!state || !state.available) return undefined
  const now = input.now ?? new Date()
  const id = relayScreen(state, handPaired)
  const running = id === 'S4' || id === 'S5' || id === 'S14'
  const startOnOpenChecked = state.startOnOpen === true
  if (!running) {
    const lines = plainLines(id, state)
    return {
      id, rowSub: ROW_SUB[id] ?? 'Stopped', ...lines, running: false,
      startOnOpenShown: lines.control.kind === 'stop' || lines.control.kind === 'stopping' || (startOnOpenChecked && id !== 'S10a'),
      startOnOpenChecked, details: [], indicator: id === 'S3',
    }
  }
  const use = useLine(state, now)
  const checking = check?.kind === 'checking'
  const noControl = id === 'S14'
  return {
    id, rowSub: ROW_SUB[id]!, running: true,
    line1: noControl ? T.runningNoControl : T.running,
    line2: noControl ? T.runningNoControlNext : reachableLine(check, canCheck, now),
    line3: use,
    control: STOP,
    ...(!noControl && (canCheck || checking) ? { check: { label: checking ? T.checking : T.check, disabled: checking } } : {}),
    startOnOpenShown: true, startOnOpenChecked,
    details: detailLines(state, check, now),
    note: T.noteOn,
    indicator: true,
    ...(input.serverSaved ? { ownCalls: T.ownCalls } : {}),
  }
}

/** The preview switch's check names (KITHMOOT_DESKTOP_RELAY_PREVIEW_CHECK) as the page's results. */
export function previewCheck(name: string | undefined, now: number): RelayCheckResult | undefined {
  const who = 'your other device'
  switch (name) {
    case 'reachable': return { kind: 'reachable', who, at: now }
    case 'same-network': return { kind: 'same-network', who, at: now }
    case 'inbound': return { kind: 'inbound', who, at: now, stage: 'inbound' }
    case 'allocate': return { kind: 'unreachable', who, at: now, stage: 'allocate' }
    case 'declined': return { kind: 'declined', who, at: now, stage: 'declined' }
    case 'credentials': return { kind: 'credentials', who, at: now, stage: 'credentials' }
    case 'noanswer': return { kind: 'no-answer', who, at: now }
    default: return undefined
  }
}
