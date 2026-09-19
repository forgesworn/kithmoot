import type { ChannelChecks, StoredChannelCheck } from './channel-checks.js'

/** The dialog never interprets completion as a human comparison. Closing it,
 * Escape and Cancel make no verification record. */
export function showChannelCheckDialog(args: {
  checks: ChannelChecks; peer: string; name: string; changed: boolean
  current(): boolean; onCompared(): void
}): void {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  const dialog = el<HTMLDialogElement>('verifyDialog')
  if (dialog.open) return
  el('verifyTitle').textContent = `Is this really ${args.name}?`
  const warning = el('verifyWarning')
  warning.textContent = args.changed ? `You checked a different key for “${args.name}” before. Compare the words and recognise the person before marking this key checked.` : ''
  warning.hidden = !args.changed
  const start = el<HTMLButtonElement>('verifyStart'), accept = el<HTMLButtonElement>('verifyAccept')
  const decline = el<HTMLButtonElement>('verifyDecline'), retry = el<HTMLButtonElement>('verifyRetry')
  const confirm = el<HTMLButtonElement>('verifyConfirm'), state = el('verifyState')
  let selected: StoredChannelCheck | undefined, busy = false, closed = false, error = '', pinned: string | undefined
  const now = () => Math.floor(Date.now() / 1000)
  const paint = () => {
    if (closed) return
    if (!args.current()) { dialog.close(); return }
    try {
      const rows = args.checks.list(args.peer).filter(row => !row.declined)
      // Both participants choose the same exchange if they start together.
      // Once words are shown, keep that transcript pinned for comparison.
      const active = rows.filter(row => row.request.expiresAt > now()).sort((a, b) => a.request.id.localeCompare(b.request.id))
      selected = pinned ? rows.find(row => row.request.id === pinned) : active[0]
        ?? rows.filter(row => row.state?.phase === 'complete').sort((a, b) => b.request.createdAt - a.request.createdAt)[0]
      const words = selected ? args.checks.words(selected.request.id) : undefined
      if (words) pinned = selected!.request.id
      el('verifyMine').textContent = words?.youSay ?? '—'
      el('verifyTheirs').textContent = words?.theySay ?? '—'
      const incoming = selected && !selected.state
      start.hidden = !!selected
      accept.hidden = !incoming
      decline.hidden = !incoming
      retry.hidden = !selected?.state || !!words
      confirm.disabled = busy || !words
      for (const button of [start, accept, decline, retry]) button.disabled = busy
      state.textContent = error || (words ? 'Compare both sets of words before marking this person checked.'
        : incoming ? 'They asked to compare words. Accept to make your own random contribution.'
        : selected ? 'Waiting for the other person. They need to open your check button and accept. Older apps cannot complete this check.'
        : 'Start a new check, then ask the other person to open your check button and accept.')
    } catch {
      state.textContent = 'The saved check could not be read. No verification has been recorded.'
      for (const button of [start, accept, decline, retry, confirm]) button.disabled = true
    }
  }
  const run = async (action: () => Promise<void>) => {
    if (busy || closed || !args.current()) return
    busy = true; error = ''; paint()
    try { await action() }
    catch (cause) { error = cause instanceof Error ? cause.message : 'This check could not finish. Try again.' }
    finally { busy = false; if (!closed && dialog.open) paint() }
  }
  start.onclick = () => void run(async () => { await args.checks.start(args.peer) })
  accept.onclick = () => void run(async () => { if (selected) await args.checks.accept(selected.request.id) })
  decline.onclick = () => void run(async () => { if (selected) await args.checks.decline(selected.request.id) })
  retry.onclick = () => void run(async () => { if (selected) await args.checks.retry(selected.request.id) })
  confirm.onclick = () => void run(async () => {
    if (!selected || !pinned || selected.request.id !== pinned || !args.checks.words(pinned)) return
    await args.checks.confirm(pinned)
    if (closed || !args.current() || !dialog.open) return
    args.onCompared(); dialog.close('verified')
  })
  const timer = setInterval(paint, 500)
  dialog.addEventListener('close', () => {
    closed = true; clearInterval(timer)
    for (const button of [start, accept, decline, retry, confirm]) button.onclick = null
  }, { once: true })
  dialog.returnValue = ''; dialog.showModal(); paint()
}
