import { expect, type Page, type Request } from '@playwright/test'

/** Open the pre-room page. A runner network change may abort its bootstrap
 * imports; allow one fresh navigation before any room or call is created. */
export async function openRoomCreationPage(page: Page, baseURL: string): Promise<void> {
  const origin = new URL(baseURL).origin
  for (let attempt = 0; attempt < 2; attempt++) {
    let networkChanged = false
    const failed = (request: Request) => {
      if (request.failure()?.errorText.includes('net::ERR_NETWORK_CHANGED')
        && ['document', 'script', 'stylesheet'].includes(request.resourceType())
        && new URL(request.url()).origin === origin) networkChanged = true
    }
    page.on('requestfailed', failed)
    try {
      try { await page.goto(baseURL) }
      catch (error) {
        if (!String(error).includes('net::ERR_NETWORK_CHANGED')) throw error
        networkChanged = true
      }
      let state = 'checking'
      await expect.poll(async () => {
        if (networkChanged) return 'network-changed'
        state = await page.evaluate(() => document.documentElement.dataset.ordinaryStartup ?? 'ready')
        return state
      }, { timeout: 30_000 }).not.toBe('checking')
      if (networkChanged && attempt === 0) {
        console.log('Pre-room startup: navigating once more after net::ERR_NETWORK_CHANGED')
        continue
      }
      // Storage refusals and every other bootstrap failure remain failures.
      expect(networkChanged ? 'network-changed' : state).toBe('ready')
      return
    } finally { page.off('requestfailed', failed) }
  }
}
