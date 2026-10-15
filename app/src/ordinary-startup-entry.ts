import { OrdinaryLegacyStartupLifetime } from './ordinary-legacy-startup.js'

const lifetime = new OrdinaryLegacyStartupLifetime()
let live = true
let legacyMayRun = false
const stop = () => { live = false; void lifetime.close().catch(() => {}) }
window.addEventListener('pagehide', stop, { once: true })
// A committed native lease normally prevents BFCache. Defend an unexpected
// restored graph before later legacy pageshow handlers can run.
window.addEventListener('pageshow', event => {
  if (!event.persisted || !legacyMayRun) return
  event.stopImmediatePropagation()
  stop(); held(); location.reload()
}, { capture: true })
function check(): void { if (!live) throw new Error('Startup held') }
function held(): void {
  document.documentElement.dataset.ordinaryStartup = 'held'
  const notice = document.getElementById('ordinaryStartupNotice')
  if (notice) {
    notice.hidden = false
    notice.textContent = 'This workspace could not open. Your saved state has been kept.'
  }
}
async function start(): Promise<void> {
  try {
    await lifetime.acquire()
    check()
    await lifetime.assertAbsent()
    check()
    // Every existing database is refused; no SDK, private image, recovery
    // writer or protected-state consumer is imported by this initial gate.
    // Legacy consumers remain deliberately nonresponsive to client probes.
    lifetime.commitLegacy(); legacyMayRun = true
    await import('./text-size.js')
    check()
    await import('./call-folds.js')
    check()
    await import('./main.js')
    check()
    document.documentElement.dataset.ordinaryStartup = 'ready'
    const notice = document.getElementById('ordinaryStartupNotice')
    if (notice) notice.hidden = true
  } catch {
    held()
  } finally {
    // If an import began, close joins the irreversible document lease; it
    // cannot release partially evaluated legacy listeners or late imports.
    await lifetime.close().catch(() => {})
  }
}
void start()
