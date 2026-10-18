import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { ordinaryImageByteLength, decodeOrdinaryImage, ORDINARY_IMAGE_BYTES, ORDINARY_VALUE_BYTES, OrdinaryStateHold, type OrdinaryImage } from './ordinary-state-codec.js'
import { ordinaryOperationNames, ordinaryOperationMarker, validateOrdinaryOperationMarker } from './ordinary-operation-codec.js'
import { restoreOrdinaryRenewalPredecessor } from './ordinary-renewal-request.js'
import { reserveOrdinaryPreparedRenewalImages, reserveOrdinaryPrivateRenewalImages } from './ordinary-prepared-renewal-capacity.js'
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

for (const actor of ['account','visitor']) for (const keep of ['kept','tab']) for (const lineage of ['bootstrap','successor']) {
  it(`reserves exact C and S sizes from independent ${actor}/${keep}/${lineage} plaintext vectors`,()=>{
    const vector=JSON.parse(readFileSync(new URL(`../../vectors/ordinary-retained-renewal-v1/${actor}-${keep}-${lineage}.json`,import.meta.url),'utf8'))
    const enrolled=vector.enrolled.map(image) as [OrdinaryImage,OrdinaryImage],predecessor=vector.enrolled.map(image) as [OrdinaryImage,OrdinaryImage]
    const name=ordinaryOperationNames(enrolled[1].purpose).marker,marker=validateOrdinaryOperationMarker(enrolled[1].records.get(name)!)
    restoreOrdinaryRenewalPredecessor(predecessor[0],predecessor[1],vector.request,{id:marker.id,sequence:marker.sequence})
    const expected=vector.expectedPlaintext.map((raw:string)=>{
      const c=decodeOrdinaryImage(Uint8Array.from(Buffer.from(raw,'base64'))),before=ordinaryImageByteLength(c)
      ;(c.records as Map<string,string>).set(name,ordinaryOperationMarker({...marker,commitment:'0'.repeat(64)}));c.revision++
      return Math.max(before,ordinaryImageByteLength(c))
    })
    expect(reserveOrdinaryPrivateRenewalImages(predecessor,enrolled,vector.request)).toEqual(expected)
  })
}
for(const owner of [0,1] as const)for(const boundary of ['C','S'])it(`checks owner ${owner} ${boundary} exact byte boundary and one-byte overflow without entropy`,()=>{
  // This is a pure image-size test. Padding grants no snapshot, native role,
  // mutation or signing authority; native callers still owe all such checks.
  const vector=JSON.parse(readFileSync(new URL('../../vectors/ordinary-retained-renewal-v1/account-tab-bootstrap.json',import.meta.url),'utf8'))
  const enrolled=vector.enrolled.map(image) as [OrdinaryImage,OrdinaryImage],predecessor=vector.enrolled.map(image) as [OrdinaryImage,OrdinaryImage]
  const marker=validateOrdinaryOperationMarker(enrolled[1].records.get(ordinaryOperationNames(enrolled[1].purpose).marker)!)
  restoreOrdinaryRenewalPredecessor(predecessor[0],predecessor[1],vector.request,{id:marker.id,sequence:marker.sequence})
  for(const selected of [predecessor[owner],enrolled[owner]])for(let i=0;i<4;i++)(selected.records as Map<string,string>).set('capacity-fixture.'+i,i<3?'x'.repeat(ORDINARY_VALUE_BYTES-1):'')
  const reserve=boundary==='C'?reserveOrdinaryPreparedRenewalImages:reserveOrdinaryPrivateRenewalImages
  const missing=ORDINARY_IMAGE_BYTES-reserve(predecessor,enrolled,vector.request)[owner]
  expect(missing).toBeGreaterThan(0);expect(missing).toBeLessThan(ORDINARY_VALUE_BYTES)
  for(const selected of [predecessor[owner],enrolled[owner]])(selected.records as Map<string,string>).set('capacity-fixture.3','x'.repeat(missing))
  const random=vi.spyOn(crypto,'getRandomValues')
  try{
    expect(reserve(predecessor,enrolled,vector.request)[owner]).toBe(ORDINARY_IMAGE_BYTES)
    if(boundary==='C')expect(()=>reserveOrdinaryPrivateRenewalImages(predecessor,enrolled,vector.request)).toThrow(OrdinaryStateHold)
    for(const selected of [predecessor[owner],enrolled[owner]])(selected.records as Map<string,string>).set('capacity-fixture.3','x'.repeat(missing+1))
    expect(()=>reserve(predecessor,enrolled,vector.request)).toThrow(OrdinaryStateHold);expect(random).not.toHaveBeenCalled()
  }finally{random.mockRestore()}
},60_000)
