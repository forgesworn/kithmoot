/** Uniform fraction in [0, 1), backed by the platform CSPRNG. Timing that
 * is visible on the wire must not share Math.random's predictable state. */
export function randomFraction(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 0x1_0000_0000
}
