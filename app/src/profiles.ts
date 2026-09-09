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
 * Robin", exactly as a typed name says "whoever is at this keyboard calls
 * themselves Robin". The difference is only that the key is persistent and
 * has a history - which is worth something, and is not the same as being
 * verified. The app labels it accordingly and never as "verified".
 *
 * **And be precise about what it costs, because it is not free.** The
 * lookup is a relay subscription filtered by `authors`, sent to the ROOM's
 * own relays - see `ProfileBookOptions.relays`, which chooses them
 * deliberately so a lookup follows the room. That hands those relays the
 * participant pubkeys of everybody in the room, in the clear, as a query.
 *
 * The room's own design goes to some trouble to avoid exactly that: a
 * device credential is never published, precisely so "relays never see the
 * participant pubkey" (`KINDS.CREDENTIAL`), and the roster it travels in is
 * encrypted to the room key. A relay carrying a room therefore sees the
 * room id and the timing of its roster events, and - because of this file
 * and nothing else - can also learn which participant keys are in it.
 *
 * The app enables lookups by default, with a persistent switch in profile
 * settings. Disabling closes subscriptions and removes cached profiles and
 * external pictures. NIP-05 checks also contact the address domains with no
 * cookies or referrer. Disabling aborts those checks. It cannot undo a request already sent.
 *
 * Anything built on top of this - a lookup keyed on participant pubkeys for
 * any other purpose - inherits the same cost and does not add a new one.
 */
export interface Profile {
  /** From kind 0's `display_name` or `name`, sanitised like any other. */
  name?: string
  /** An `http:`/`https:` picture URL. Anything else is dropped. */
  picture?: string
  /** NIP-05 address, included only after its domain maps it to this key. */
  nip05?: string
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
  transport?: (relays: string[]) => NostrRelayPool
}

export class ProfileBook {
  readonly #opts: ProfileBookOptions
  #pool?: NostrRelayPool
  #unsubs = new Set<() => void>()
  /** Pubkeys we have asked about, whether or not an answer came back. */
  readonly #asked = new Set<string>()
  readonly #found = new Map<string, { profile: Profile; createdAt: number }>()
  #checks = new Set<AbortController>()
  #closed = false
  #enabled = true

  constructor(opts: ProfileBookOptions) {
    this.#opts = opts
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled
    if (enabled) return
    for (const check of this.#checks) check.abort()
    this.#checks.clear()
    for (const unsub of this.#unsubs) unsub()
    this.#unsubs.clear()
    this.#pool?.close()
    this.#pool = undefined
    this.#asked.clear()
    this.#found.clear()
  }

  /** Look up any of these we have not already asked about. Cheap to call
   *  on every render; it does nothing for a pubkey it has already seen. */
  want(pubkeys: string[]): void {
    if (this.#closed || !this.#enabled) return
    const fresh = [...new Set(pubkeys)].filter((p) => !this.#asked.has(p))
    if (fresh.length === 0) return
    for (const pubkey of fresh) this.#asked.add(pubkey)

    // Lazily, so a browser that never opens a room never opens a socket.
    // And guarded: a profile is decoration, and a relay that cannot be
    // opened - a blocked host, a bad URL, a browser that refuses the
    // socket - must never take the door or the room down with it. The
    // caller is `render()`.
    let unsub: () => void
    try {
      this.#pool ??= this.#opts.transport?.(this.#opts.relays()) ?? new NostrRelayPool(this.#opts.relays())
      unsub = this.#pool.subscribe([{ kinds: [0], authors: fresh }], (event) => this.#ingest(event))
    } catch {
      return
    }
    this.#unsubs.add(unsub)

    // A profile that never arrives was not found on these relays. It may
    // exist elsewhere. Close the lookup rather than leaving it open for
    // the life of the room. Nothing re-renders: a tile that never gained a
    // name or a chip already looks exactly right.
    const timer = setTimeout(() => {
      this.#unsubs.delete(unsub)
      unsub()
    }, LOOKUP_TIMEOUT_MS)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  get(pubkey: string): Profile | undefined {
    return this.#enabled ? this.#found.get(pubkey)?.profile : undefined
  }

  close(): void {
    this.#closed = true
    for (const check of this.#checks) check.abort()
    this.#checks.clear()
    for (const unsub of this.#unsubs) unsub()
    this.#unsubs.clear()
    this.#pool?.close()
    this.#pool = undefined
  }

  async #checkAddress(pubkey: string, profile: Profile, value: unknown): Promise<void> {
    if (typeof value !== 'string') return
    const match = /^([a-z0-9_.-]+)@([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i.exec(value)
    if (!match || value.length > 254) return
    const [, name, domain] = match
    const controller = new AbortController()
    this.#checks.add(controller)
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS)
    try {
      const response = await fetch(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name!)}`, {
        signal: controller.signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
      })
      if (!response.ok) return
      const body = await response.json()
      if (body?.names?.[name!] !== pubkey) return
      // A response for an older profile or a disabled lookup cannot put
      // stale metadata back on screen.
      if (controller.signal.aborted || this.#closed || !this.#enabled || this.#found.get(pubkey)?.profile !== profile) return
      profile.nip05 = value
      this.#opts.onChange()
    } catch { /* An unreachable domain is not a confirmed Nostr address. */ }
    finally { clearTimeout(timer); this.#checks.delete(controller) }
  }

  /** Never throws: this runs inside a relay subscription handler. */
  #ingest(event: Event): void {
    try {
      if (this.#closed || !this.#enabled) return
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
      void this.#checkAddress(event.pubkey, profile, content.nip05)
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
