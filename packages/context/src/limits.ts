/** Callable writer bounds, not browser quota or device-memory guarantees. */
export const CONTEXT_EVENT_BYTES = 1024 * 1024
// A maximum snapshot plus its fixed metadata rounds to a 2MiB plaintext
// bucket, with two GCM tags and the 56-byte FSWNENC2 header.
export const CONTEXT_ENVELOPE_V2_BYTES = 2 * 1024 * 1024 + 88
export const CONTEXT_ENVELOPE_LEGACY_BYTES = 2 * 1024 * 1024
export const CONTEXT_ENVELOPE_BASE64_UNITS = 4 * Math.ceil(CONTEXT_ENVELOPE_V2_BYTES / 3)
export const CONTEXT_COLLECTIONS = 32
// Exact outer/row punctuation for save(). A nested signed event can have
// any property order; its serialized bytes already include its escaping.
const outerBytes = JSON.stringify({ v: 1, identity: '0'.repeat(64), collections: [] }).length
const rowBytes = JSON.stringify({ access: null, envelope: '' }).length - 'null'.length
export const CONTEXT_CACHE_BYTES = outerBytes + CONTEXT_COLLECTIONS *
  (CONTEXT_EVENT_BYTES + CONTEXT_ENVELOPE_BASE64_UNITS + rowBytes) + CONTEXT_COLLECTIONS - 1

/** TextEncoder-equivalent UTF-8 sizing without allocating a second complete
 * backup. Reject over-cap strings before parsing or decrypting any entry. */
export function contextTextFits(value: string, limit: number): boolean {
  if (typeof value !== 'string' || value.length > limit) return false
  let bytes = 0
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c < 0x80) bytes++
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++ }
    else bytes += 3
    if (bytes > limit) return false
  }
  return true
}
