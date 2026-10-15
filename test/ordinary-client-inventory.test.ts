import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
// Execute the actual imported worker function; only listener registration is
// stubbed. This tests opaque IDs outside current browser UUID conventions.
const worker = readFileSync(new URL('../app/public/ordinary-state-sw.js', import.meta.url), 'utf8')
const same = runInNewContext(worker + '\nordinaryClientIdsSame', { self: { addEventListener() {} } }) as (a: unknown[], b: unknown[]) => boolean
describe('exact ordinary client inventory', () => {
  it('rejects colliding delimiter encodings of distinct opaque IDs', () => {
    expect(['a,b','c'].sort().join(',')).toBe(['a','b,c'].sort().join(','))
    expect(same(['a,b','c'], ['a','b,c'])).toBe(false)
  })
  it('accepts the same opaque IDs in a different order without editing either input', () => {
    const a=['z,\n','a'], b=['a','z,\n'];expect(same(a,b)).toBe(true)
    expect(a).toEqual(['z,\n','a']);expect(b).toEqual(['a','z,\n'])
  })
  it('rejects additions, duplicate replacements and Unicode substitutions', () => {
    expect(same(['a'],['a','b'])).toBe(false)
    expect(same(['a','a'],['a','b'])).toBe(false)
    expect(same(['é'],['e\u0301'])).toBe(false)
  })
  it('rejects non-string IDs instead of coercing them', () => {
    expect(same([1],['1'])).toBe(false)
    expect(same(['a'],[undefined])).toBe(false)
  })
})
