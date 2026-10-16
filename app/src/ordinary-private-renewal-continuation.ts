/** @internal Canonical data only. Retained nonce bytes grant no authority.
 * Only fixed owner decisions may adopt them for a native phase transition. */
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import type { OrdinaryOperationPhase } from './ordinary-operation-codec.js'
export interface OrdinaryRenewalContinuationNonce {
  readonly slot: number
  readonly nonce: Uint8Array<ArrayBuffer>
}
const slots: Readonly<Record<OrdinaryOperationPhase, readonly number[]>> = Object.freeze({
  prepared: Object.freeze(Array.from({length: 14}, (_, i) => i + 4)),
  'provider-started': Object.freeze(Array.from({length: 12}, (_, i) => i + 6)),
  'provider-returned': Object.freeze(Array.from({length: 10}, (_, i) => i + 8)),
  'candidate-prepared': Object.freeze([8, 9, 12, 13, 14, 15, 16, 17]),
  'candidate-committed': Object.freeze([14, 15, 16, 17]),
  settled: Object.freeze([]),
})
export function ordinaryRenewalContinuationSlots(phase: OrdinaryOperationPhase): readonly number[] {
  if (typeof phase !== 'string' || !Object.hasOwn(slots, phase)) throw new OrdinaryStateHold()
  return slots[phase]
}
/** Capture native byte arrays without invoking shadow accessors. Returned
 * bytes belong to the consumer and must be wiped on every terminal path. */
export function copyOrdinaryRenewalContinuation(raw: unknown, phase: OrdinaryOperationPhase): OrdinaryRenewalContinuationNonce[] {
  const owned: OrdinaryRenewalContinuationNonce[] = []
  const refuse = (): never => { throw new OrdinaryStateHold() }
  try {
    const expected = ordinaryRenewalContinuationSlots(phase)
    if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) refuse()
    const fields = Object.getOwnPropertyDescriptors(raw), length = fields.length
    if (!length || !Object.hasOwn(length, 'value') || length.value !== expected.length || Reflect.ownKeys(fields).length !== expected.length + 1) refuse()
    for (let i = 0; i < expected.length; i++) {
      const item = fields[String(i)]
      if (!item || !item.enumerable || !Object.hasOwn(item, 'value')) refuse()
      const value = item.value
      if (!value || Object.getPrototypeOf(value) !== Object.prototype) refuse()
      const d = Object.getOwnPropertyDescriptors(value)
      if (Reflect.ownKeys(d).length !== 2 || !d.slot || !d.nonce || [d.slot, d.nonce].some(v => !v.enumerable || !Object.hasOwn(v, 'value')) || d.slot.value !== expected[i]) refuse()
      const bytes = d.nonce.value
      if (!(bytes instanceof Uint8Array) || Object.getPrototypeOf(bytes) !== Uint8Array.prototype) refuse()
      const b = Object.getOwnPropertyDescriptors(bytes), keys = Reflect.ownKeys(b)
      if (keys.length !== 12 || keys.some((k, n) => k !== String(n))) refuse()
      const nonce = new Uint8Array(12); owned.push({slot: expected[i]!, nonce})
      for (let n = 0; n < 12; n++) {
        const field = b[String(n)]!
        if (!field.enumerable || !Object.hasOwn(field, 'value') || !Number.isInteger(field.value) || field.value < 0 || field.value > 255) refuse()
        nonce[n] = field.value
      }
      if (!(bytes.buffer instanceof ArrayBuffer) || owned.slice(0, -1).some(v => v.nonce.every((b, n) => b === nonce[n]))) refuse()
    }
    return owned
  } catch { owned.forEach(v => v.nonce.fill(0)); return refuse() }
}
export function wipeOrdinaryRenewalContinuation(values: readonly OrdinaryRenewalContinuationNonce[] | undefined): void {
  values?.forEach(v => v.nonce.fill(0))
}
