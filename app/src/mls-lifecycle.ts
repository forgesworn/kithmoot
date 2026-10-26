export interface BrowserMlsOwner { invalidate(): void | Promise<void> }
/** Invalidate every instantiated owner synchronously before joining any tail.
 * Account, lock and signout callers use the same production path. */
export async function invalidateBrowserMlsOwners(owners: readonly (BrowserMlsOwner | undefined)[]): Promise<void> {
  const tails = owners.map(owner => {
    try { return Promise.resolve(owner?.invalidate()) } catch (error) { return Promise.reject(error) }
  })
  const results = await Promise.allSettled(tails)
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}
