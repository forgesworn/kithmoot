import { ProfileBook, type Profile, type ProfileBookOptions } from './profiles.js'

/** The signed-in account's metadata is account state, separate from the
 * optional directory lookups for other people. Private networking still
 * closes it, and an account change discards the old account's requests. */
export class AccountProfileBook {
  #account?: string
  #book?: ProfileBook

  constructor(private readonly options: ProfileBookOptions) {}

  select(account: string | undefined, networkEnabled: boolean): void {
    const selected = networkEnabled ? account : undefined
    if (selected === this.#account) return
    this.#book?.close()
    this.#book = undefined
    this.#account = selected
    if (selected) {
      this.#book = new ProfileBook(this.options)
      this.#book.want([selected], 'public')
    }
  }

  get(account: string): Profile | undefined {
    return account === this.#account ? this.#book?.get(account) : undefined
  }
}
