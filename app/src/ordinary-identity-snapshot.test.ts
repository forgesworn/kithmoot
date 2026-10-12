import { describe, expect, it } from 'vitest'
import { bytesToHex } from '@noble/hashes/utils'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { createDeviceCredential } from '../../src/credential.js'
import { localIdentity } from '../../src/identity.js'
import { OrdinaryStateHold } from './ordinary-state-codec.js'
import { validateOrdinaryIdentitySnapshot as validate } from './ordinary-identity-snapshot.js'
import { DEVICE_PREFIX, CREDENTIAL_PREFIX, OWN_CREDENTIAL_PREFIX, OWN_SEAL_PREFIX } from './device-store.js'

const key = (n: number) => { const value=new Uint8Array(32);value[31]=n;return value }
const account=key(1), device=key(2), seal=key(3), other=key(4)
const ROOM='a'.repeat(64), OTHER_ROOM='b'.repeat(64)
const participant=getPublicKey(account), devicePub=getPublicKey(device), sealPub=getPublicKey(seal)
async function snapshot(own=true) {
  const event=await createDeviceCredential({identity:localIdentity(account),devicePubkey:devicePub,roomId:ROOM,expiresAt:200,now:()=>100,...(own?{seal:sealPub}:{})})
  return new Map([[DEVICE_PREFIX+ROOM,JSON.stringify({sk:bytesToHex(device),at:100})],
    [(own?OWN_CREDENTIAL_PREFIX:CREDENTIAL_PREFIX)+ROOM,JSON.stringify(event)],...(own?[[OWN_SEAL_PREFIX+ROOM,JSON.stringify([bytesToHex(seal)])]] as [string,string][]:[])])
}
describe('whole ordinary identity snapshot validation',()=>{
  it('preserves primary bytes and signed room/device/seal binding without inferring current authority',async()=>{
    const records=await snapshot();records.set('kithmoot.participant',bytesToHex(account));const before=[...records]
    const result=validate(records,false)
    expect(result).toEqual({participant,secondary:false,rooms:[{roomId:ROOM,account:participant,scoped:false}]})
    expect([...records]).toEqual(before);expect(Object.isFrozen(result.rooms[0])).toBe(true)
  })
  it('classifies a secondary without minting or substituting a participant',async()=>{
    expect(validate(await snapshot(false),false)).toEqual({secondary:true,rooms:[{roomId:ROOM,account:participant,scoped:false}]})
  })
  it('does not assign an external signed room to the dormant visitor key',async()=>{
    const records=await snapshot();records.set('kithmoot.participant',bytesToHex(other))
    expect(validate(records,false).rooms[0]!.account).toBe(participant)
    expect(validate(records,false).participant).toBe(getPublicKey(other))
  })
  it('retains distinct verified accounts in distinct legacy rooms',async()=>{
    const records=await snapshot(false)
    const distinctDevice=key(5)
    const event=await createDeviceCredential({identity:localIdentity(other),devicePubkey:getPublicKey(distinctDevice),roomId:OTHER_ROOM,expiresAt:200,now:()=>100})
    records.set(DEVICE_PREFIX+OTHER_ROOM,JSON.stringify({sk:bytesToHex(distinctDevice),at:100}));records.set(CREDENTIAL_PREFIX+OTHER_ROOM,JSON.stringify(event))
    expect(validate(records,false).rooms.map(room=>room.account)).toEqual([participant,getPublicKey(other)])
  })
  it.each([false,true])('refuses a shared device in distinct rooms with different accounts=%s',async differentAccount=>{
    const records=await snapshot(false)
    const event=await createDeviceCredential({identity:localIdentity(differentAccount?other:account),devicePubkey:devicePub,roomId:OTHER_ROOM,expiresAt:200,now:()=>100})
    records.set(DEVICE_PREFIX+OTHER_ROOM,JSON.stringify({sk:bytesToHex(device),at:100}));records.set(CREDENTIAL_PREFIX+OTHER_ROOM,JSON.stringify(event))
    const before=[...records];expect(()=>validate(records,false)).toThrow(OrdinaryStateHold);expect([...records]).toEqual(before)
  })
  it.each([false,true])('refuses shared seal history in distinct rooms with different accounts=%s',async differentAccount=>{
    const records=await snapshot(),distinctDevice=key(5),distinctSeal=key(6)
    const event=await createDeviceCredential({identity:localIdentity(differentAccount?other:account),devicePubkey:getPublicKey(distinctDevice),roomId:OTHER_ROOM,expiresAt:200,now:()=>100,seal:getPublicKey(distinctSeal)})
    records.set(DEVICE_PREFIX+OTHER_ROOM,JSON.stringify({sk:bytesToHex(distinctDevice),at:100}));records.set(OWN_CREDENTIAL_PREFIX+OTHER_ROOM,JSON.stringify(event))
    // Even a rotated-out seal must not be silently shared between rooms.
    records.set(OWN_SEAL_PREFIX+OTHER_ROOM,JSON.stringify([bytesToHex(distinctSeal),bytesToHex(seal)]))
    expect(()=>validate(records,false)).toThrow(OrdinaryStateHold)
  })
  it.each([false,true])('scoped accounts sharing one room require distinct device keys, reuse=%s',reuse=>{
    const records=new Map<string,string>()
    for(const [identity,deviceKey] of [[account,device],[other,reuse?device:key(5)]] as const){
      const pub=getPublicKey(identity),prefix='kithmoot.account.'+pub+'.'
      records.set(prefix+DEVICE_PREFIX+ROOM,JSON.stringify({sk:bytesToHex(deviceKey),at:100}))
      records.set(prefix+'kithmoot.device-owner.'+ROOM,JSON.stringify({account:pub,roomId:ROOM}))
    }
    if(reuse)expect(()=>validate(records,true)).toThrow(OrdinaryStateHold)
    else expect(validate(records,true).rooms).toHaveLength(2)
  })
  it.each(['device','credential','seals','bare-device'] as const)('holds %s orphan topology instead of treating it as absence',async which=>{
    const records=await snapshot()
    if(which==='device')records.delete(DEVICE_PREFIX+ROOM)
    if(which==='credential')records.delete(OWN_CREDENTIAL_PREFIX+ROOM)
    if(which==='seals')records.delete(OWN_SEAL_PREFIX+ROOM)
    if(which==='bare-device'){records.delete(OWN_CREDENTIAL_PREFIX+ROOM);records.delete(OWN_SEAL_PREFIX+ROOM)}
    const before=[...records];expect(()=>validate(records,false)).toThrow(OrdinaryStateHold);expect([...records]).toEqual(before)
  })
  it.each(['kithmoot.participant','kithmoot.device','kithmoot.credential','kithmoot.device.not-a-room','kithmoot.account.bad.kithmoot.device.'+ROOM])('holds malformed or obsolete %s without rewriting it',name=>{
    const records=new Map([[name,'00'.repeat(32)]]);expect(()=>validate(records,false)).toThrow(OrdinaryStateHold)
    expect(records.get(name)).toBe('00'.repeat(32))
  })
  it.each(['signature','device','duplicate-device','duplicate-room','conflicting-account','zero-device','zero-seal','duplicate-seal','extra-device-field'] as const)('rejects %s corruption before permissive loaders run',async which=>{
    const records=await snapshot(),event=JSON.parse(records.get(OWN_CREDENTIAL_PREFIX+ROOM)!)
    if(which==='signature')event.sig='00'.repeat(64)
    if(which==='device')event.tags=event.tags.map((tag:string[])=>tag[0]==='device'?['device',getPublicKey(other)]:tag)
    if(which==='duplicate-device')event.tags.push(['device',devicePub])
    if(which==='duplicate-room')event.tags.push(['d',ROOM])
    if(['device','duplicate-device','duplicate-room'].includes(which))Object.assign(event,finalizeEvent({kind:event.kind,created_at:event.created_at,tags:event.tags,content:event.content},account))
    records.set(OWN_CREDENTIAL_PREFIX+ROOM,JSON.stringify(event))
    if(which==='conflicting-account')records.set(CREDENTIAL_PREFIX+ROOM,JSON.stringify(await createDeviceCredential({identity:localIdentity(other),devicePubkey:devicePub,roomId:ROOM,expiresAt:200,now:()=>100})))
    if(which==='zero-device')records.set(DEVICE_PREFIX+ROOM,JSON.stringify({sk:'00'.repeat(32),at:100}))
    if(which==='zero-seal')records.set(OWN_SEAL_PREFIX+ROOM,JSON.stringify(['00'.repeat(32)]))
    if(which==='duplicate-seal')records.set(OWN_SEAL_PREFIX+ROOM,JSON.stringify([bytesToHex(seal),bytesToHex(seal)]))
    if(which==='extra-device-field')records.set(DEVICE_PREFIX+ROOM,JSON.stringify({sk:bytesToHex(device),at:100,extra:1}))
    expect(()=>validate(records,false)).toThrow(OrdinaryStateHold)
  })
  it('admits exact scoped native first-use custody only after completed migration',()=>{
    const prefix='kithmoot.account.'+participant+'.',records=new Map([
      [prefix+DEVICE_PREFIX+ROOM,JSON.stringify({sk:bytesToHex(device),at:100})],
      [prefix+'kithmoot.device-owner.'+ROOM,JSON.stringify({account:participant,roomId:ROOM})],
    ])
    expect(()=>validate(records,false)).toThrow(OrdinaryStateHold)
    expect(validate(records,true).rooms).toEqual([{roomId:ROOM,account:participant,scoped:true}])
    records.delete(prefix+'kithmoot.device-owner.'+ROOM)
    expect(()=>validate(records,true)).toThrow(OrdinaryStateHold)
  })
  it('refuses scoped owner binding and credential account disagreement',async()=>{
    const prefix='kithmoot.account.'+getPublicKey(other)+'.',records=new Map([...await snapshot()].map(([name,value])=>[prefix+name,value]))
    records.set(prefix+'kithmoot.device-owner.'+ROOM,JSON.stringify({account:getPublicKey(other),roomId:ROOM}))
    expect(()=>validate(records,true)).toThrow(OrdinaryStateHold)
  })
  it('refuses coexistence of legacy and scoped device custody for one room',async()=>{
    const records=await snapshot(),prefix='kithmoot.account.'+participant+'.'
    records.set(prefix+DEVICE_PREFIX+ROOM,JSON.stringify({sk:bytesToHex(device),at:100}))
    records.set(prefix+'kithmoot.device-owner.'+ROOM,JSON.stringify({account:participant,roomId:ROOM}))
    expect(()=>validate(records,true)).toThrow(OrdinaryStateHold)
  })
})
