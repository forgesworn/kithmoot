/**
 * The words on Settings › Calls: how this device's calls connect, and what each
 * row under "Relays for your calls" says about itself
 * (.claude/handover/design-connections-calls.md, sections 4.2, 6.1, 6.2 and 9).
 *
 * Pure: no DOM, no storage. `main.ts` reads the settings, passes them in, and
 * draws what comes back, so the summary is computed from the same facts a call
 * is built from and cannot say one thing while a call does another.
 *
 * The order a call tries things in, after a direct connection fails: the relay
 * server, then your Spry (a paired node, or this computer's own relay while it
 * runs, never both), then a relay the room brings, then a public relay. The
 * room's relay is a property of the room, so it is a sentence on the page and
 * never the winner here.
 */

export type CallWinner = 'builtin' | 'spry' | 'server' | 'public' | 'default'

export interface CallPathInput {
  /** The built-in relay on this computer, absent where this device cannot host (a browser). */
  builtIn?: { running: boolean; rowSub: string }
  /** The Spry node paired by hand. `failedAt` is the last time its credential request failed this run. */
  spry: { state: 'none' | 'paired' | 'unreadable'; failedAt?: number }
  /** The relay server saved on this device. `host` is its first address's host. */
  server: { state: 'none' | 'saved' | 'unreadable'; host?: string }
  publicRelays: { enabled: boolean; chosen: boolean }
  /** The first address of the STUN server set on this device, if any. */
  stun?: string
  hideIp: boolean
  /** This deployment offers automatic TURN credentials for default rooms. */
  defaultRelay?: boolean
}

export interface CallPathView {
  winner: CallWinner | undefined
  head: string
  body: string
  /** CS6: shown as a third line when Spry is the relay in use and its last request failed. */
  failure?: string
  /** The second line of the Settings list's Calls row. */
  rootSub: string
  rows: { builtIn?: string; spry: string; server: string; public: string; advanced: string }
}

export const T_CALLS = {
  title: 'Calls',
  section: 'Relays for your calls',
  builtInRow: 'Call relay on this computer',
  spryRow: 'Your Spry node',
  serverRow: 'Relay server',
  publicRow: 'Public call relays',
  hideIp: 'Hide my IP address on calls',
  hideIpNote: "Calls always go through a relay, so people on the call don't see your IP address. Calls can be slower, and KithMoot asks before using a relay someone in the room runs.",
  roomsNote: "Rooms can bring their own relay, named in the room's link or shared by a member. Your calls use it when none of yours is in use, and before any public relay.",
  advanced: 'Advanced',
  rootNoRelay: 'Hide my IP is on · no relay',
} as const

const NAMES: Record<CallWinner, string> = {
  builtin: "this computer's relay",
  spry: 'your Spry node',
  server: 'your relay server',
  public: 'a public relay',
  default: 'the default call relay',
}

const pad = (value: number): string => String(value).padStart(2, '0')
/** "14:02". */
export function clockText(at: number): string {
  const date = new Date(at)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The host of a turn:, turns:, stun: or stuns: address: no scheme, port or query. Empty when there is none. */
export function addressHost(address: string | undefined): string {
  if (!address) return ''
  const rest = address.trim().replace(/^[a-z]+:/i, '').replace(/\?.*$/, '').replace(/^\/\//, '')
  const bracketed = /^\[([^\]]+)\]/.exec(rest)
  if (bracketed) return bracketed[1]!
  return rest.split(':')[0] ?? ''
}

/** CS6. */
export function spryFailureLine(at: number, hideIp: boolean): string {
  return `Your Spry node didn't answer at ${clockText(at)}, so ${hideIp ? "that call couldn't start" : 'that call had no relay'}. Check that Spry is running on your node.`
}

export function callPathView(input: CallPathInput): CallPathView {
  const { builtIn, spry, server, publicRelays, hideIp } = input
  const builtInRunning = builtIn?.running === true
  // Whatever a person set for themselves keeps the public relays out of it,
  // and an unreadable saving is treated as set, as the join does.
  const own = server.state !== 'none' || spry.state !== 'none' || builtInRunning
  const winner: CallWinner | undefined = server.state === 'saved' ? 'server'
    : spry.state === 'paired' ? 'spry'
    : builtInRunning ? 'builtin'
    : publicRelays.enabled && publicRelays.chosen && !own ? 'public'
    : input.defaultRelay && !own ? 'default'
    : undefined
  const name = winner ? NAMES[winner] : undefined

  let head: string
  let body: string
  if (hideIp) {
    if (winner) {
      head = `Always through ${name}`
      body = "Hide my IP address is on, so calls never connect directly. People on the call don't see your IP address."
    } else {
      head = 'No relay for calls'
      body = 'Hide my IP address is on, so a call can only start in a room that brings its own relay. Set up a relay below, or turn off Hide my IP address.'
    }
  } else if (!winner) {
    head = 'Direct only'
    body = "Calls connect device to device. Some networks block that, so a call may not connect. Set up a relay below to carry those calls."
  } else if (winner === 'default') {
    head = 'Direct, with automatic relay fallback'
    body = 'Calls try a direct connection, then use the default call relay when the network needs it. You do not need to set anything up. A relay you choose below takes priority.'
  } else if (winner === 'public') {
    head = 'Direct, or through a public relay'
    body = "Calls connect device to device when they can. When they can't, they go through the public call relay you chose, unless the room brings its own."
  } else {
    head = `Direct, or through ${name}`
    body = `Calls connect device to device when they can. When they can't, they go through ${name}.`
  }

  const failure = winner === 'spry' && spry.failedAt !== undefined ? spryFailureLine(spry.failedAt, hideIp) : undefined

  const spryRow = spry.state === 'unreadable' ? "Can't be read · pair again"
    : spry.state === 'none' ? 'Not paired'
    : server.state === 'saved' ? 'Paired · your relay server comes first'
    : spry.failedAt !== undefined ? `Paired · no answer at ${clockText(spry.failedAt)}`
    : 'Paired'
  const serverRow = server.state === 'unreadable' ? "Can't be read · save it again"
    : server.state === 'none' ? 'Not set up'
    : server.host ? `Set up · ${server.host}` : 'Set up'
  const publicRow = !publicRelays.enabled ? 'Off'
    : own ? 'On · not used: you have your own relay'
    : publicRelays.chosen ? 'On · one chosen'
    : 'On · none chosen'
  const advanced = `STUN server: ${input.stun ? addressHost(input.stun) || 'set' : 'Google, Cloudflare'}`

  const rows: CallPathView['rows'] = { spry: spryRow, server: serverRow, public: publicRow, advanced }
  if (builtIn) rows.builtIn = builtIn.rowSub

  return { winner, head, body, ...(failure ? { failure } : {}), rootSub: head === 'No relay for calls' ? T_CALLS.rootNoRelay : head, rows }
}
