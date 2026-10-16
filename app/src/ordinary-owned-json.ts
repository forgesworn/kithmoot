import { OrdinaryStateHold } from './ordinary-state-codec.js'
function hold(): never {throw new OrdinaryStateHold()}

/** Canonical JSON for bounded owned data. Unlike JSON.stringify on objects,
 * this never looks up toJSON or reads inherited/accessor values. It grants no
 * native provenance; callers still authenticate every source independently. */
export function ordinaryOwnedJSON(input: unknown): string {
  let nodes = 0, units = 0
  const encode = (value: unknown, depth: number): string => {
    if (++nodes > 16_384 || depth > 32) hold()
    if (value === null) return 'null'
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    if (typeof value === 'number') {if (!Number.isFinite(value)) hold(); return String(value)}
    if (typeof value === 'string') {if ((units += value.length) > 1_048_576) hold(); return JSON.stringify(value)}
    if (!value || typeof value !== 'object') hold()
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) hold()
    const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(fields)
    const field = (name: string): unknown => {
      const d = Object.getOwnPropertyDescriptor(fields, name)?.value as PropertyDescriptor | undefined
      if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) hold()
      return d.value
    }
    if (array) {
      const length = Object.getOwnPropertyDescriptor(fields, 'length')?.value as PropertyDescriptor | undefined
      if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) || length.value < 0 ||
          length.value > 16_384 || keys.length !== length.value + 1) hold()
      return '[' + Array.from({length: length.value}, (_, i) => encode(field(String(i)), depth + 1)).join(',') + ']'
    }
    if (keys.some(key => typeof key !== 'string')) hold()
    return '{' + keys.map(key => {
      const name = key as string
      if ((units += name.length) > 1_048_576) hold()
      return JSON.stringify(name) + ':' + encode(field(name), depth + 1)
    }).join(',') + '}'
  }
  return encode(input, 0)
}
