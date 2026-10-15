import { test as base } from '@playwright/test'

/** Browser page creation has a separate bounded fixture budget. Cold native
 * application setup, recovery, member join and send keep their existing test
 * budget. This gate does not measure browser launch plus journey within 30s.
 * Each test still receives the runner's fresh isolated context and page. */
export const test = base.extend({
  page: [async ({ context }, use) => {
    const page = await context.newPage()
    try { await use(page) }
    finally { await page.close() }
  }, { scope: 'test', timeout: 30_000 }],
})
export { expect, type Page } from '@playwright/test'
