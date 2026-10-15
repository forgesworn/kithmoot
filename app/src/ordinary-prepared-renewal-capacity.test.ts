import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import type { OrdinaryImage } from './ordinary-state-codec.js'
import { ordinaryOperationNames, validateOrdinaryOperationMarker } from './ordinary-operation-codec.js'
import { restoreOrdinaryRenewalPredecessor } from './ordinary-renewal-request.js'
import { reserveOrdinaryPreparedRenewalImages } from './ordinary-prepared-renewal-capacity.js'
const image = (raw: string): OrdinaryImage => {
  const value = JSON.parse(raw)
  return { ...value, records: new Map(value.records), fences: new Map(value.fences), migration: { ...value.migration, sources: new Map(value.migration.sources) } }
}
for (const actor of ['account', 'visitor']) for (const keep of ['kept', 'tab']) for (const lineage of ['bootstrap', 'successor']) {
  it(`reserves the complete native ${actor}/${keep}/${lineage} C image sizes without signing`, () => {
    const vector = JSON.parse(readFileSync(new URL(`../../vectors/ordinary-retained-renewal-v1/${actor}-${keep}-${lineage}.json`, import.meta.url), 'utf8'))
    const enrolled = vector.enrolled.map(image) as [OrdinaryImage, OrdinaryImage], predecessor = vector.enrolled.map(image) as [OrdinaryImage, OrdinaryImage]
    const marker = validateOrdinaryOperationMarker(enrolled[1].records.get(ordinaryOperationNames(enrolled[1].purpose).marker)!)
    restoreOrdinaryRenewalPredecessor(predecessor[0], predecessor[1], vector.request, { id: marker.id, sequence: marker.sequence })
    expect(reserveOrdinaryPreparedRenewalImages(predecessor, enrolled, vector.request)).toEqual(vector.expectedPlaintext.map((raw: string) => Buffer.from(raw, 'base64').length))
  })
}
