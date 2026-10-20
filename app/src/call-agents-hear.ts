/**
 * Agents hear nothing unless a person says so (design-calm-shell 6.7).
 *
 * The switch is `#toggleAgentsHear`, off by default and remembered by its own
 * handler in main.ts. What this adds is the moment: the first time this
 * device unmutes in a call with an agent in the room, one prompt above the
 * call bar says so and asks. It is not a modal and it does not stop the
 * call. Focus goes to it once, and back to the microphone when it is
 * answered. "Not now" changes nothing; "Let agents hear me" presses the
 * switch through its own handler.
 *
 * Asked once per call and remembered only in memory, by call id: a new call,
 * or a reload, asks again, and nothing new is written to storage. Nobody is
 * asked who has already said yes.
 */

export interface AgentsHearHooks {
  /** Names of the agents in the room, other than this device's person. */
  agents(): string[]
  /** The call this device is on, or undefined. */
  callId(): string | undefined
}

/** The words above the bar. */
export function agentsConsentTitle(names: readonly string[]): string {
  return names.length === 1 ? `${names[0]} is an agent on this call.` : `${names.length} agents are on this call.`
}

export function installAgentsHear(hooks: AgentsHearHooks): void {
  const prompt = document.getElementById('agentsConsent')!
  const title = document.getElementById('agentsConsentTitle')!
  const mic = document.getElementById('toggleMic')!
  const hear = document.getElementById('toggleAgentsHear')!
  const chip = document.getElementById('agentsHearChip')!
  let askedFor: string | undefined

  function dismiss(): void {
    const had = !prompt.hidden
    prompt.hidden = true
    if (had) mic.focus({ preventScroll: true })
  }

  document.getElementById('agentsConsentNo')!.addEventListener('click', dismiss)
  document.getElementById('agentsConsentYes')!.addEventListener('click', () => {
    if (hear.dataset.on !== 'true') hear.click()
    dismiss()
  })
  prompt.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    dismiss()
  })

  function renderChip(): void {
    chip.hidden = hear.dataset.on !== 'true' || !document.getElementById('callBay') || document.getElementById('deviceControls')!.hidden
  }
  new MutationObserver(renderChip).observe(hear, { attributes: true, attributeFilter: ['data-on'] })
  new MutationObserver(renderChip).observe(document.getElementById('deviceControls')!, { attributes: true, attributeFilter: ['hidden'] })
  renderChip()

  // A call that ends takes its question with it.
  new MutationObserver(() => { if (document.getElementById('deviceControls')!.hidden) prompt.hidden = true })
    .observe(document.getElementById('deviceControls')!, { attributes: true, attributeFilter: ['hidden'] })

  new MutationObserver(() => {
    if (mic.dataset.on !== 'true') return
    const call = hooks.callId()
    if (!call || askedFor === call || hear.dataset.on === 'true') return
    const names = hooks.agents()
    if (names.length === 0) return
    askedFor = call
    title.textContent = agentsConsentTitle(names)
    prompt.hidden = false
    title.focus({ preventScroll: true })
  }).observe(mic, { attributes: true, attributeFilter: ['data-on'] })
}
