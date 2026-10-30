import type { ConfirmActionOptions } from './confirm-action.js'
import { RELAY_TEST_NOT_HOSTING, RELAY_TEST_NOT_PRESENT } from './relay-outside-test.js'
import {
  CHECK_DIALOG, REMOVE_KEYS_DIALOG, checkFromOutcome, previewCheck, relayView, turnOnDialog,
  type RelayCheckResult, type RelayHostState, type RelayView,
} from './relay-words.js'

/**
 * The built-in call relay's page and row in Settings, on the desktop app.
 *
 * `relay-words.ts` decides what every state says; this draws it, asks before
 * Turn on, runs the outside check, and talks to the main process through the
 * preload's closed set of calls. It keeps one thing besides the main
 * process's last report: the outcome of the last outside check, in memory,
 * until the relay stops, restarts or changes network (so never in storage).
 */

/** What the page can do on this computer. Each call is absent on a desktop build without the relay page. */
export interface RelayBridge {
  relayStart?(): Promise<boolean>
  relayStop?(): Promise<boolean>
  relaySetStartOnOpen?(on: boolean): Promise<boolean>
  relayRemoveKeys?(): Promise<boolean>
}

/** A device the host can ask to test the relay from outside. */
export interface RelayCheckCandidate {
  device: string
  /** On the radio: "Your other device", or a member's name. */
  label: string
  /** In the result: "your other device", or the member's name. */
  who: string
}

/** The room on screen, when this device shares its relay in it. */
export interface RelayCheckRoom {
  roomName: string
  /** Own other devices first, then one device per member present now. */
  candidates: RelayCheckCandidate[]
  ask(device: string): Promise<{ answered: boolean; ok?: boolean; stage?: string; sameNetwork?: true }>
}

export interface RelayPageDeps {
  bridge: RelayBridge
  confirm(options: ConfirmActionOptions): Promise<boolean>
  hideIp(): boolean
  /** This account has a Spry node it paired by hand. */
  handPaired(): boolean
  /** The room to check from, or undefined when there is none or nobody to ask. */
  checkRoom(): RelayCheckRoom | undefined
  /** Open Settings at this page (the rail's Relay on). */
  open(): void
  now?: () => number
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T

/** Whatever the main process sent, reduced to the report this page reads. */
export function parseRelayState(value: unknown): RelayHostState | undefined {
  const raw = (value as { state?: unknown } | null | undefined)?.state
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const state = raw as Record<string, unknown>
  if (state.available !== true || typeof state.status !== 'string') return undefined
  const known = ['off', 'starting', 'running', 'stopping', 'failed', 'cannot-host']
  if (!known.includes(state.status)) return undefined
  return raw as unknown as RelayHostState
}

export function createRelayPage(deps: RelayPageDeps) {
  const now = deps.now ?? Date.now
  let state: RelayHostState | undefined
  let check: RelayCheckResult | undefined
  let token = 0
  let shown: RelayView | undefined
  let signature = ''

  // Who could be asked is only worked out while the relay runs: it is the one state that offers a check.
  const view = (): RelayView | undefined => relayView({ state, handPaired: deps.handPaired(), check, canCheck: state?.status === 'running' && !!deps.checkRoom(), now: new Date(now()) })
  const setText = (el: HTMLElement, text: string | undefined): void => { if (el.textContent !== (text ?? '')) el.textContent = text ?? '' }

  function render(): void {
    shown = view()
    const row = $('settingsRowCallRelay')
    const rail = $('railRelay')
    row.hidden = !shown
    rail.hidden = !shown?.indicator
    if (!shown) { setText($('settingsSubCallRelay'), ''); return }
    setText($('settingsSubCallRelay'), shown.rowSub)
    // A repeated state is not set again, so a screen reader hears only changes.
    setText($('relayRunning'), shown.line1)
    setText($('relayReachable'), shown.line2)
    setText($('relayUse'), shown.line3)
    const toggle = $<HTMLButtonElement>('relayToggle')
    toggle.hidden = shown.control.kind === 'none'
    setText(toggle, shown.control.label)
    toggle.className = shown.control.kind === 'turn-on' ? 'primary' : ''
    toggle.disabled = shown.control.kind === 'stopping'
    toggle.dataset.kind = shown.control.kind
    const checkButton = $<HTMLButtonElement>('relayCheck')
    checkButton.hidden = !shown.check
    if (shown.check) { setText(checkButton, shown.check.label); checkButton.disabled = shown.check.disabled }
    $('relayStartOnOpenRow').hidden = !shown.startOnOpenShown
    $<HTMLInputElement>('relayStartOnOpen').checked = shown.startOnOpenChecked
    const details = $('relayDetails')
    const next = shown.details.join('\n')
    details.hidden = shown.details.length === 0
    if (next !== signature) {
      signature = next
      const list = $('relayDetailsList')
      list.replaceChildren(...shown.details.map(line => { const p = document.createElement('p'); p.className = 'note'; p.textContent = line; return p }))
    }
    setText($('relayNote'), shown.note)
    $('relayNote').hidden = !shown.note
    // Everyone left while the picker was open: it has nobody to offer.
    const picker = document.getElementById('relayCheckChoices')?.closest('dialog')
    if (picker && !deps.checkRoom()) picker.close('cancel')
  }

  /** The main process's report arrived (or the room or account on screen changed). */
  function apply(value: unknown): void {
    state = parseRelayState(value)
    // A result is true of one run on one network: any other state forgets it.
    if (state?.status !== 'running' && check) { check = undefined; token++ }
    const forced = state?.preview?.check
    if (state?.status === 'running' && forced && !check) check = previewCheck(forced, now())
    render()
  }

  async function toggle(): Promise<void> {
    if (!state || !shown) return
    switch (shown.control.kind) {
      case 'turn-on': {
        if (!await deps.confirm(turnOnDialog(state.dailyLimit, deps.hideIp()))) return
        await deps.bridge.relayStart?.()
        return
      }
      case 'stop': await deps.bridge.relayStop?.(); return
      case 'remove-keys':
        if (await deps.confirm({ ...REMOVE_KEYS_DIALOG, danger: true })) await deps.bridge.relayRemoveKeys?.()
        return
      default: return
    }
  }

  async function runCheck(): Promise<void> {
    const room = deps.checkRoom()
    if (!room || !room.candidates.length || check?.kind === 'checking') return
    const fieldset = document.createElement('fieldset')
    fieldset.id = 'relayCheckChoices'
    fieldset.className = 'relayCheckChoices'
    const legend = document.createElement('legend')
    legend.className = 'sr-only'
    legend.textContent = CHECK_DIALOG.legend
    fieldset.append(legend)
    room.candidates.forEach((candidate, index) => {
      const label = document.createElement('label')
      label.className = 'checkboxRow'
      const input = document.createElement('input')
      input.type = 'radio'; input.name = 'relayCheckDevice'; input.value = candidate.device; input.checked = index === 0
      const text = document.createElement('span')
      text.textContent = candidate.label
      label.append(input, ' ', text)
      fieldset.append(label)
    })
    const ok = await deps.confirm({ title: CHECK_DIALOG.title, message: CHECK_DIALOG.body(room.roomName), confirmLabel: CHECK_DIALOG.confirmLabel,
      cancelLabel: CHECK_DIALOG.cancelLabel, content: fieldset, isCurrent: () => deps.checkRoom() !== undefined })
    if (!ok) return
    const chosen = room.candidates.find(candidate => candidate.device === fieldset.querySelector<HTMLInputElement>('input:checked')?.value)
    if (!chosen) return
    const mine = ++token
    check = { kind: 'checking', who: chosen.who }
    render()
    let next: RelayCheckResult
    try {
      next = checkFromOutcome(await room.ask(chosen.device), chosen.who, now())
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      next = message === RELAY_TEST_NOT_HOSTING ? { kind: 'not-hosting', who: chosen.who }
        : message === RELAY_TEST_NOT_PRESENT ? { kind: 'left', who: chosen.who }
        : { kind: 'no-answer', who: chosen.who, at: now() }
    }
    // The relay stopped or moved on while the answer was on its way.
    if (mine !== token) return
    check = next
    render()
  }

  $('relayToggle').addEventListener('click', () => { void toggle() })
  $('relayCheck').addEventListener('click', () => { void runCheck() })
  $('railRelay').addEventListener('click', () => deps.open())
  $('relayStartOnOpen').addEventListener('change', event => {
    const on = (event.target as HTMLInputElement).checked
    void Promise.resolve(deps.bridge.relaySetStartOnOpen?.(on)).then(accepted => { if (accepted === false) render() }).catch(() => render())
  })

  return { apply, refresh: render, get available() { return !!state }, get view() { return shown } }
}
