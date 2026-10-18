import { test as base, type Browser } from '@playwright/test'

/** Each native case owns and joins its actual browser and context. Public
 * Playwright test instrumentation still supplies launch/context options and
 * trace recording; these offline fixtures use the default video-off mode. */
export const test = base.extend<{ordinaryBrowser: Browser}>({
  ordinaryBrowser: async ({playwright, browserName}, use) => {
    const owned = await playwright[browserName].launch()
    try { await use(owned) } finally { await owned.close() }
  },
  context: async ({ordinaryBrowser}, use) => {
    const owned = await ordinaryBrowser.newContext()
    try { await use(owned) } finally { await owned.close() }
  },
})
