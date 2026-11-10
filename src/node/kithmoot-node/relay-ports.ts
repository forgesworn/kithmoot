/** One bounded range shared by backend allocation, front validation and the
 * operator's firewall plan. Existing installations retain their 32 ports. */
export function nodeRelayRange(value: { relayPortFirst?: number; relayPortCount?: number }) {
  const first = value.relayPortFirst === undefined ? 49160 : value.relayPortFirst
  const count = value.relayPortCount === undefined ? 32 : value.relayPortCount
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || count < 1 || count > 512 || first < 1024 || first > 65536 - count)
    throw Error('Invalid node allocation port range')
  return { first, count, last: first + count - 1 }
}
