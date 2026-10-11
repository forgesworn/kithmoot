import type { Page } from '@playwright/test'

/** Available only in explicitly enabled acceptance builds; never copies or sends. */
export async function collectAppDiagnostics(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const collect = (window as unknown as { __kithmootCollectDiagnostics?: () => Promise<string> }).__kithmootCollectDiagnostics
    if (!collect) throw new Error('This build does not enable acceptance diagnostics')
    return collect()
  })
}
