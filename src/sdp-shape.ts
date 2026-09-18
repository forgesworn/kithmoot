/**
 * What two descriptions have to share before they are the same proposal.
 *
 * `Peer` asks "is this the answer I am already negotiated with" and "is this
 * the offer I have already answered" several times, and it used to ask them
 * of the raw bytes. The bytes are not the proposal:
 *
 * - `createAnswer()` bumps the `o=` version on every call, so a far end that
 *   answers the same offer twice from scratch - which is what a client with
 *   no replay shortcut does, `kithmoot-android-slots`'s `Negotiation.kt`
 *   among them - produces two byte-different descriptions that propose
 *   exactly the same thing. Compared raw, the second one reads as a
 *   disagreement and starts a renegotiation nobody needed.
 * - An offer re-sent from `localDescription` carries every candidate
 *   gathered since the first copy went out. Compared raw, the retry does not
 *   look like the offer we answered - so the side that should recognise it
 *   does not, and the recognition is missing exactly when the race that
 *   needs it is happening.
 *
 * So candidates come out and the `o=` version is flattened, and everything
 * that decides what the session IS stays in. `a=ice-ufrag` and `a=ice-pwd`
 * in particular: an ICE restart proposes new credentials and nothing else,
 * and it MUST read as a different description or the restart is swallowed.
 * The direction attributes stay for the same reason - they are the whole
 * subject of the disagreement this comparison exists to find.
 *
 * Deliberately textual and deliberately dumb. It is a comparison, not a
 * parser: anything it does not recognise is carried through unchanged, so a
 * description it has never seen the like of compares as itself.
 */

/** Lines that say nothing about what is being proposed. */
function isNoise(line: string): boolean {
  return line === '' || line.startsWith('a=candidate:') || line === 'a=end-of-candidates'
}

/**
 * `o=<username> <sess-id> <sess-version> <nettype> <addrtype> <address>`.
 *
 * The version counts how many times this side has written a description,
 * which is a fact about the writer and not about the session. The session id
 * is left alone: a new one is a new session, and that is a real difference.
 */
function flattenOrigin(line: string): string {
  const parts = line.split(' ')
  if (parts.length < 6) return line
  parts[2] = '0'
  return parts.join(' ')
}

/**
 * The comparable shape of an SDP, or `undefined` if there is nothing to
 * compare. Two descriptions with the same shape propose the same session.
 */
export function sdpShape(sdp: string | undefined | null): string | undefined {
  if (sdp === undefined || sdp === null) return undefined
  const lines: string[] = []
  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim()
    if (isNoise(line)) continue
    lines.push(line.startsWith('o=') ? flattenOrigin(line) : line)
  }
  return lines.join('\n')
}

/** Whether two descriptions propose the same session. */
export function sameShape(a: string | undefined | null, b: string | undefined | null): boolean {
  const left = sdpShape(a)
  if (left === undefined) return false
  return left === sdpShape(b)
}
