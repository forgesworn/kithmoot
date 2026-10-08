/** Picker access is separate from rendering: everyone sees received pack content. */
export const CULT_EMOJIS = [
  [':600:', '600 billion'], [':600_spin:', '600 spin'], [':600_rainbow:', '600 rainbow'],
  [':600_moon:', '600 to the moon'], [':600_fire:', '600 fire'], [':600_facepalm:', '600 facepalm'],
  [':600_handshake:', '600 handshake'], [':600_laser:', '600 laser eyes'],
] as const
export function isCultEmoji(value: unknown): value is string { return CULT_EMOJIS.some(([code]) => code === value) }
