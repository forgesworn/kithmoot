import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'

const label = new TextEncoder().encode('kithmoot/vmls-standalone-revocation/v1')
export function mlsStandaloneRevocationOperation(sender: string, keeper: string, device: string): string {
  if (![sender, keeper, device].every(value => /^[0-9a-f]{64}$/.test(value))) throw new Error('Invalid standalone revocation binding.')
  return bytesToHex(sha256(concatBytes(label, hexToBytes(sender), hexToBytes(keeper), hexToBytes(device))))
}
