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
 * There is a third form of the same thing, and it is the one that bites
 * hardest: once gathering has begun, the description a connection hands back
 * is not the one it wrote. The m-line port stops being the discard port 9
 * and becomes the default candidate's, the `c=` line stops being
 * `IN IP4 0.0.0.0` and becomes that candidate's address, and an `a=rtcp:`
 * line appears or moves with it. `#sendLocalOfferAgain` re-sends
 * `localDescription`, so every retransmitted offer differs from its first
 * copy in exactly those lines - which is to say the answering side would
 * stop recognising the offer it had just answered, precisely during the race
 * that needs the recognition, and a re-read answer could earn a repair that
 * proposes nothing new.
 *
 * So candidates, the default-candidate lines and the `o=` version are
 * flattened out, and everything that decides what the session IS stays in.
 * `a=ice-ufrag` and `a=ice-pwd` in particular: an ICE restart proposes new
 * credentials and nothing else, and it MUST read as a different description
 * or the restart is swallowed.
 * The direction attributes stay for the same reason - they are the whole
 * subject of the disagreement this comparison exists to find.
 *
 * Deliberately textual and deliberately dumb. It is a comparison, not a
 * parser: anything it does not recognise is carried through unchanged, so a
 * description it has never seen the like of compares as itself.
 */

/** Lines that say nothing about what is being proposed. */
function isNoise(line: string): boolean {
  return line === '' || line.startsWith('a=candidate:') || line === 'a=end-of-candidates' || line.startsWith('a=rtcp:')
}

/**
 * `m=<media> <port> <proto> <fmt>...`
 *
 * The port is 9 - the discard port - until gathering picks a default
 * candidate, and then it is that candidate's port. So the same proposal
 * re-read after gathering differs here, which is not a proposal changing.
 */
function flattenMedia(line: string): string {
  const parts = line.split(' ')
  if (parts.length < 3) return line
  parts[1] = '9'
  return parts.join(' ')
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
    if (line.startsWith('o=')) lines.push(flattenOrigin(line))
    else if (line.startsWith('m=')) lines.push(flattenMedia(line))
    // The connection address is `IN IP4 0.0.0.0` until gathering fills in the
    // default candidate's, and it is that candidate's afterwards. Same fact
    // as the m-line port, same answer.
    else if (line.startsWith('c=')) lines.push('c=IN IP4 0.0.0.0')
    else lines.push(line)
  }
  return lines.join('\n')
}

/** Whether two descriptions propose the same session. */
export function sameShape(a: string | undefined | null, b: string | undefined | null): boolean {
  const left = sdpShape(a)
  if (left === undefined) return false
  return left === sdpShape(b)
}
