/**
 * Case-insensitive equality for hex identifiers.
 *
 * Nostr pubkeys, room ids, and every other hex field this protocol compares
 * are canonically produced in lower case, but nothing on the wire enforces
 * that: an allow-list entry typed or pasted by a person, in particular, may
 * carry upper-case hex naming exactly the same key. Every place this
 * protocol decides whether two hex identifiers name the same thing must go
 * through this function rather than `===`/`!==`, so a case difference is
 * never mistaken for a different identity - see `vectors/README.md`.
 */
export function hexEquals(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}
