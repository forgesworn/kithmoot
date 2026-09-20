/**
 * The pure part of "what name do we show for this key right now" - pulled
 * out of `main.ts` so it can be tested without a DOM. See `shownAs` in
 * `main.ts` for the caller, which supplies the live profile, the stored
 * remembered name and the announced/joining name, and writes any new
 * remembered name back to `deviceStore`.
 */

/**
 * A fresh kind-0 profile always wins - it is the newest, most verified
 * answer there is. While none has arrived, a name this device has seen a
 * verified profile carry for this exact key before beats the name
 * announced on the roster: that remembered name is what stops the
 * announced name flashing on screen for a second or two every time this
 * key shows up, on this visit and on the next. With profile lookups
 * switched off, no profile will ever arrive to correct a stale remembered
 * one, so a remembered name is never shown and the announced name - the
 * only thing actually being looked at - is the honest answer.
 */
export function resolveShownName(opts: {
  profileName: string | undefined
  rememberedName: string | undefined
  assertedName: string | undefined
  profilesEnabled: boolean
}): string | undefined {
  if (opts.profileName) return opts.profileName
  if (opts.profilesEnabled && opts.rememberedName) return opts.rememberedName
  return opts.assertedName
}

/**
 * The last name a verified profile carried for each key that has ever had
 * one. Keyed by pubkey, never by the name itself: an announced name is
 * somebody's own unverified claim and never earns a place here, only a
 * profile that came back signed by the key it is about. Bounded and
 * insertion-ordered so the oldest entry is the first one dropped once the
 * store is full.
 */
export class LastKnownNames {
  readonly #names: Map<string, string>
  readonly #max: number

  constructor(max = 500, seed?: Iterable<readonly [string, string]>) {
    this.#max = max
    this.#names = new Map(seed)
  }

  get(pubkey: string): string | undefined {
    return this.#names.get(pubkey)
  }

  /** Records a fresh profile name for a key. Returns true when it changed
   *  something worth persisting. */
  remember(pubkey: string, name: string): boolean {
    if (this.#names.get(pubkey) === name) return false
    this.#names.delete(pubkey)
    this.#names.set(pubkey, name)
    while (this.#names.size > this.#max) {
      const oldest = this.#names.keys().next().value
      if (oldest === undefined) break
      this.#names.delete(oldest)
    }
    return true
  }

  toRecord(): Record<string, string> {
    return Object.fromEntries(this.#names)
  }
}
