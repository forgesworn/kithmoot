import { OrdinaryStateHold, ordinaryUtf8Length } from './ordinary-state-codec.js'
import { validateOrdinaryNip44Framing } from './ordinary-journal-snapshot.js'
const ROOT = 'kithmoot.room-boards'
const NAME = /^kithmoot\.room-boards\.v1\.([0-9a-f]{64})\.([0-9a-f]{64})$/
function hold(): never {throw new OrdinaryStateHold()}
/** Opaque encrypted catalogue custody only. The visible NIP-44 frame cannot
 * authenticate recipient, room, MAC, plaintext or invitation. Those bindings
 * must be checked by the awaited current-room restorer before any grant escapes.
 * No decryption, loader, network call, entropy or pruning occurs here. */
export function validateOrdinaryRoomBoardSnapshot(records: ReadonlyMap<string,string>, _migrated: boolean,
  options: {kind:'browser'|'tab'}): Readonly<{catalogues:number; chunks:number}> {
  const counts = {catalogues:0,chunks:0}
  try {
    if (!['browser','tab'].includes(options.kind)) hold()
    for (const [name,raw] of records) {
      if (name.startsWith('kithmoot.account.') && name.includes('.'+ROOT)) hold()
      if (name !== ROOT && !name.startsWith(ROOT+'.')) continue
      if (options.kind !== 'browser' || !NAME.test(name) || typeof raw !== 'string' || raw.length >= 250000) hold()
      ordinaryUtf8Length(raw)
      const value: unknown = JSON.parse(raw)
      if (JSON.stringify(value) !== raw || !value || typeof value !== 'object' || Array.isArray(value) ||
          Object.keys(value).join(',') !== 'chunks' || !('chunks' in value) || !Array.isArray(value.chunks) ||
          value.chunks.length < 1 || value.chunks.length > 10) hold()
      for (const chunk of value.chunks) validateOrdinaryNip44Framing(chunk)
      counts.catalogues++; counts.chunks += value.chunks.length
    }
    return Object.freeze(counts)
  } catch {return hold()}
}
