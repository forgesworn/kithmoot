/** Serialise platform badge updates so a late set cannot undo a clear. */
let pending: Promise<void> = Promise.resolve()
export function updateAppBadge(count: number): void {
  const badge = navigator as Navigator & { setAppBadge?: (value: number) => Promise<void>; clearAppBadge?: () => Promise<void> }
  pending = pending.catch(() => {}).then(async () => {
    try {
      if (count > 0) await badge.setAppBadge?.(count)
      else await badge.clearAppBadge?.()
    } catch { /* Unsupported platforms and permission denial leave chat usable. */ }
  })
}
