import { NostrRelayPool, verifyEventUncached, sanitiseDisplayName } from '../../src/index.js'
import type { Event } from 'nostr-tools/pure'

/**
 * Nostr profiles (kind 0) for the people in a room.
 *
 * This is the only thing in the app that can tell a **published Nostr
 * identity** apart from a key this browser generated five seconds ago: a
 * kind-0 event signed by that key and sitting on a relay. Nothing about the
 * roster carries that distinction, and nothing could - two participant
 * pubkeys look identical on the wire.
 *
 * Be precise about what it proves. A kind-0 `name` is **still
 * self-asserted**: it says "the holder of this key calls themselves
 * Darren", exactly as a typed name says "whoever is at this keyboard calls
 * themselves Darren". The difference is only that the key is persistent and
 * has a history - which is worth something, and is not the same as being
 * verified. The app labels it accordingly and never as "verified".
 */
export interface Profile {
  /** From kind 0's `display_name` or `name`, sanitised like any other. */
  name?: string
  /** An `http:`/`https:` picture URL. Anything else is dropped. */
  picture?: string
}

/** How long a lookup has to produce an answer before "no profile" is the answer. */
const LOOKUP_TIMEOUT_MS = 5_000

/** Only these schemes are ever put in an `<img src>`. */
const PICTURE_SCHEMES = ['http://', 'https://']

export interface ProfileBookOptions {
  /** Read lazily, because a room carries its own relay hints and a lookup
   *  should use the relays the room is actually on rather than whatever
   *  the app defaulted to before the link was opened. */
  relays: () => string[]
  /** Called when a lookup changed something worth re-rendering. */
  onChange: () => void
}

export class ProfileBook {
  readonly #opts: ProfileBookOptions
  #pool?: NostrRelayPool
  #unsubs = new Set<() => void>()
  /** Pubkeys we have asked about, whether or not an answer came back. */
  readonly #asked = new Set<string>()
  readonly #found = new Map<string, { profile: Profile; createdAt: number }>()
  #closed = false

  constructor(opts: ProfileBookOptions) {
    this.#opts = opts
  }

  /** Look up any of these we have not already asked about. Cheap to call
   *  on every render; it does nothing for a pubkey it has already seen. */
  want(pubkeys: string[]): void {
    if (this.#closed) return
    const fresh = [...new Set(pubkeys)].filter((p) => !this.#asked.has(p))
    if (fresh.length === 0) return
    for (const pubkey of fresh) this.#asked.add(pubkey)

    // Lazily, so a browser that never opens a room never opens a socket.
    this.#pool ??= new NostrRelayPool(this.#opts.relays())
    const unsub = this.#pool.subscribe([{ kinds: [0], authors: fresh }], (event) => this.#ingest(event))
    this.#unsubs.add(unsub)

    // A profile that never arrives is an answer too - "this key has never
    // published one" - so the lookup is closed rather than left open for
    // the life of the room. Nothing re-renders: a tile that never gained a
    // name or a chip already looks exactly right.
    const timer = setTimeout(() => {
      this.#unsubs.delete(unsub)
      unsub()
    }, LOOKUP_TIMEOUT_MS)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  get(pubkey: string): Profile | undefined {
    return this.#found.get(pubkey)?.profile
  }

  close(): void {
    this.#closed = true
    for (const unsub of this.#unsubs) unsub()
    this.#unsubs.clear()
    this.#pool?.close()
    this.#pool = undefined
  }

  /** Never throws: this runs inside a relay subscription handler. */
  #ingest(event: Event): void {
    try {
      if (event.kind !== 0) return
      if (!this.#asked.has(event.pubkey)) return
      // The pool filters by author, but a relay is not obliged to honour a
      // filter and a signature is the only thing that actually binds this
      // profile to that key.
      if (!verifyEventUncached(event)) return

      const existing = this.#found.get(event.pubkey)
      if (existing && existing.createdAt >= event.created_at) return

      const content = JSON.parse(event.content) as Record<string, unknown>
      const profile: Profile = {
        // A kind-0 name is attacker-controlled text off a relay exactly as
        // a roster name is, and gets exactly the same treatment.
        name: sanitiseDisplayName(content.display_name) ?? sanitiseDisplayName(content.name),
        picture: safePicture(content.picture),
      }
      this.#found.set(event.pubkey, { profile, createdAt: event.created_at })
      if (!this.#closed) this.#opts.onChange()
    } catch {
      // A malformed profile is a missing profile, not a broken room.
    }
  }
}

function safePicture(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const url = value.trim()
  // A profile is somebody else's JSON. `data:` and `javascript:` have no
  // business in an <img src> that this page renders.
  return PICTURE_SCHEMES.some((scheme) => url.toLowerCase().startsWith(scheme)) ? url : undefined
}
