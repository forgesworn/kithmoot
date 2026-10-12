import { OrdinaryStateHold, ORDINARY_NAME_UNITS, ordinaryUtf8Length } from './ordinary-state-codec.js'

const WAY_BACK = 'kithmoot.way-back', SWITCH = 'kithmoot.room-switch.v1'
function hold(): never { throw new OrdinaryStateHold() }
function object(v: unknown, fields: string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== fields.length || fields.some(k => !Object.hasOwn(v, k))) hold()
}
/** Shared primary UI writer shape. An opaque link/name or empty hash is inert
 * custody, not a usable room, account, permission or navigation instruction. */
export function validateOrdinaryNavigationRecord(name: string, raw: string): void {
  try {
    if (name.length > ORDINARY_NAME_UNITS || typeof raw !== 'string') hold()
    ordinaryUtf8Length(raw)
    const v: unknown = JSON.parse(raw)
    if (JSON.stringify(v) !== raw) hold()
    if (name === WAY_BACK) {
      object(v, ['link', 'name'])
      if (typeof v.link !== 'string' || !v.link || typeof v.name !== 'string') hold()
    } else if (name === SWITCH) {
      object(v, ['hash', 'account', 'at'])
      if (typeof v.hash !== 'string' || v.hash !== '' && !v.hash.startsWith('#') ||
          v.account !== null && (typeof v.account !== 'string' || !/^[0-9a-f]{64}$/.test(v.account)) ||
          !Number.isSafeInteger(v.at) || (v.at as number) < 0) hold()
    } else hold()
  } catch { return hold() }
}
declare const brand: unique symbol
export interface OrdinaryNavigationContext {
  readonly [brand]: true
  readonly wayBacks: number
  readonly roomSwitches: number
}
// Capture/consumption live together in the access module. No generic raw-value
// visitor is exported; its private context includes the exact access partition.
export { captureOrdinaryNavigationContext } from './ordinary-room-access-snapshot.js'
