export const MLS_ROOM_LINK_OWNER = 'kithmoot-vmls-room-link-v1'
export const MLS_ROOM_LINK_NAMES = MLS_ROOM_LINK_OWNER + ':names'

/** Read-only browser-wide guard. Any retained or interrupted room custody is
 * held, including malformed/empty stores. Never open a database to discover it;
 * no database, naming key, endpoint or account slot is created by this check. */
export async function hasMlsRoomLinkCustody(): Promise<boolean> {
  if (!globalThis.indexedDB?.databases) throw new Error('Room connection custody cannot be checked in this browser.')
  return (await indexedDB.databases()).some(db => db.name === MLS_ROOM_LINK_OWNER || db.name?.startsWith(MLS_ROOM_LINK_OWNER + ':'))
}

/** The final read and entire deletion share the room writer's exact native
 * barrier, including an initially empty browser. A transient Web Lock is the
 * only state this guard acquires. A competing/failed endpoint stays held;
 * absence is never permission to race a late first-seed writer. */
export async function withMlsRoomLinkForgetGuard(work: () => Promise<void>): Promise<boolean> {
  if (!navigator.locks) {
    if (await hasMlsRoomLinkCustody()) return false
    // A room endpoint cannot acquire ownership or create secrets without locks.
    await work(); return true
  }
  return navigator.locks.request(MLS_ROOM_LINK_OWNER, { ifAvailable: true }, async lock => {
    if (!lock || await hasMlsRoomLinkCustody()) return false
    await work(); return true
  })
}
