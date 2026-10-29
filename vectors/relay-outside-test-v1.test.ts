import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { RELAY_TEST_STAGES, relayTestFinding, relayTestVerdict, validRelayTestRequest, validRelayTestResult } from '../src/relay-test.js'
import { unwrapSignalEvent } from '../src/signal.js'

const vectors = JSON.parse(readFileSync(new URL('./relay-outside-test-v1.json', import.meta.url), 'utf8'))

describe('relay-outside-test-v1 vectors', () => {
  it('names the same stages as the codec, and covers acceptance and refusal', () => {
    expect(vectors.stages).toEqual([...RELAY_TEST_STAGES])
    for (const group of ['requests', 'results'] as const) {
      expect(vectors[group].some((v: { accept: boolean }) => v.accept), group).toBe(true)
      expect(vectors[group].some((v: { accept: boolean }) => !v.accept), group).toBe(true)
    }
    expect(vectors.wraps.some((v: { expect: unknown }) => v.expect === null)).toBe(true)
  })
  for (const v of vectors.requests) it(`request: ${v.name}`, () => expect(validRelayTestRequest(v.relayTest)).toBe(v.accept))
  for (const v of vectors.results) it(`result: ${v.name}`, () => expect(validRelayTestResult(v.relayTest)).toBe(v.accept))
  for (const v of vectors.verdicts) {
    it(`verdict: ${v.name}`, () => {
      const verdict = relayTestVerdict(v.observations)
      expect(verdict).toEqual(v.verdict)
      expect(validRelayTestResult({ id: '0123456789abcdef', endpoint: vectors.endpoint, ...verdict })).toBe(true)
      expect(relayTestFinding(verdict)).toBe(v.finding)
    })
  }
  for (const v of vectors.notRun) it(`finding: ${v.name}`, () => expect(relayTestFinding(v.result)).toBe(v.finding))
  for (const v of vectors.wraps) {
    it(`wrap: ${v.name}`, () => {
      const unwrapped = unwrapSignalEvent(v.event, { recipientSk: new Uint8Array(32).fill(v.recipientKeyRepeatedByte), roomId: vectors.roomId, now: v.now })
      if (v.expect === null) expect(unwrapped).toBeNull()
      else expect({ from: unwrapped?.from, createdAt: unwrapped?.createdAt, body: unwrapped?.body }).toEqual(v.expect)
    })
  }
})
