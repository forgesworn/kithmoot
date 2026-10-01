// The conference-room expiration rule lives in @forgesworn/fold-kit beside
// the group invitation that carries a room's end. Re-exported here so the
// encoders below can apply it without each reaching into the kit.
//
// A conference room is a persistent group with a fixed end. Every event a
// member signs for it carries `['expiration', String(ends)]` (NIP-40): one
// with no expiration gains it, an earlier one is kept, a later one lowered.
// With no end, `withExpiration` hands back the very same tags, so a room
// that never ends signs exactly the bytes it always did.
export { withExpiration, isRoomEnds, requireRoomEnds, MAX_ROOM_ENDS_SECONDS } from '@forgesworn/fold-kit'
