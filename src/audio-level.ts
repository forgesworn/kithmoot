/**
 * How loud a block of audio is.
 *
 * Lifted out of `node/utterances.ts` so the browser can use it too. The
 * scribe splits utterances on silence and the room lights up a tile when
 * somebody talks, and those are the same question asked twice: how much
 * energy is in this block. One definition, so the two answers stay
 * comparable - `SPEAKING.off` sitting at the splitter's silence threshold is
 * a fact about the numbers, not a coincidence to be maintained by hand.
 *
 * Runtime-agnostic: numbers in, numbers out. Nothing here touches an
 * AudioContext, a track or the DOM.
 */

/** Root mean square of a block of samples in -1..1. Zero for an empty block. */
export function rms(block: Float32Array): number {
  if (block.length === 0) return 0
  let sum = 0
  for (let i = 0; i < block.length; i++) sum += block[i]! * block[i]!
  return Math.sqrt(sum / block.length)
}

/**
 * Root mean square of `AnalyserNode.getByteTimeDomainData` output.
 *
 * That call fills a `Uint8Array` where silence is 128, not 0 - it is an
 * unsigned byte encoding of a signal centred on zero. Taking the RMS of the
 * raw bytes would report near-maximum energy for a completely silent room,
 * which is the bug this function exists to make impossible to write by
 * accident.
 *
 * 128 is the divisor rather than 127.5 because the error is a fortieth of a
 * decibel and a threshold with a divisor nobody can explain is worse than a
 * threshold that is a hair off.
 */
export function rmsFromByteTimeDomain(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0
  let sum = 0
  for (let i = 0; i < bytes.length; i++) {
    const centred = (bytes[i]! - 128) / 128
    sum += centred * centred
  }
  return Math.sqrt(sum / bytes.length)
}
