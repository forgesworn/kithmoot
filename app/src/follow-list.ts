import { verifyEventUncached } from '../../src/index.js'
import type { RelayPoolClient } from '../../src/relay-pool.js'
import type { Event } from 'nostr-tools/pure'

/**
 * The signed-in account's public follow list (NIP-02, kind 3), read only.
 *
 * People shows these as "Following" beside the Signet contacts, so somebody
 * signed in with their Nostr account sees the people they already follow.
 * KithMoot never writes a follow list.
 *
 * What it costs: one request for the account's own kind 3, sent to the same
 * public relays as profile lookups and only while that switch is on. Those
 * relays learn that this connection asked for this account's follows. The
 * list itself is already public, so looking up the followed people's names
 * afterwards tells them nothing the list did not.
 */
export interface FollowSnapshot {
  /** `off`: profile lookups are switched off. `none`: signed out. */
  status: 'off' | 'none' | 'loading' | 'ready'
  /** Followed public keys, in the list's own order, without duplicates. */
  pubkeys: string[]
  /** When the account published the list in use, in seconds. */
  createdAt?: number
}

export interface FollowBookOptions {
  relays: () => string[]
  onChange: () => void
  transport: (relays: string[]) => RelayPoolClient
}

/** How long to wait for the list before showing what has arrived. */
const LOOKUP_TIMEOUT_MS = 5_000
const HEX = /^[0-9a-f]{64}$/

/** The followed keys in a kind-3 event: `p` tags with a valid key, first
 *  mention wins, never the author themselves. */
export function followedKeys(event: Pick<Event, 'pubkey' | 'tags'>): string[] {
  const seen = new Set<string>()
  for (const tag of event.tags) {
    if (tag[0] !== 'p' || typeof tag[1] !== 'string') continue
    const key = tag[1].toLowerCase()
    if (!HEX.test(key) || key === event.pubkey || seen.has(key)) continue
    seen.add(key)
  }
  return [...seen]
}

export class FollowBook {
  readonly #opts: FollowBookOptions
  #account: string | undefined
  #enabled = true
  #pool?: RelayPoolClient
  #unsub?: () => void
  #timer?: ReturnType<typeof setTimeout>
  #loading = false
  /** Whether this account's list has been asked for since it was set. */
  #asked = false
  #list?: { pubkeys: string[]; createdAt: number }

  constructor(opts: FollowBookOptions) {
    this.#opts = opts
  }

  /** The account whose list to read, or none when signed out. Changing it
   *  drops the old list at once. */
  setAccount(account: string | undefined): void {
    if (account === this.#account) return
    this.#stop()
    this.#account = account
    this.#list = undefined
    this.#asked = false
    this.#opts.onChange()
  }

  /** Follows the public-profile lookups switch. Off closes the request and
   *  forgets the list. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) return
    this.#enabled = enabled
    if (!enabled) { this.#stop(); this.#list = undefined }
    this.#asked = false
    this.#opts.onChange()
  }

  /** Ask the relays again. Called when People opens, and harmless to call
   *  while a request is already out. */
  refresh(): void {
    const account = this.#account
    if (!account || !this.#enabled || this.#loading) return
    this.#asked = true
    let unsub: () => void
    try {
      this.#pool ??= this.#opts.transport(this.#opts.relays())
      unsub = this.#pool.subscribe([{ kinds: [3], authors: [account], limit: 1 }], event => this.#ingest(account, event))
    } catch {
      // A relay that cannot be opened leaves People with its contacts only.
      return
    }
    this.#loading = true
    this.#unsub = unsub
    this.#timer = setTimeout(() => {
      this.#loading = false
      this.#unsub?.(); this.#unsub = undefined
      this.#opts.onChange()
    }, LOOKUP_TIMEOUT_MS)
    ;(this.#timer as unknown as { unref?: () => void }).unref?.()
    this.#opts.onChange()
  }

  /** Asks once for this account, for a caller other than People: an
   *  invitation from somebody followed is named before People has ever been
   *  opened. People itself asks again each time it opens (`refresh`). */
  ensure(): void {
    if (!this.#asked) this.refresh()
  }

  snapshot(): FollowSnapshot {
    if (!this.#enabled) return { status: 'off', pubkeys: [] }
    if (!this.#account) return { status: 'none', pubkeys: [] }
    if (!this.#list) return { status: this.#loading ? 'loading' : 'ready', pubkeys: [] }
    return { status: 'ready', pubkeys: this.#list.pubkeys, createdAt: this.#list.createdAt }
  }

  /** Whether the signed-in account follows this key, by the list in hand. */
  follows(pubkey: string): boolean {
    return this.#enabled && !!this.#list?.pubkeys.includes(pubkey)
  }

  close(): void {
    this.#stop()
    this.#pool?.close()
    this.#pool = undefined
  }

  #stop(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#unsub?.(); this.#unsub = undefined
    this.#loading = false
  }

  /** Never throws: this runs inside a relay subscription handler. */
  #ingest(account: string, event: Event): void {
    try {
      if (!this.#enabled || account !== this.#account) return
      if (event.kind !== 3 || event.pubkey !== account) return
      // A relay need not honour the filter; the signature is what binds the
      // list to this account.
      if (!verifyEventUncached(event)) return
      if (this.#list && this.#list.createdAt >= event.created_at) return
      this.#list = { pubkeys: followedKeys(event), createdAt: event.created_at }
      this.#opts.onChange()
    } catch {
      // A malformed list is a missing list, not a broken page.
    }
  }
}
