import { expect, test } from 'vitest'
import { fillMaskHoles } from './video-effects.js'

// Define holes independently as connected sets of coordinates, instead of
// sharing production's border flood, typed work queue or span traversal.
function expectedHoles(input: Float32Array, width: number, height: number, cut: number, confidence: number, fraction: number): Float32Array {
  const output = input.slice()
  const pending = new Set<string>()
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (input[y * width + x]! < cut) pending.add(`${x},${y}`)
  }
  while (pending.size) {
    const first = pending.values().next().value!
    pending.delete(first)
    const component = new Set([first])
    const work = [first]
    let border = false
    for (const point of work) {
      const [x, y] = point.split(',').map(Number) as [number, number]
      border ||= x === 0 || y === 0 || x === width - 1 || y === height - 1
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        const neighbour = `${nx},${ny}`
        if (pending.delete(neighbour)) {
          component.add(neighbour)
          work.push(neighbour)
        }
      }
    }
    if (!border && component.size <= Math.floor(width * height * fraction)) {
      for (const point of component) {
        const [x, y] = point.split(',').map(Number) as [number, number]
        const i = y * width + x
        if (output[i]! < confidence) output[i] = confidence
      }
    }
  }
  return output
}

// Keep oversized, dirty scratch buffers between masks, as the live smoother
// does between frames and after the segmentation dimensions change.
let visited = new Uint8Array(0)
let stack = new Int32Array(0)
function check(input: Float32Array, width: number, height: number, cut: number, confidence: number, fraction: number): void {
  if (visited.length < input.length) {
    visited = new Uint8Array(input.length)
    stack = new Int32Array(input.length)
  }
  visited.fill(237)
  stack.fill(-17)
  const actual = input.slice()
  fillMaskHoles(actual, width, height, visited, stack, cut, confidence, fraction)
  const expected = expectedHoles(input, width, height, cut, confidence, fraction)
  expect(Buffer.from(actual.buffer).equals(Buffer.from(expected.buffer)),
    `hole semantics ${width}x${height}, cut=${cut}, fill=${confidence}, cap=${fraction}`).toBe(true)
}

test.each([[0, 0], [1, 1], [1, 6], [6, 1], [2, 3], [3, 3], [4, 3]])(
  'all binary %ix%i masks preserve four-connected border reachability and hole caps', (width, height) => {
    for (let bits = 0; bits < 2 ** (width * height); bits++) {
      const input = Float32Array.from({ length: width * height }, (_, i) => bits & (1 << i) ? .95 : .1)
      for (const fraction of [0, 1 / Math.max(1, input.length), .25, 1]) check(input, width, height, .55, .9, fraction)
    }
  }, 30_000)

test('4,000 reproducible finite masks match independent components across thresholds, confidence and caps', () => {
  let seed = 617
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  for (let sample = 0; sample < 4000; sample++) {
    const width = 1 + Math.floor(random() * 61), height = 1 + Math.floor(random() * 57)
    const input = Float32Array.from({ length: width * height }, () => random())
    check(input, width, height, [0, .3, .55, .9, 1][sample % 5]!, [.2, .4, .9, 1][sample % 4]!, [0, .12, .25, 1][sample % 4]!)
  }
}, 30_000)

test.each([[256, 256], [640, 480]])('a complete %ix%i background is never turned into foreground', (width, height) => {
  const input = new Float32Array(width * height).fill(.1)
  const actual = input.slice()
  const visited = new Uint8Array(input.length).fill(237)
  fillMaskHoles(actual, width, height, visited, new Int32Array(input.length).fill(-17), .55, .9, 1)
  expect(Buffer.from(actual.buffer).equals(Buffer.from(input.buffer))).toBe(true)
  expect(visited.every(value => value === 1)).toBe(true)
})
