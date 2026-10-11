const hex32 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}(?![\s\S])/.test(value)

/** Acquire before persona/node locks. Sorted unique devices prevent competing
 * multi-candidate Add calls from taking the same locks in opposite order.
 * Ownership lasts through actual work settlement; there is no timeout release
 * or fallback when origin-wide Web Locks are unavailable. */
export async function withMlsDeviceAdmissionGate<T>(devices: readonly string[], mode: 'shared' | 'exclusive', work: () => Promise<T>): Promise<T> {
  if (!Array.isArray(devices) || devices.length < 1 || devices.length > 64 || !Array.from(devices).every(hex32) || !['shared', 'exclusive'].includes(mode)) {
    throw new Error('Invalid MLS device admission gate binding.')
  }
  const ordered = [...new Set(devices)].sort()
  const acquire = async (index: number): Promise<T> => index === ordered.length ? work()
    : navigator.locks.request(`kithmoot.vmls-grant-install.v1.${ordered[index]}`, { mode }, () => acquire(index + 1))
  return acquire(0)
}
