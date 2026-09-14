/**
 * Shorten a hex identifier - a room id, a pubkey, a participant key - for a
 * status line that a process prints on every start and that whatever
 * supervises it (journald, a container's log driver) may keep for a long
 * time.
 *
 * The full 64-hex value is not a secret from the process printing it - a
 * forwarder is configured with its room id on purpose, see
 * `server/forwarder.mjs` - but a long-retained log is a different audience
 * than the operator watching the terminal at start: it is a place that lets
 * anyone who can read it correlate a room, a key or a person across every
 * other log that names the same hex string. Eight hex characters (32 bits)
 * is enough to tell one room or one key from another in a status line, and
 * nowhere near enough to reconstruct the rest.
 */
export function shortId(hex: string): string {
  return hex.slice(0, 8)
}
