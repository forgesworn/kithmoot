// A private identifier may leak as textual encoding or literal wire bytes.
export function wireMatches(bytes, needle) {
  if (typeof needle !== 'string' || !needle || needle.length > 2 * 1024 * 1024) return false
  if (bytes.includes(Buffer.from(needle, 'utf8'))) return true
  if (/^(?:[0-9a-f]{2}){16,}$/.test(needle) && bytes.includes(Buffer.from(needle, 'hex'))) return true
  if (/^[A-Za-z0-9_+\/-]{22,}={0,2}$/.test(needle)) {
    const decoded = Buffer.from(needle, 'base64url')
    if (decoded.length >= 16 && bytes.includes(decoded)) return true
  }
  return false
}
