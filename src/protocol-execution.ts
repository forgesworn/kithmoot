/** Synchronous protocol preparation inside an embedding's freshly authorised
 * execution boundary. An executor is an additional restriction, not room
 * membership authority. Its check must reject outside the active boundary.
 * Provider/network promises must be started synchronously and awaited outside
 * run; never return a thenable from the effect itself. */
export interface ProtocolExecution {
  run<T>(operation: string, effect: () => T): Promise<T>
  check(operation: string): void
  /** Resource ownership only, never permission to run an effect. */
  retain<T>(work: Promise<T>): Promise<T>
}

/** Capture bounded plain data without invoking accessor-backed fields. This
 * parses caller input; it neither grants custody nor runs protocol effects. */
export function captureProtocolData<T>(input: T): T {
  let nodes = 0, units = 0
  const fail = (): never => { throw new Error('protocol input must be bounded plain data') }
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 16_384 || depth > 16) fail()
    if (value === null || value === undefined || typeof value === 'boolean') return value
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); return value }
    if (typeof value === 'string') { if ((units += value.length) > 1_048_576) fail(); return value }
    if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) fail()
    const field = (key: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail()
      return copy(descriptor!.value, depth + 1)
    }
    if (Array.isArray(value)) {
      if (value.length > 16_384) fail()
      return Array.from({ length: value.length }, (_, index) => field(String(index)))
    }
    const result: Record<string, unknown> = {}
    for (const key of Object.getOwnPropertyNames(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail()
      units += key.length; if (units > 1_048_576) fail()
      result[key] = field(key)
    }
    return result
  }
  return copy(input, 0) as T
}
