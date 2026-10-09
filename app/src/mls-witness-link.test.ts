import { describe, expect, it, vi } from 'vitest'
import { MlsWitnessLink, witnessAnswer } from './mls-witness-link.js'
import type { LinkRequest, LinkResponse } from './browser-link-types.js'

const receipt = (status = 200, byte = 0): LinkResponse => ({ status, body: Uint8Array.from({length:170}, (_,i) => i === 0 ? 1 : i === 1 ? byte : 0), witnessRefused:false,
  path:{status:'Ready',relay:null,direct:null,cause:''} })

describe('browser witness Link boundary', () => {
  it.each([[200,0],[409,1],[410,2]])('passes a status-matched %i receipt to the coordinator', (status,byte) => {
    const response=receipt(status,byte), answer=witnessAnswer(response)
    expect(answer.type).toBe('receipt')
    if(answer.type==='receipt'){expect(answer.bytes).toEqual(response.body);response.body.fill(9);expect(answer.bytes[0]).toBe(1)}
  })
  it.each([200,409,410])('holds a %i answer with a mismatched receipt status', status => {
    expect(witnessAnswer(receipt(status,3))).toEqual({type:'unavailable'})
  })
  it.each([0,169,171,1_048_576])('holds an answer of %i bytes', length => {
    expect(witnessAnswer({...receipt(),body:new Uint8Array(length)})).toEqual({type:'unavailable'})
  })
  it('distinguishes witness refusal from router denial, exhaustion and unsupported receipt versions', () => {
    expect(witnessAnswer({...receipt(403),witnessRefused:true})).toEqual({type:'refused'})
    expect(witnessAnswer(receipt(403))).toEqual({type:'unavailable'})
    expect(witnessAnswer({...receipt(409),body:new Uint8Array()})).toEqual({type:'unavailable'})
    const response=receipt();response.body[0]=2
    expect(witnessAnswer(response)).toEqual({type:'unavailable'})
    expect(witnessAnswer(receipt(503))).toEqual({type:'unavailable'})
  })
  it('uses only the pinned persona route and witness paths, without an identity header', async () => {
    const requests:LinkRequest[]=[]
    const channel=new MlsWitnessLink({request:async request=>{requests.push(request);return receipt()}},'persona-witness')
    const body=new Uint8Array([1,2,3])
    await channel.read(body);await channel.advance(body);body.fill(0)
    expect(requests).toEqual(['/vmls-witness/v1/read','/vmls-witness/v1/advance'].map(path=>({routeId:'persona-witness',method:'POST',path,authorization:'',body:new Uint8Array([1,2,3])})))
  })
  it('holds a timed-out advance and ignores a later successful response', async () => {
    vi.useFakeTimers()
    try{
      let finish!:(r:LinkResponse)=>void
      const channel=new MlsWitnessLink({request:()=>new Promise(resolve=>{finish=resolve})},'route',100)
      const answer=channel.advance(new Uint8Array([1]))
      await vi.advanceTimersByTimeAsync(100)
      expect(await answer).toEqual({type:'unavailable'})
      finish(receipt());await Promise.resolve()
      expect(await answer).toEqual({type:'unavailable'})
    }finally{vi.useRealTimers()}
  })
  it('holds transport errors and rejects oversized requests before dispatch', async () => {
    const request=vi.fn(async()=>{throw new Error('offline')})
    const channel=new MlsWitnessLink({request},'route')
    expect(await channel.read(new Uint8Array([1]))).toEqual({type:'unavailable'})
    await expect(channel.read(new Uint8Array(257))).rejects.toThrow('size')
    expect(request).toHaveBeenCalledTimes(1)
  })
})
