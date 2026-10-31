import { describe, expect, it } from 'vitest'
import {
  CANNOT_HOST_WORDS, RELAY_TURN_ON_NOTICE, checkFromOutcome, cannotHostWords, formatBytes, previewCheck, reachableLine, relayScreen,
  relayView, turnOnDialog, useLine, whenText, type RelayCheckResult, type RelayHostState,
} from './relay-words.js'

const NOW = new Date(2026, 9, 30, 15, 0)
const AT = new Date(2026, 9, 30, 14, 2).getTime()
const base: RelayHostState = { available: true, wanted: false, startOnOpen: false, today: 0, dailyLimit: 5_000_000_000, status: 'off' }
const running: RelayHostState = { ...base, wanted: true, status: 'running', control: { relays: 2 }, counts: { allocations: 0, bytesRelayed: 0, lastAllocation: null },
  mapping: { method: 'upnp', allocationPorts: 10, requested: 10, permanent: false, restored: 0 } }
const view = (state: RelayHostState, extra: { handPaired?: boolean; check?: RelayCheckResult; canCheck?: boolean } = {}) =>
  relayView({ state, handPaired: extra.handPaired ?? false, check: extra.check, canCheck: extra.canCheck ?? false, now: NOW })!

describe('relay page states (spec 6.2)', () => {
  const failed = (code: string, wanted = false): RelayHostState => ({ ...base, wanted, status: 'failed', error: { code } })
  const rows: Array<[string, RelayHostState, boolean, string, string | undefined, string | undefined, string, string, string]> = [
    // id, state, handPaired, line1, line2, line3, control, label, row
    ['S1', base, false, 'Off', undefined, undefined, 'turn-on', 'Turn on…', 'Off'],
    ['S13', { ...base, startOnOpen: true }, false, 'Off. It starts next time KithMoot opens.', undefined, undefined, 'turn-on', 'Turn on…', 'Off · starts when KithMoot opens'],
    ['S3', { ...base, wanted: true, status: 'starting' }, false, 'Starting…', 'Setting up your router. This can take up to a minute.', undefined, 'stop', 'Stop', 'Starting…'],
    ['S4', running, false, 'Running on this computer', 'Not checked from outside yet. To check, open a room you made that your phone or a friend is in.', 'Not used yet · Relayed today: 0 MB of 5 GB', 'stop', 'Stop', 'On'],
    ['S5', { ...running, today: 1_200_000_000, counts: { allocations: 3, bytesRelayed: 5, lastAllocation: null } }, false, 'Running on this computer', undefined, 'In use now · Relayed today: 1.2 GB of 5 GB', 'stop', 'Stop', 'On · in use now'],
    ['S14', { ...running, control: { relays: 0 } }, false, 'Running, waiting for your Nostr relays', 'Nobody can use it until KithMoot reaches at least one of your Nostr relays.', 'Not used yet · Relayed today: 0 MB of 5 GB', 'stop', 'Stop', 'On · waiting for Nostr relays'],
    ['S11', { ...base, wanted: true }, false, 'Waiting for a network', 'It starts when this computer is back online.', undefined, 'stop', 'Stop', 'Waiting for a network'],
    ['S11', failed('ERR_NO_NETWORK', true), false, 'Waiting for a network', 'It starts when this computer is back online.', undefined, 'stop', 'Stop', 'Waiting for a network'],
    ['S7', { ...base, wanted: true, status: 'cannot-host', reason: 'vpn' }, false, "Can't run on this network", "A VPN is on. People can't reach a relay behind it.", 'It tries again when this computer joins another network.', 'stop', 'Stop', "Can't run on this network"],
    ['S7x', { ...base, status: 'cannot-host', reason: 'vpn' }, false, "Can't run on this network", "A VPN is on. People can't reach a relay behind it.", undefined, 'turn-on', 'Turn on…', "Can't run on this network"],
    ['S8a', failed('ERR_RELAY_EXITED', true), false, 'The relay stopped unexpectedly', 'Starting it again…', undefined, 'stop', 'Stop', 'Restarting…'],
    ['S8b', failed('ERR_CRASHED_TWICE'), false, 'Stopped', 'The relay stopped unexpectedly twice, so it was left off.', 'Turn it on again to try once more. If it keeps stopping, restart KithMoot.', 'turn-on', 'Turn on…', 'Stopped'],
    ['S8c', failed('ERR_START_FAILED'), false, 'Stopped', "The relay couldn't start.", 'Try turning it on again.', 'turn-on', 'Turn on…', 'Stopped'],
    ['S8d', failed('ERR_HELPER'), false, 'Stopped', 'Part of KithMoot that runs the relay is missing or damaged.', 'Reinstall KithMoot from kithmoot.app, then try again.', 'turn-on', 'Turn on…', 'Stopped'],
    ['S8e', failed('ERR_STOP_TIMEOUT'), false, 'Still stopping', "The relay hasn't stopped yet. Press Stop again.", undefined, 'stop', 'Stop', 'Stopping…'],
    ['S8f', failed('ERR_RELAY_EXITED'), false, 'Stopped', 'The relay stopped unexpectedly.', 'Try turning it on again.', 'turn-on', 'Turn on…', 'Stopped'],
    ['S8g', failed('ERR_SOMETHING_NEW'), false, 'Stopped', "The relay couldn't start.", 'Try turning it on again.', 'turn-on', 'Turn on…', 'Stopped'],
    ['S8h', failed('ERR_IDENTITY'), false, 'Stopped', "The relay's saved keys couldn't be read. This happens after switching between builds of KithMoot.", undefined, 'remove-keys', 'Remove keys…', 'Stopped'],
    ['S9', failed('ERR_DAILY_LIMIT', true), false, 'Paused for today', "Today's limit of 5 GB is used up.", 'It starts again after midnight.', 'stop', 'Stop', 'Paused until midnight'],
    ['S10a', base, true, 'You already use your own Spry relay', "Your calls go through your Spry node, so this computer's relay stays off. To use this one instead, unpair your Spry node first.", undefined, 'none', '', 'Not used: you have Spry'],
    ['S10a', failed('ERR_HAND_PAIRED'), false, 'You already use your own Spry relay', undefined, undefined, 'none', '', 'Not used: you have Spry'],
    ['S10b', failed('ERR_NO_ACCOUNT'), false, 'Stopped', 'Start or open a room first, so the relay knows whose rooms it serves.', undefined, 'turn-on', 'Turn on…', 'Off'],
    ['S10c', failed('ERR_OTHER_ACCOUNT'), false, 'Stopped', "This computer's relay is set up for another account you use here. Switch to that account to use it.", undefined, 'turn-on', 'Turn on…', 'Off'],
    ['S10d', failed('ERR_NO_CONTROL_RELAYS'), false, 'Stopped', 'None of your Nostr relays can carry requests for the call relay. Add one whose address starts with wss:// and uses a domain name, in Nostr relays.', undefined, 'turn-on', 'Turn on…', 'Off'],
    ['S12', { ...running, status: 'stopping' }, false, 'Stopping…', undefined, undefined, 'stopping', 'Stopping…', 'Stopping…'],
    ['S12', { ...base, wanted: true, blocked: true }, false, 'Stopping…', undefined, undefined, 'stopping', 'Stopping…', 'Stopping…'],
  ]
  it.each(rows)('%s', (id, state, handPaired, line1, line2, line3, control, label, row) => {
    const shown = view(state, { handPaired })
    expect(shown.id).toBe(id)
    expect(shown.line1).toBe(line1)
    if (line2 !== undefined) expect(shown.line2).toBe(line2)
    expect(shown.line3).toBe(line3)
    expect(shown.control).toEqual({ kind: control, label })
    expect(shown.rowSub).toBe(row)
  })

  it('shows nothing before the first report, or when the relay is not available', () => {
    expect(relayView({ state: undefined, handPaired: false, canCheck: false })).toBeUndefined()
    expect(relayView({ state: { ...base, available: false }, handPaired: false, canCheck: false })).toBeUndefined()
  })

  it('T-OWNCALLS shows only while running with a relay server saved', () => {
    const own = "Your own calls use your relay server, which comes first. People in your rooms can still use this relay."
    expect(relayView({ state: running, handPaired: false, canCheck: false, serverSaved: true, now: NOW })!.ownCalls).toBe(own)
    expect(relayView({ state: running, handPaired: false, canCheck: false, now: NOW })!.ownCalls).toBeUndefined()
    expect(relayView({ state: base, handPaired: false, canCheck: false, serverSaved: true, now: NOW })!.ownCalls).toBeUndefined()
  })

  it('S1 shows the intro and the Off page has no Details or checkbox', () => {
    const shown = view(base)
    expect(shown.line2).toContain("When two people can't connect directly")
    expect(shown.details).toEqual([])
    expect(shown.startOnOpenShown).toBe(false)
    expect(shown.check).toBeUndefined()
    expect(shown.indicator).toBe(false)
  })

  it('S13 shows the ticked checkbox under Turn on', () => {
    const shown = view({ ...base, startOnOpen: true })
    expect(shown.startOnOpenShown).toBe(true)
    expect(shown.startOnOpenChecked).toBe(true)
  })

  it('the rail indicator shows while starting or running only', () => {
    const on = ['S3', 'S4', 'S5', 'S14']
    for (const [state, expected] of [[{ ...base, wanted: true, status: 'starting' }, true], [running, true], [{ ...running, control: { relays: 0 } }, true],
      [{ ...running, status: 'stopping' }, false], [base, false], [{ ...base, status: 'cannot-host' }, false]] as Array<[RelayHostState, boolean]>) {
      expect(view(state).indicator, relayScreen(state, false)).toBe(expected)
    }
    expect(on).toHaveLength(4)
  })

  it('never reads the main process\'s own words', () => {
    const shown = view({ ...base, status: 'cannot-host', wanted: true, reason: 'vpn', ...{ reasonText: 'LEAK' }, error: { code: 'ERR_START_FAILED', ...{ message: 'LEAK' } } })
    expect(JSON.stringify(shown)).not.toContain('LEAK')
  })
})

describe('reasons a network cannot host (6.5)', () => {
  it('has plain words for each reason and a fallback', () => {
    expect(Object.keys(CANNOT_HOST_WORDS)).toHaveLength(12)
    for (const code of Object.keys(CANNOT_HOST_WORDS)) {
      expect(cannotHostWords(code)).not.toMatch(/\bports?\b|PCP|NAT-PMP|CGNAT/)
    }
    expect(cannotHostWords('no-answer')).toContain('UPnP')
    expect(cannotHostWords('something-new')).toBe("This network can't host a call relay.")
    expect(cannotHostWords(undefined)).toBe("This network can't host a call relay.")
    expect(cannotHostWords('constructor')).toBe("This network can't host a call relay.")
  })
})

describe('the reachable fact (6.3)', () => {
  const who = 'your other device'
  const at = AT
  const cases: Array<[string, RelayCheckResult | undefined, boolean, string]> = [
    ['never, can check', undefined, true, 'Not checked from outside yet'],
    ['never, cannot', undefined, false, 'Not checked from outside yet. To check, open a room you made that your phone or a friend is in.'],
    ['not hosting', { kind: 'not-hosting', who }, true, "Your relay isn't shared in this room, so nobody here can check it."],
    ['left', { kind: 'left', who: 'Alex' }, true, 'Alex has left the room. Pick someone else.'],
    ['checking', { kind: 'checking', who }, true, 'Checking from your other device…'],
    ['reachable', { kind: 'reachable', who, at }, true, 'Reachable, checked from your other device at 14:02'],
    ['same network', { kind: 'same-network', who, at }, true, 'Not proved yet: your other device is on the same network as this computer. Check from a device on another network, such as your phone with Wi-Fi off.'],
    ['inbound', { kind: 'inbound', who, at, stage: 'inbound' }, true, "Opened on your router, but people still can't reach it (checked from your other device at 14:02)"],
    ['unreachable', { kind: 'unreachable', who: 'Alex', at, stage: 'allocate' }, true, "Can't be reached from Alex's network (checked at 14:02)"],
    ['declined', { kind: 'declined', who: 'Alex', at }, true, "Alex couldn't check just now. Try again in a minute, or pick someone else."],
    ['credentials', { kind: 'credentials', who: 'Alex', at }, true, "Your relay didn't let Alex in, so nothing was checked. Ask them to open the room again, then check again."],
    ['no answer', { kind: 'no-answer', who: 'Alex', at }, true, 'No answer from Alex. Check that KithMoot is open on that device.'],
  ]
  it.each(cases)('%s', (_name, check, canCheck, line) => { expect(reachableLine(check, canCheck, NOW)).toBe(line) })

  it('says yesterday once the run has crossed midnight', () => {
    const yesterday = new Date(2026, 9, 29, 23, 40).getTime()
    expect(whenText(yesterday, NOW)).toBe('yesterday at 23:40')
    expect(reachableLine({ kind: 'reachable', who, at: yesterday }, true, NOW)).toBe('Reachable, checked from your other device yesterday at 23:40')
  })

  it('turns a host reply into a result; same network never reads as reachable', () => {
    expect(checkFromOutcome({ answered: true, ok: true }, who, AT).kind).toBe('reachable')
    expect(checkFromOutcome({ answered: true, ok: true, sameNetwork: true }, who, AT).kind).toBe('same-network')
    expect(checkFromOutcome({ answered: true, ok: false, stage: 'inbound' }, who, AT).kind).toBe('inbound')
    expect(checkFromOutcome({ answered: true, ok: false, stage: 'stun' }, who, AT).kind).toBe('unreachable')
    expect(checkFromOutcome({ answered: true, ok: false, stage: 'allocate' }, who, AT).kind).toBe('unreachable')
    expect(checkFromOutcome({ answered: true, ok: false, stage: 'declined' }, who, AT).kind).toBe('declined')
    expect(checkFromOutcome({ answered: true, ok: false, stage: 'credentials' }, who, AT).kind).toBe('credentials')
    expect(checkFromOutcome({ answered: false }, who, AT).kind).toBe('no-answer')
  })

  it('maps the preview names', () => {
    for (const name of ['reachable', 'same-network', 'inbound', 'allocate', 'declined', 'credentials', 'noanswer']) expect(previewCheck(name, AT)).toBeDefined()
    expect(previewCheck('nonsense', AT)).toBeUndefined()
    expect(previewCheck(undefined, AT)).toBeUndefined()
  })
})

describe('the use fact (6.4) and bytes', () => {
  it('formats decimal units', () => {
    expect(formatBytes(0)).toBe('0 MB')
    expect(formatBytes(999_999)).toBe('under 1 MB')
    expect(formatBytes(300_000_000)).toBe('300 MB')
    expect(formatBytes(999_600_000)).toBe('1 GB')
    expect(formatBytes(1_234_567_890)).toBe('1.2 GB')
    expect(formatBytes(5_000_000_000)).toBe('5 GB')
  })
  it('in use, last used, not used', () => {
    expect(useLine({ ...running, counts: { allocations: 2, bytesRelayed: 1, lastAllocation: null } }, NOW)).toBe('In use now · Relayed today: 0 MB of 5 GB')
    expect(useLine({ ...running, today: 300_000_000, counts: { allocations: 0, bytesRelayed: 1, lastAllocation: AT / 1000 } }, NOW))
      .toBe('Last used at 14:02 · Relayed today: 300 MB of 5 GB')
    expect(useLine(running, NOW)).toBe('Not used yet · Relayed today: 0 MB of 5 GB')
  })
})

describe('details (6.7), never an address or a people count (acceptance 8)', () => {
  it('lists only router words, counts and limits', () => {
    const shown = view({ ...running, counts: { allocations: 3, bytesRelayed: 1_234_567_890, lastAllocation: null },
      mapping: { method: 'natpmp', allocationPorts: 8, requested: 10, permanent: true, restored: 2 } }, { canCheck: true,
      check: { kind: 'inbound', who: 'Alex', at: AT, stage: 'inbound' } })
    expect(shown.details).toEqual([
      'Router: opened automatically using NAT-PMP',
      'Openings on your router: 8 of 10',
      'Your router only offers permanent openings. If KithMoot crashes they stay open until it next starts, when it removes them.',
      'Your router dropped 2 openings; the relay put them back.',
      'Nostr relays: connected',
      'Connections now: 3',
      'Relayed since it started: 1.2 GB',
      "Daily limit: 5 GB. When it's reached, the relay pauses until midnight.",
      'Last check: from Alex at 14:02, stopped at the inbound step',
    ])
    const text = JSON.stringify(shown)
    expect(text).not.toMatch(/\d+ people|\bpeople now\b|spry:|turn:|\b\d{1,3}(\.\d{1,3}){3}\b|[0-9a-f]{64}/)
  })
  it('Check shows only while running with someone to check from', () => {
    expect(view(running, { canCheck: true }).check).toEqual({ label: 'Check from another device…', disabled: false })
    expect(view(running, { canCheck: false }).check).toBeUndefined()
    expect(view(running, { canCheck: true, check: { kind: 'checking', who: 'Alex' } }).check).toEqual({ label: 'Checking…', disabled: true })
  })
})

describe('the Turn on dialog', () => {
  it('uses the approved notice and adds the Hide my IP line only when it is on', () => {
    const off = turnOnDialog(5_000_000_000, false)
    expect(off.title).toBe('Turn on the call relay on this computer?')
    expect(off.message).toBe(RELAY_TURN_ON_NOTICE('5 GB'))
    expect(off.message).toContain('up to 5 GB a day')
    expect(off.message).toContain("Check that the laws that apply to you and your internet provider's terms allow it.")
    expect(off.message).not.toContain("Hide my IP address doesn't hide")
    expect(turnOnDialog(5_000_000_000, true).message).toBe(`${off.message}\n\nHide my IP address doesn't hide your address from people who use your relay.`)
    expect([off.cancelLabel, off.confirmLabel]).toEqual(['Cancel', 'Turn on'])
  })
})
