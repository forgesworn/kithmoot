import bundled from './release-notes.json'
import './release-notes.css'

export interface ReleaseNotes { id: string; date: string; title: string; changes: string[]; desktopVersion?: string }
export function parseReleaseNotes(value: unknown): ReleaseNotes | undefined {
  if (!value || typeof value !== 'object') return
  const v = value as Record<string, unknown>
  const short = (s: unknown, max: number): s is string => typeof s === 'string' && s.length > 0 && s.length <= max
  if (!short(v.id, 100) || !short(v.title, 200) || !short(v.date, 80) || !Array.isArray(v.changes) || !v.changes.length || v.changes.length > 20 || !v.changes.every(c => short(c, 1000))) return
  if (v.desktopVersion !== undefined && !short(v.desktopVersion, 80)) return
  return { id: v.id, date: v.date, title: v.title, changes: v.changes as string[], ...(v.desktopVersion ? { desktopVersion: v.desktopVersion as string } : {}) }
}

/** Text-only notes. Reading them never activates an update or leaves a call. */
export function installReleaseNotes(): { offer: (version?: string) => void } {
  let offered = false, version: string | undefined, generation = 0
  const dialog = document.createElement('dialog')
  dialog.id = 'releaseNotes'; dialog.className = 'profileSettings'; dialog.setAttribute('aria-labelledby', 'releaseNotesTitle')
  dialog.innerHTML = '<div class="profileSettingsHeader"><h2 id="releaseNotesTitle">What’s new</h2><button type="button" data-notes-close>Close</button></div><div data-notes-body aria-live="polite"></div>'
  document.body.append(dialog)
  const body = dialog.querySelector<HTMLElement>('[data-notes-body]')!
  const close = () => { generation++; dialog.close() }
  dialog.querySelector('[data-notes-close]')!.addEventListener('click', close)
  dialog.addEventListener('cancel', () => { generation++ })
  const render = (notes?: ReleaseNotes, message?: string) => {
    body.replaceChildren()
    if (message) { const p = document.createElement('p'); p.textContent = message; body.append(p) }
    if (!notes) return
    const h = document.createElement('h3'), date = document.createElement('p'), list = document.createElement('ul')
    h.textContent = notes.title; date.textContent = notes.date
    for (const change of notes.changes) { const li = document.createElement('li'); li.textContent = change; list.append(li) }
    body.append(h, date, list)
  }
  const open = async (upcoming: boolean) => {
    const current = ++generation
    dialog.showModal()
    if (!upcoming) { render(bundled); return }
    render(undefined, 'Loading the changes in the offered update…')
    try {
      // JSON is deliberately outside the worker precache. The current app
      // needs the notes for the offered release, not its own cached notes.
      const response = await fetch(new URL(`whats-new.json?update=${Date.now()}`, new URL(import.meta.env.BASE_URL, location.href)), { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(8000) })
      const notes = response.ok ? parseReleaseNotes(await response.json()) : undefined
      if (current !== generation || !dialog.open) return
      if (!notes || import.meta.env.VITE_DESKTOP === 'true' && (!version || notes.desktopVersion !== version.replace(/^v/, ''))) {
        render(undefined, 'Notes for this offered update are unavailable. You can close this window and update when ready.'); return
      }
      render(notes, version ? `Offered update: ${version}` : 'Changes in the available web update')
    } catch {
      if (current === generation && dialog.open) render(undefined, 'Update notes could not be loaded. Your current app keeps working. Try again when online.')
    }
  }
  document.getElementById('updateChanges')?.addEventListener('click', () => void open(offered))
  document.getElementById('appWhatsNew')?.addEventListener('click', () => void open(false))
  const key = 'kithmoot.release-notes-seen'
  try {
    const previous = localStorage.getItem(key)
    // First visits have no previous version to compare. The Settings entry
    // still explains this build; later changes get a dismissible notice.
    if (previous && previous !== bundled.id) {
      const notice = document.createElement('aside'); notice.id = 'releaseSummary'; notice.setAttribute('aria-label', 'Changes in this update')
      const title = document.createElement('strong'), details = document.createElement('button'), dismiss = document.createElement('button')
      title.textContent = 'KithMoot has been updated'; details.textContent = 'See what changed'; dismiss.textContent = 'Dismiss'
      details.type = dismiss.type = 'button'
      details.addEventListener('click', () => { notice.remove(); void open(false) })
      dismiss.addEventListener('click', () => notice.remove())
      notice.append(title, details, dismiss); document.body.append(notice)
    }
    localStorage.setItem(key, bundled.id)
  } catch { /* Storage can be unavailable; notes remain accessible. */ }
  return { offer: nextVersion => { offered = true; version = nextVersion } }
}
