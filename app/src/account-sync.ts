import type { SignetSession } from 'signet-login'
import type { RelayTransport } from '../../src/relay-pool.js'
import type { SpryPairing } from '../../src/spry.js'
import type { ReadPositions } from '../../src/read-position.js'
import { signerSelfCrypt } from '../../src/read-position.js'
import { AccountNetwork, PRIVATE_SYNC_PAUSED, pausedAccountTransport } from './account-network.js'
import { RoomBookmarks, type BookmarkAdmissions } from './room-bookmarks.js'
import { ReadPositionSync } from './read-positions.js'
import { SpryAccountSync } from './spry-account-sync.js'
import type { DeviceStore } from './device-store.js'

/** Actual account-startup composition used by main.ts. Private startup opens
 * only the device-local bookmark journal, without optional signer crypto,
 * account pools, pending repairs or subscriptions. Existing pending entries
 * remain pending and resume only after the explicit Nostr choice. */
export function accountSyncServices(options: {
  network: AccountNetwork; account: SignetSession; store: DeviceStore
  pool(): RelayTransport; current(): boolean
  changed(): void; status(message: string): void
  admissions?: BookmarkAdmissions
  spry(pair: SpryPairing | null): void; spryStatus(message: string): void
  read(room: string, positions: ReadPositions): void
}) {
  const { network, account, store } = options
  const permitted = network.nostr, networkCurrent = network.current()
  let closed = false
  const current = () => !closed && permitted && networkCurrent() && options.current()
  const pools: RelayTransport[] = []
  const borrow = () => { const pool = options.pool(); pools.push(pool); return pool }
  const bookmarks = new RoomBookmarks(store, account.signer, permitted ? borrow() : pausedAccountTransport,
    () => { if (!permitted || current()) options.changed() },
    message => { if (current()) options.status(message) }, options.admissions, current)
  const spry = permitted && account.signer.nip44 ? new SpryAccountSync(store, account.signer, borrow(),
    pair => { if (current()) options.spry(pair) }, message => { if (current()) options.spryStatus(message) }, current) : undefined
  const read = permitted && account.signer.nip44 ? new ReadPositionSync(account.signer,
    signerSelfCrypt({ pubkey: account.signer.pubkey, nip44: account.signer.nip44 }), borrow(),
    (room, positions) => { if (current()) options.read(room, positions) }) : undefined
  const close = () => {
    if (closed) return
    closed = true; unlisten()
    spry?.close(); bookmarks.close(); read?.close()
    for (const pool of pools) pool.close()
  }
  const unlisten = network.listen(() => { if (!networkCurrent()) close() })
  return {
    bookmarks, spry, read,
    start() {
      if (!current()) { options.status(PRIVATE_SYNC_PAUSED); return }
      spry?.start(); bookmarks.start()
    },
    close,
  }
}
