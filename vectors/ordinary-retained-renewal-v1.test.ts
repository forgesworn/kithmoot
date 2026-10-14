import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { encodeOrdinaryImage, type OrdinaryImage } from '../app/src/ordinary-state-codec.js'
import { prepareOrdinaryRetainedRenewalCandidate } from '../app/src/ordinary-renewal-candidate.js'
import { readOrdinaryRenewalRequest, restoreOrdinaryRenewalPredecessor } from '../app/src/ordinary-renewal-request.js'
import { ordinaryOperationNames, validateOrdinaryOperationMarker } from '../app/src/ordinary-operation-codec.js'

interface Vector {
  syntheticTestFixture: true
  versionContract: string
  capturedFromNativeFactory: true
  request: string
  result: string
  seal: number[]
  enrolled: [string, string]
  expectedPlaintext: [string, string]
}
function image(raw: string): OrdinaryImage {
  const value = JSON.parse(raw)
  return { ...value, records: new Map(value.records), fences: new Map(value.fences),
    migration: value.migration ? { ...value.migration, sources: new Map(value.migration.sources) } : undefined }
}
function clear(value: OrdinaryImage): void {
  ;(value.records as Map<string, string>).clear(); (value.fences as Map<string, number>).clear()
  ;(value.migration?.sources as Map<string, string> | undefined)?.clear()
}

describe('immutable v1 retained-result frame plaintext contract', () => {
  for (const actor of ['account', 'visitor']) for (const keep of ['kept', 'tab']) for (const lineage of ['bootstrap', 'successor']) {
    const name = `${actor}-${keep}-${lineage}`
    it(`reproduces native ${name} plaintext byte for byte after expiry without entropy`, () => {
      const vector: Vector = JSON.parse(readFileSync(new URL(`./ordinary-retained-renewal-v1/${name}.json`, import.meta.url), 'utf8'))
      expect(vector.syntheticTestFixture).toBe(true)
      expect(vector.capturedFromNativeFactory).toBe(true)
      const request = readOrdinaryRenewalRequest(vector.request)
      expect(vector.versionContract).toBe(request.domain)
      expect(request.version).toBe(1)
      expect(request.intent.account === null).toBe(actor === 'visitor')
      expect(request.intent.keep).toBe(keep === 'kept')
      expect(request.intent.leaseSequence).toBe(lineage === 'bootstrap' ? 0 : 1)
      const enrolled = vector.enrolled.map(image) as [OrdinaryImage, OrdinaryImage]
      const predecessor = vector.enrolled.map(image) as [OrdinaryImage, OrdinaryImage]
      const marker = validateOrdinaryOperationMarker(enrolled[1].records.get(ordinaryOperationNames(enrolled[1].purpose as `tab:${string}`).marker)!)
      restoreOrdinaryRenewalPredecessor(predecessor[0], predecessor[1], vector.request, { id: marker.id, sequence: marker.sequence })
      const seal = Uint8Array.from(vector.seal)
      const random = vi.spyOn(crypto, 'getRandomValues').mockImplementation(() => { throw new Error('v1 recovery must not allocate entropy') })
      const clock = vi.spyOn(Date, 'now').mockReturnValue(request.intent.authority.tabExpiresAt + 43_200_000)
      let candidate: readonly [OrdinaryImage, OrdinaryImage] | undefined
      try {
        candidate = prepareOrdinaryRetainedRenewalCandidate(predecessor, vector.request, vector.result, seal, enrolled)
        for (const [i, value] of candidate.entries()) {
          const plaintext = encodeOrdinaryImage(value)
          try { expect(Buffer.from(plaintext).toString('base64')).toBe(vector.expectedPlaintext[i]) }
          finally { plaintext.fill(0) }
        }
        expect(random).not.toHaveBeenCalled()
      } finally {
        random.mockRestore(); clock.mockRestore(); seal.fill(0)
        for (const value of [...enrolled, ...predecessor, ...candidate ?? []]) clear(value)
      }
    })
  }
})
