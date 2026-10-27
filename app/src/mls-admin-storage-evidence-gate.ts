/** Current Admin2 room operations share this origin-wide gate. A private
 * storage send keeps its witnessed local roster stable through settlement;
 * expiry/current-account guards still apply at every external boundary. */
export async function withAdminStorageEvidenceGate<T>(persona: string, session: string, work: () => Promise<T>): Promise<T> {
  if (![persona,session].every(v => /^[0-9a-f]{64}$/.test(v)) || !globalThis.navigator?.locks) throw new Error('Current Admin2 room custody is required.')
  return await navigator.locks.request(`kithmoot.admin-storage-evidence.v1.${persona}.${session}`, { mode: 'exclusive' }, work)
}
