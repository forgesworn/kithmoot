import type { Page } from '@playwright/test'

export interface StartupIssue { kind: string; category?: string; resource?: string; status?: number }
const resources = new Set(['document', 'script', 'stylesheet', 'image', 'font', 'fetch', 'xhr', 'websocket'])
const categories = new Set(['module-load', 'type', 'reference', 'script', 'aborted', 'connection', 'certificate', 'other'])

/** Best-effort pre-call evidence only: never replace the original failure or
 * collect URLs, DOM text/values, cookies, storage, credentials or room payloads. */
export async function rethrowStartupFailure(
  cause: unknown, page: Pick<Page, 'evaluate'>, issues: readonly StartupIssue[],
  emit: (diagnostic: unknown) => void = diagnostic => console.log('Automatic-call startup diagnostic', JSON.stringify(diagnostic)),
  captureMs = 300,
): Promise<never> {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    let state: unknown
    try {
      const observed = await Promise.race([
        page.evaluate(() => ({
          ready: document.readyState,
          startupPresent: document.documentElement.dataset.ordinaryStartup !== undefined,
          startupReady: document.documentElement.dataset.ordinaryStartup === 'ready',
          newRoomVisible: ['newRoom', 'newMenuButton'].some(id => document.getElementById(id)?.checkVisibility() === true),
          createVisible: document.getElementById('create')?.checkVisibility() === true,
          roomVisible: document.getElementById('roomArea')?.checkVisibility() === true,
        })).catch(() => undefined),
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), captureMs) }),
      ])
      state = observed ? {
        available: true,
        ready: ['loading', 'interactive', 'complete'].includes(observed.ready) ? observed.ready : 'other',
        startupPresent: observed.startupPresent === true, startupReady: observed.startupReady === true,
        newRoomVisible: observed.newRoomVisible === true, createVisible: observed.createVisible === true, roomVisible: observed.roomVisible === true,
      } : { available: false }
    } finally { clearTimeout(timer) }
    emit({ issues: issues.slice(0, 12).map(issue => ({
      kind: ['page-error', 'request-failed', 'http-error'].includes(issue.kind) ? issue.kind : 'other',
      ...(issue.category !== undefined ? { category: categories.has(issue.category) ? issue.category : 'other' } : {}),
      ...(issue.resource !== undefined ? { resource: resources.has(issue.resource) ? issue.resource : 'other' } : {}),
      ...(Number.isInteger(issue.status) && issue.status! >= 400 && issue.status! <= 599 ? { status: issue.status } : {}),
    })), page: state })
  } catch { /* Diagnostic capture/reporting must never mask createRoom's failure. */ }
  throw cause
}
